/**
 * Planned routes: the Routes screen (the saved ones), the planner screen
 * that lays one out, and picking one for a ride. A route is planned by
 * tapping points on a map, each leg between them routed along roads by
 * route-worker.js, or by importing a GPX file. Routes are saved in the
 * "routes" store (db.js) as they're edited; the one picked in ride setup is
 * drawn on the live map (`setLivePlanData` in live-map.js).
 *
 * A route looks like:
 *   {id, name, created, updated, profile: "bike"|"foot",
 *    source: "planned"|"gpx",                  // "gpx": an imported line, used as drawn
 *    waypoints: [[lng, lat]...],               // empty for a line used as drawn
 *    legs: [{coords, meters, routed}...],      // one per pair of waypoints
 *    coords: [[lng, lat]...], meters,          // the whole route, joined
 *    elevation: {key, distances, heights, climb, descent}}  // its profile, see below
 * In memory, a leg still being routed also carries `pending: true`.
 *
 * The elevation profile comes from the worker once every leg is routed, and
 * is saved with the route. `key` (see `elevationKey`) says which version of
 * the line it was measured on, so a stale one is measured again.
 */

import { PLAN_ROUTE_SOURCE, PLAN_SIMPLIFY_M } from "./constants.js";
import { state, el } from "./state.js";
import { putRoute, getRoute, getAllRoutes, deleteRoute, setPref } from "./db.js";
import { haversineMeters, formatDistance, formatElevation, formatElevationValue, escapeHtml } from "./format.js";
import { distanceUnitLabel } from "./map-visuals.js";
import { createVectorMap, lineData, setLivePlanData } from "./live-map.js";
import { navigateToScreen } from "./navigation.js";
import { startCountdownFlow } from "./ride-setup.js";
import { confirmWithModal, showMessage, showModal } from "./modal.js";
import { exportRouteGpx } from "./gpx.js";
import { renderProfileChart } from "./chart.js";
import { canFollowPoints } from "./ride-plan.js";

// Where the planner opens with no route and no GPS fix yet.
const FALLBACK_VIEW = { center: [-98.5, 39.8], zoom: 3 };
const PLAN_ZOOM = 14;
const NAME_SAVE_DELAY_MS = 400;
const ROUTE_COLOR = "#6d4ad8";
// Climb and descent ignore wiggles smaller than this, in meters, so terrain
// noise along a flat road doesn't add up to a hill.
const CLIMB_THRESHOLD_M = 3;
// A placed or dragged point snaps to the nearest usable way within about
// this many screen pixels (a fingertip's slop), kept between the meter
// limits so it neither snaps from across town when zoomed out nor misses the
// road it's beside when zoomed in. A snap that takes too long (downloading
// tiles on a slow connection) is given up, leaving the point where it was put.
const SNAP_REACH_PX = 40;
const SNAP_MIN_M = 20;
const SNAP_MAX_M = 400;
const SNAP_TIMEOUT_MS = 2000;

let worker = null;
let nextRequestId = 1;
const pendingRequests = new Map();
let markers = [];
// Earlier states of the route's waypoints and legs, for Undo, and the
// states undone since the last edit, for Redo.
let undoStack = [];
let redoStack = [];
// Edits run one after another: adding or moving a point waits for its snap,
// and a quick second tap mustn't overtake it.
let editQueue = Promise.resolve();
let nameSaveTimer = null;
// The routes offered by ride setup's picker.
let setupRoutes = [];
// The planner chart's pixel ↔ distance conversions, and the map dot that
// follows a finger along it.
let chartGeometry = null;
let chartDot = null;

// ---- Routes screen ----

/**
 * Opens the Routes screen and lists the saved routes. A route left with no
 * points when the planner closed is deleted rather than listed.
 * @param {"push"|"replace"|string} [mode] - Passed to `navigateToScreen`.
 */
export async function openRoutes(mode = "push") {
	navigateToScreen("routes", mode);
	const left = state.editingRoute;
	state.editingRoute = null;
	if (left && isEmpty(left)) await removeRoute(left);
	await renderRoutesList();
}

async function renderRoutesList() {
	const routes = await getAllRoutes();
	el.routesEmpty.hidden = routes.length > 0;
	el.routesList.innerHTML = "";
	for (const route of routes) {
		const li = document.createElement("li");
		li.className = "route-list-item";
		li.innerHTML = `
			<button class="session-row route-open">
				<span class="session-main">
					<span class="session-when">${escapeHtml(route.name || "Untitled route")}</span>
					<span class="session-sub">${escapeHtml(describeRoute(route))}</span>
				</span>
			</button>
			<button class="btn route-ride-btn"${route.coords.length >= 2 ? "" : " disabled"}>Ride</button>`;
		li.querySelector(".route-open").addEventListener("click", () => openPlanner(route.id));
		li.querySelector(".route-ride-btn").addEventListener("click", () => {
			state.nextRideRouteId = route.id;
			startCountdownFlow();
		});
		el.routesList.append(li);
	}
}

/**
 * A route's one-line description, e.g. "12.4 mi · 120 ft climb · 5 points".
 * @param {Object} route
 * @returns {string}
 */
export function describeRoute(route) {
	const parts = [`${formatDistance(route.meters, state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)}`];
	if (route.elevation?.key === elevationKey(route)) parts.push(`${formatElevation(route.elevation.climb, state.prefs.unit)} climb`);
	if (route.source === "gpx") {
		parts.push("imported, as drawn");
	} else {
		const count = route.waypoints.length;
		parts.push(`${count} point${count === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

// ---- Ride setup ----

/**
 * Fills ride setup's route picker with the saved routes, choosing None
 * unless the Routes screen's Ride button asked for one. The row hides when
 * there's nothing to pick.
 * @returns {Promise<void>}
 */
export async function populateSetupRoutes() {
	const wanted = state.nextRideRouteId;
	state.nextRideRouteId = null;
	setupRoutes = (await getAllRoutes()).filter((route) => route.coords.length >= 2);

	el.setupRouteSelect.innerHTML = '<option value="">None</option>';
	for (const route of setupRoutes) {
		const option = document.createElement("option");
		option.value = String(route.id);
		option.textContent = `${route.name || "Untitled route"} · ${formatDistance(route.meters, state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)}`;
		el.setupRouteSelect.append(option);
	}
	const chosen = setupRoutes.find((route) => route.id === wanted) ?? null;
	el.setupRouteSelect.value = chosen ? String(chosen.id) : "";
	el.setupRouteSelect.closest(".setting-row").hidden = !setupRoutes.length;
	setRideRoute(chosen);
}

/** Ride setup's route picker `change` handler. */
function handleSetupRouteChange() {
	const id = Number(el.setupRouteSelect.value);
	setRideRoute(setupRoutes.find((route) => route.id === id) ?? null);
}

/**
 * Makes `route` (or none) the ride's route, redraws it on the live map, and
 * offers the choice of following it as is or to each point when it has
 * points to follow.
 */
function setRideRoute(route) {
	state.rideRoute = route;
	setLivePlanData();
	el.setupRouteModeRow.hidden = !canFollowPoints(route);
	syncRouteModeToggle();
}

function syncRouteModeToggle() {
	el.setupRouteModeToggle
		.querySelectorAll("button")
		.forEach((btn) => btn.classList.toggle("active", btn.dataset.routeMode === state.prefs.rideRouteMode));
}

/** Ride setup's Follow toggle: remembered for the next ride too. */
async function handleRouteModeClick(event) {
	const btn = event.target.closest("button[data-route-mode]");
	if (!btn) return;
	state.prefs.rideRouteMode = btn.dataset.routeMode;
	syncRouteModeToggle();
	await setPref("rideRouteMode", state.prefs.rideRouteMode);
}

// ---- Planner ----

/**
 * Opens the planner on a saved route, or on a new one.
 * @param {number|null} [routeId]
 * @param {"push"|"replace"|string} [mode] - Passed to `navigateToScreen`.
 * @returns {Promise<void>}
 */
export async function openPlanner(routeId = null, mode = "push") {
	const saved = routeId != null ? await getRoute(routeId) : null;
	const route = saved ? { ...saved, autoNamed: false } : await newRoute();
	state.editingRoute = route;
	undoStack = [];
	redoStack = [];
	navigateToScreen("plan", mode, { routeId: route.id ?? null });
	el.planNameInput.value = route.name;
	// A route saved before profiles were measured gets one now.
	measureElevation(route);

	// The panel's contents set its height, which the map is fitted around.
	renderPlan();
	if (!state.planMap) {
		createPlanMap();
	} else {
		// The map was sized while its screen was hidden.
		state.planMap.resize();
		fitRoute();
	}
	renderPlan();
}

/** A new, unsaved route, named after how many there are already. */
async function newRoute() {
	const count = (await getAllRoutes()).length;
	const now = new Date().toISOString();
	return {
		name: `Route ${count + 1}`,
		autoNamed: true,
		created: now,
		updated: now,
		// Every new route is routed for a bike; routes planned for walking in
		// earlier versions keep their profile.
		profile: "bike",
		source: "planned",
		waypoints: [],
		legs: [],
		coords: [],
		meters: 0,
	};
}

/** Wires up the Routes screen, the planner, and ride setup's route picker. Called once from `wireEvents`. */
export function wirePlanner() {
	el.routesBackBtn.addEventListener("click", () => history.back());
	el.newRouteBtn.addEventListener("click", () => openPlanner());
	el.setupRouteSelect.addEventListener("change", handleSetupRouteChange);
	el.setupRouteModeToggle.addEventListener("click", handleRouteModeClick);

	el.planBackBtn.addEventListener("click", () => history.back());
	el.planDoneBtn.addEventListener("click", () => history.back());
	el.planDeleteBtn.addEventListener("click", deleteEditingRoute);
	el.planUndoBtn.addEventListener("click", () => queueEdit(undo));
	el.planRedoBtn.addEventListener("click", () => queueEdit(redo));
	el.planImportBtn.addEventListener("click", () => el.planGpxInput.click());
	el.planGpxInput.addEventListener("change", importPlanGpx);
	el.planExportBtn.addEventListener("click", () => exportRouteGpx(state.editingRoute));
	el.planNameInput.addEventListener("input", () => {
		const route = state.editingRoute;
		if (!route) return;
		route.name = el.planNameInput.value.trim();
		route.autoNamed = false;
		clearTimeout(nameSaveTimer);
		nameSaveTimer = setTimeout(() => saveRoute(route), NAME_SAVE_DELAY_MS);
	});
	el.planChart.addEventListener("pointerdown", handleChartPointer);
	el.planChart.addEventListener("pointermove", handleChartPointer);
	for (const type of ["pointerup", "pointercancel", "pointerleave"]) el.planChart.addEventListener(type, clearChartPointer);
	// The chart is drawn to its canvas's size.
	window.addEventListener("resize", () => {
		if (state.currentScreen === "plan") renderProfile(state.editingRoute);
	});
}

/** The planner's Delete button: removes the route (after confirming) and goes back to the list. */
async function deleteEditingRoute() {
	const route = state.editingRoute;
	if (!route) return;
	if (!isEmpty(route)) {
		const confirmed = await confirmWithModal({
			title: "Delete Route?",
			message: `"${route.name || "Untitled route"}" will be deleted.`,
			confirmText: "Delete",
			cancelText: "Cancel",
			danger: true,
		});
		if (!confirmed) return;
	}
	await removeRoute(route);
	state.editingRoute = null;
	history.back();
}

function isEmpty(route) {
	return !route.waypoints.length && !route.legs.length;
}

/** The route's waypoints and legs as they are now. */
function snapshot(route) {
	return { waypoints: [...route.waypoints], legs: [...route.legs], source: route.source };
}

/** Saves the route as it is now, for Undo, before an edit. A new edit ends what Redo can bring back. */
function remember() {
	undoStack.push(snapshot(state.editingRoute));
	redoStack = [];
}

function undo() {
	const route = state.editingRoute;
	const previous = undoStack.pop();
	if (!previous || !route) return;
	redoStack.push(snapshot(route));
	Object.assign(route, previous);
	routeChanged(route);
}

function redo() {
	const route = state.editingRoute;
	const next = redoStack.pop();
	if (!next || !route) return;
	undoStack.push(snapshot(route));
	Object.assign(route, next);
	routeChanged(route);
}

/** Runs an edit after any still in progress. */
function queueEdit(edit) {
	editQueue = editQueue.then(edit).catch((error) => console.warn("Editing the route failed", error));
	return editQueue;
}

/**
 * The nearest point on a road, path or cycleway the route can use, within
 * reach of where a point was put (see SNAP_REACH_PX), or the point itself
 * when there's none in reach or the snap can't be had in time.
 */
async function snapToWay(lngLat, route) {
	const zoom = state.planMap?.getZoom() ?? PLAN_ZOOM;
	const metersPerPixel = (40075016.686 * Math.cos((lngLat[1] * Math.PI) / 180)) / (512 * 2 ** zoom);
	const radius = Math.min(SNAP_MAX_M, Math.max(SNAP_MIN_M, SNAP_REACH_PX * metersPerPixel));
	const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SNAP_TIMEOUT_MS));
	try {
		const answer = await Promise.race([request({ type: "snap", point: lngLat, profile: route.profile ?? "bike", radius }), timeout]);
		return answer?.snapped ?? lngLat;
	} catch (error) {
		console.warn("Snapping a point failed", error);
		return lngLat;
	}
}

/** Adds a waypoint at the end, snapped to a way and routed on from the last one. */
function addWaypoint(lngLat) {
	queueEdit(async () => {
		const route = state.editingRoute;
		if (!route || route.source === "gpx") return;
		const snapped = await snapToWay(lngLat, route);
		if (route !== state.editingRoute) return;
		remember();
		route.waypoints.push(snapped);
		if (route.waypoints.length > 1) route.legs.push(routeLeg(route, route.waypoints.length - 2));
		routeChanged(route);
	});
}

/** Moves a waypoint, snapped to a way, re-routing the legs either side of it. */
function moveWaypoint(index, lngLat) {
	queueEdit(async () => {
		const route = state.editingRoute;
		if (!route) return;
		const snapped = await snapToWay(lngLat, route);
		if (route !== state.editingRoute || index >= route.waypoints.length) return;
		remember();
		route.waypoints[index] = snapped;
		if (index > 0) route.legs[index - 1] = routeLeg(route, index - 1);
		if (index < route.legs.length) route.legs[index] = routeLeg(route, index);
		routeChanged(route);
	});
}

/** Removes a waypoint, joining its neighbours with a new leg. */
function removeWaypoint(index) {
	queueEdit(() => removeWaypointNow(index));
}

function removeWaypointNow(index) {
	const route = state.editingRoute;
	if (!route || index >= route.waypoints.length) return;
	remember();
	route.waypoints.splice(index, 1);
	if (index === 0) {
		route.legs.shift();
	} else if (index === route.waypoints.length) {
		route.legs.pop();
	} else {
		route.legs.splice(index - 1, 2, routeLeg(route, index - 1));
	}
	routeChanged(route);
}

/**
 * Starts routing the leg from waypoint `index` to the next, returning a
 * placeholder straight leg that is filled in when the worker answers (and
 * saved then, even if the planner has since moved on to another route).
 */
function routeLeg(route, index) {
	const from = route.waypoints[index];
	const to = route.waypoints[index + 1];
	const leg = { coords: [from, to], meters: straightMeters(from, to), routed: false, pending: true };

	request({ type: "leg", from, to, profile: route.profile })
		.then((answer) => {
			if (answer.route) {
				leg.coords = answer.route.coords;
				leg.meters = answer.route.meters;
				leg.routed = true;
			}
		})
		.catch((error) => console.warn("Planning a leg failed", error))
		.finally(() => {
			leg.pending = false;
			if (route.legs.includes(leg)) routeChanged(route);
		});
	return leg;
}

function straightMeters([lngA, latA], [lngB, latB]) {
	return haversineMeters(latA, lngA, latB, lngB);
}

/** Recomputes a route's joined line and length, saves it, and redraws it if it's open. */
function routeChanged(route) {
	const coords = [];
	for (const leg of route.legs) coords.push(...(coords.length ? leg.coords.slice(1) : leg.coords));
	route.coords = coords.length ? coords : [...route.waypoints];
	route.meters = route.legs.reduce((sum, leg) => sum + leg.meters, 0);
	saveRoute(route);
	if (route === state.editingRoute) renderPlan();
	measureElevation(route);
}

/**
 * Which version of a route's line an elevation profile belongs to. Any edit
 * that moves the line changes its length or its point count.
 */
function elevationKey(route) {
	return `${route.coords.length}:${Math.round(route.meters)}`;
}

/**
 * Asks the worker for the route's elevation profile, once every leg has
 * been routed and unless the saved one still fits the line. Saved with the
 * route when it arrives, if the line hasn't changed again by then.
 */
function measureElevation(route) {
	if (route.coords.length < 2 || route.legs.some((leg) => leg.pending)) return;
	const key = elevationKey(route);
	if (route.elevation?.key === key || route.elevationPending === key) return;
	route.elevationPending = key;
	route.elevationFailed = false;
	if (route === state.editingRoute) renderPlan();

	request({ type: "elevation", coords: route.coords })
		.then(({ profile }) => {
			if (elevationKey(route) !== key) return;
			const measured = summarizeProfile(profile);
			if (measured) {
				route.elevation = { key, ...measured };
				saveRoute(route);
			} else {
				route.elevationFailed = true;
			}
		})
		.catch((error) => {
			console.warn("Measuring elevation failed", error);
			route.elevationFailed = true;
		})
		.finally(() => {
			if (route.elevationPending === key) route.elevationPending = null;
			if (route === state.editingRoute) renderPlan();
		});
}

/**
 * Keeps a profile's measured samples (dropping any whose terrain tile was
 * missing) and totals its climb and descent, counting only rises and falls
 * of at least CLIMB_THRESHOLD_M.
 *
 * @returns {{distances: number[], heights: number[], climb: number, descent: number}|null}
 *   Null when fewer than two samples could be measured.
 */
function summarizeProfile({ distances, heights }) {
	const kept = distances.map((distance, i) => [distance, heights[i]]).filter(([, height]) => height !== null);
	if (kept.length < 2) return null;

	let climb = 0;
	let descent = 0;
	let anchor = kept[0][1];
	for (const [, height] of kept) {
		if (height - anchor >= CLIMB_THRESHOLD_M) {
			climb += height - anchor;
			anchor = height;
		} else if (anchor - height >= CLIMB_THRESHOLD_M) {
			descent += anchor - height;
			anchor = height;
		}
	}
	return {
		distances: kept.map(([distance]) => Math.round(distance)),
		heights: kept.map(([, height]) => Math.round(height * 10) / 10),
		climb,
		descent,
	};
}

/**
 * Saves a route, one save at a time per route so the first one's new id is
 * known to the ones after it. A route that has never had a point isn't
 * saved at all.
 */
function saveRoute(route) {
	if (route.id == null && isEmpty(route)) return;
	route.updated = new Date().toISOString();
	const record = {
		name: route.name || "Untitled route",
		created: route.created,
		updated: route.updated,
		profile: route.profile,
		source: route.source,
		waypoints: route.waypoints,
		legs: route.legs.map(({ coords, meters, routed }) => ({ coords, meters, routed })),
		coords: route.coords,
		meters: route.meters,
		elevation: route.elevation ?? null,
	};
	route.saving = (route.saving ?? Promise.resolve())
		.then(async () => {
			if (route.deleted) return;
			route.id = await putRoute(route.id != null ? { ...record, id: route.id } : record);
			// The planner's history entry can now reopen this route.
			if (route === state.editingRoute && state.currentScreen === "plan") {
				history.replaceState({ screen: "plan", routeId: route.id }, "");
			}
		})
		.catch((error) => console.warn("Saving the route failed", error));
}

/** Deletes a route from storage, once any save of it in flight has landed. */
async function removeRoute(route) {
	route.deleted = true;
	await route.saving;
	if (route.id != null) await deleteRoute(route.id);
}

// ---- Worker ----

/** Sends one request to the routing worker (started on first use). */
function request(message) {
	if (!worker) {
		worker = new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
		worker.addEventListener("message", (event) => {
			const pending = pendingRequests.get(event.data.id);
			if (!pending) return;
			pendingRequests.delete(event.data.id);
			if (event.data.error) pending.reject(new Error(event.data.error));
			else pending.resolve(event.data);
		});
		worker.addEventListener("error", (event) => {
			console.warn("Planning worker failed", event.message || event);
			for (const pending of pendingRequests.values()) pending.reject(new Error("worker failed"));
			pendingRequests.clear();
			worker = null;
		});
	}
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		pendingRequests.set(id, { resolve, reject });
		worker.postMessage({ id, ...message });
	});
}

// ---- GPX import ----

/**
 * The planner's GPX file input handler. Asks whether to use the file's
 * route as drawn, or as points to route between: the file's own route
 * points or waypoints when it has them, or else its track simplified to
 * the points where it turns. Using it as drawn also downloads the tiles it
 * passes through, for riding offline.
 */
async function importPlanGpx(event) {
	const file = event.target.files[0];
	el.planGpxInput.value = "";
	const route = state.editingRoute;
	if (!file || !route) return;

	let parsed;
	try {
		parsed = parsePlanGpx(await file.text());
	} catch (error) {
		await showMessage("Import Error", `Couldn't use this GPX file: ${error.message}`);
		return;
	}

	const line = parsed.track ?? parsed.points;
	const points = parsed.points ?? simplifyLine(parsed.track, PLAN_SIMPLIFY_M);
	const from = parsed.points ? "its" : "the turns in its track, giving";
	const choice = await showModal({
		title: "Import GPX",
		message:
			`${parsed.name ? `"${parsed.name}" is` : "This route is"} ${formatDistance(lineMeters(line), state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)} long. How should it be used?` +
			(isEmpty(route) ? "" : " This replaces the route planned here."),
		listItems: [
			choiceButton("Use as drawn", `Follow the file's ${parsed.track ? "track" : "points"} exactly.`),
			choiceButton("Route between points", `Find roads between ${from} ${points.length} points. They can be moved or removed after.`),
		],
		hideConfirm: true,
		cancelText: "Cancel",
	});
	if (choice !== "0" && choice !== "1") return;

	remember();
	if (route.autoNamed && parsed.name) {
		route.name = parsed.name;
		el.planNameInput.value = parsed.name;
	}
	if (choice === "0") {
		route.source = "gpx";
		route.waypoints = [];
		route.legs = [{ coords: line, meters: lineMeters(line), routed: true }];
		request({ type: "prefetch", coords: line }).catch((error) => console.warn("Saving the route's map failed", error));
	} else {
		route.source = "planned";
		route.waypoints = points;
		route.legs = [];
		for (let i = 0; i + 1 < points.length; i++) route.legs.push(routeLeg(route, i));
	}
	routeChanged(route);
	fitRoute();
}

/** A button for the import choice modal, styled like a list row. */
function choiceButton(title, detail) {
	const button = document.createElement("button");
	button.className = "session-row";
	button.innerHTML = `<span class="session-main"><span class="session-when">${escapeHtml(title)}</span><span class="session-sub">${escapeHtml(detail)}</span></span>`;
	return button;
}

/**
 * Reads a GPX file's track and its route points (or, lacking those, its
 * waypoints, in file order). At least one of them has two or more points.
 *
 * @param {string} text
 * @returns {{name: string, track: Array<[number, number]>|null, points: Array<[number, number]>|null}}
 * @throws {Error} When it isn't GPX or has nothing to follow.
 */
function parsePlanGpx(text) {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	if (doc.querySelector("parsererror")) throw new Error("it isn't valid GPX.");

	const read = (tag) => {
		const found = Array.from(doc.getElementsByTagName(tag))
			.map((node) => [parseFloat(node.getAttribute("lon")), parseFloat(node.getAttribute("lat"))])
			.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
		return found.length >= 2 ? found : null;
	};
	const name = (doc.querySelector("trk > name, rte > name, metadata > name")?.textContent ?? "").trim();
	const track = read("trkpt");
	const points = read("rtept") ?? read("wpt");
	if (!track && !points) throw new Error("it has no track, route or waypoints to follow.");
	return { name, track, points };
}

/**
 * Simplifies a line (Douglas–Peucker) to the points it can't do without:
 * every point dropped lies within `tolerance` meters of the simplified line.
 *
 * @param {Array<[number, number]>} coords
 * @param {number} tolerance - Meters.
 * @returns {Array<[number, number]>}
 */
function simplifyLine(coords, tolerance) {
	// A flat local projection, in meters; fine over a ride's extent.
	const cosLat = Math.cos((coords[0][1] * Math.PI) / 180);
	const xy = coords.map(([lng, lat]) => [lng * 111320 * cosLat, lat * 110540]);
	const keep = new Uint8Array(coords.length);
	keep[0] = keep[coords.length - 1] = 1;

	const stack = [[0, coords.length - 1]];
	while (stack.length) {
		const [first, last] = stack.pop();
		const [ax, ay] = xy[first];
		const dx = xy[last][0] - ax;
		const dy = xy[last][1] - ay;
		const lengthSq = dx * dx + dy * dy;
		let farthest = -1;
		let farthestDistance = tolerance;
		for (let i = first + 1; i < last; i++) {
			const t = lengthSq ? Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / lengthSq)) : 0;
			const distance = Math.hypot(xy[i][0] - (ax + dx * t), xy[i][1] - (ay + dy * t));
			if (distance > farthestDistance) {
				farthest = i;
				farthestDistance = distance;
			}
		}
		if (farthest >= 0) {
			keep[farthest] = 1;
			stack.push([first, farthest], [farthest, last]);
		}
	}
	return coords.filter((_, i) => keep[i]);
}

function lineMeters(coords) {
	let meters = 0;
	for (let i = 1; i < coords.length; i++) meters += straightMeters(coords[i - 1], coords[i]);
	return meters;
}

// ---- Map ----

function createPlanMap() {
	const coords = state.editingRoute?.coords;
	const bounds = coords?.length >= 2 ? boundsOf(coords) : null;
	const view = bounds ? { bounds, fitBoundsOptions: { padding: planPadding(), maxZoom: 16 } } : FALLBACK_VIEW;
	const map = createVectorMap({ container: "planMap", ...view }, addPlanLayers);
	state.planMap = map;

	map.on("click", (event) => {
		// A tap on a waypoint is that marker's own, not a new waypoint.
		if (event.originalEvent?.target?.closest?.(".plan-waypoint")) return;
		addWaypoint([event.lngLat.lng, event.lngLat.lat]);
	});

	if (!bounds) centerOnRider();
}

/** Moves the planner to the rider's location, unless a route has been drawn by then. */
function centerOnRider() {
	navigator.geolocation.getCurrentPosition(
		(position) => {
			if (state.editingRoute?.coords?.length >= 2) return;
			state.planMap.jumpTo({ center: [position.coords.longitude, position.coords.latitude], zoom: PLAN_ZOOM });
		},
		() => {},
		{ enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 10000 },
	);
}

/** Keeps the route clear of the planner's top bar and bottom panel. */
function planPadding() {
	return {
		top: el.planTopBar.offsetHeight + 30,
		bottom: el.planBottomPanel.offsetHeight + 30,
		left: 40,
		right: 40,
	};
}

/** Fits the planner map to the open route, or finds the rider for a new one. */
function fitRoute() {
	const coords = state.editingRoute?.coords;
	if (!state.planMap) return;
	if (coords?.length >= 2) {
		state.planMap.fitBounds(boundsOf(coords), { padding: planPadding(), maxZoom: 16, duration: 0 });
	} else if (!coords?.length) {
		centerOnRider();
	}
}

function boundsOf(coords) {
	const lngs = coords.map((c) => c[0]);
	const lats = coords.map((c) => c[1]);
	return [
		[Math.min(...lngs), Math.min(...lats)],
		[Math.max(...lngs), Math.max(...lats)],
	];
}

/**
 * The planner map's route layers: a pale casing, then the legs, solid where
 * they follow roads and dashed where they couldn't (or haven't yet). Re-run
 * after every style swap by `createVectorMap`.
 */
function addPlanLayers(map) {
	map.addSource(PLAN_ROUTE_SOURCE, { type: "geojson", data: planFeatures() });
	const round = { "line-cap": "round", "line-join": "round" };
	map.addLayer({
		id: "plan-route-casing",
		type: "line",
		source: PLAN_ROUTE_SOURCE,
		layout: round,
		paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
	});
	map.addLayer({
		id: "plan-route",
		type: "line",
		source: PLAN_ROUTE_SOURCE,
		filter: ["==", ["get", "routed"], true],
		layout: round,
		paint: { "line-color": "#6d4ad8", "line-width": 5 },
	});
	map.addLayer({
		id: "plan-route-unrouted",
		type: "line",
		source: PLAN_ROUTE_SOURCE,
		filter: ["!=", ["get", "routed"], true],
		layout: round,
		paint: { "line-color": "#6d4ad8", "line-width": 4, "line-dasharray": [1, 1.5], "line-opacity": 0.8 },
	});
}

/** One feature per leg, flagged by whether it follows roads. */
function planFeatures() {
	const legs = state.editingRoute?.legs ?? [];
	return {
		type: "FeatureCollection",
		features: legs.map((leg) => ({
			...lineData(leg.coords),
			properties: { routed: leg.routed && !leg.pending },
		})),
	};
}

/** Redraws the planner: route line, waypoint markers, and the panel's text and buttons. */
function renderPlan() {
	const route = state.editingRoute;
	const map = state.planMap;
	map?.getSource(PLAN_ROUTE_SOURCE)?.setData(planFeatures());

	for (const marker of markers) marker.remove();
	markers = [];
	if (map && route) {
		if (route.source === "gpx") {
			const coords = route.coords;
			markers.push(createWaypointMarker(map, coords[0], "S", -1), createWaypointMarker(map, coords[coords.length - 1], "F", -1));
		} else {
			route.waypoints.forEach((lngLat, index) => markers.push(createWaypointMarker(map, lngLat, String(index + 1), index)));
		}
	}

	const hasRoute = route?.coords?.length >= 2;
	const pending = route?.legs.some((leg) => leg.pending);
	const unrouted = route?.legs.some((leg) => !leg.routed && !leg.pending);
	el.planStatus.textContent = pending
		? "Finding roads…"
		: unrouted
			? "Dashed legs couldn't follow roads, so they're straight lines."
			: route?.source === "gpx"
				? "Imported as drawn, so it can't be edited here."
				: hasRoute
					? "Tap to add a point, drag one to move it, tap one to remove it."
					: "Tap the map to add your first point.";
	renderProfile(route);
	el.planUndoBtn.disabled = !undoStack.length;
	el.planRedoBtn.disabled = !redoStack.length;
	// Not while legs are still straight placeholders.
	el.planExportBtn.disabled = !hasRoute || pending;
}

/**
 * Fills in the planner's distance, climb and descent, and draws the
 * elevation chart (or says why there isn't one yet).
 */
function renderProfile(route) {
	const hasRoute = route?.coords?.length >= 2;
	el.planProfile.hidden = !hasRoute;
	clearChartPointer();
	if (!hasRoute) return;

	const unit = state.prefs.unit;
	el.planDistance.innerHTML = `${formatDistance(route.meters, unit)} <span class="unit">${distanceUnitLabel(unit)}</span>`;
	const profile = route.elevation?.key === elevationKey(route) ? route.elevation : null;
	const heightUnit = unit === "imperial" ? "ft" : "m";
	for (const [element, meters] of [
		[el.planClimb, profile?.climb],
		[el.planDescent, profile?.descent],
	]) {
		element.innerHTML = profile ? `${formatElevationValue(meters, unit)} <span class="unit">${heightUnit}</span>` : "–";
	}

	const points = profile ? profile.distances.map((distance, i) => ({ distance, elevation: profile.heights[i] })) : [];
	const message = route.legs.some((leg) => leg.pending) || route.elevationPending
		? "Measuring elevation…"
		: "Elevation unavailable offline";
	chartGeometry = renderProfileChart(el.planChart, points, ROUTE_COLOR, message);
}

/**
 * Follows a finger (or cursor) along the planner's chart: a dot on the map
 * at that distance along the route, and a readout of the distance and
 * height there over the chart.
 */
function handleChartPointer(event) {
	const route = state.editingRoute;
	const profile = route?.elevation;
	if (!chartGeometry || !profile || (event.type === "pointermove" && event.pointerType !== "mouse" && !event.buttons)) return;
	const rect = el.planChart.getBoundingClientRect();
	const distance = chartGeometry.distanceAt(event.clientX - rect.left);

	// The nearest measured sample, for its height.
	let sample = 0;
	while (sample + 1 < profile.distances.length && profile.distances[sample + 1] <= distance) sample++;
	if (sample + 1 < profile.distances.length && profile.distances[sample + 1] - distance < distance - profile.distances[sample]) sample++;

	const unit = state.prefs.unit;
	el.planChartReadout.textContent = `${formatDistance(distance, unit)} ${distanceUnitLabel(unit)} · ${formatElevation(profile.heights[sample], unit)}`;
	el.planChartReadout.style.left = `${Math.min(Math.max(chartGeometry.xAt(distance), 50), rect.width - 50)}px`;
	el.planChartReadout.hidden = false;

	const lngLat = pointAlong(route.coords, distance);
	if (!chartDot) {
		const element = document.createElement("div");
		element.className = "plan-chart-dot";
		chartDot = new maplibregl.Marker({ element });
	}
	chartDot.setLngLat(lngLat).addTo(state.planMap);
}

function clearChartPointer() {
	el.planChartReadout.hidden = true;
	chartDot?.remove();
}

/** The point `meters` along a line. */
function pointAlong(coords, meters) {
	let covered = 0;
	for (let i = 1; i < coords.length; i++) {
		const step = straightMeters(coords[i - 1], coords[i]);
		if (covered + step >= meters) {
			const t = step ? (meters - covered) / step : 0;
			return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
		}
		covered += step;
	}
	return coords[coords.length - 1];
}

/**
 * A numbered waypoint marker. Planned waypoints can be dragged to move them
 * or tapped to remove them; `index` -1 marks an imported line's fixed ends.
 */
function createWaypointMarker(map, lngLat, label, index) {
	const element = document.createElement("div");
	element.className = "plan-waypoint";
	element.innerHTML = `<span>${escapeHtml(label)}</span>`;
	const editable = index >= 0;
	const marker = new maplibregl.Marker({ element, draggable: editable }).setLngLat(lngLat).addTo(map);
	if (!editable) return marker;

	let dragged = false;
	marker.on("dragstart", () => {
		dragged = true;
	});
	marker.on("dragend", () => {
		const { lng, lat } = marker.getLngLat();
		moveWaypoint(index, [lng, lat]);
	});
	element.addEventListener("click", (event) => {
		event.stopPropagation();
		if (dragged) {
			dragged = false;
			return;
		}
		removeWaypoint(index);
	});
	return marker;
}
