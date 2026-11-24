/**
 * The planner's loop maker: the Loop button opens a panel in place of the
 * planner's own, where the rider picks a length and which way to head out.
 * Three loops are then made by the routing worker ("loop" in
 * route-worker.js), each heading a different way, and drawn on the map to
 * pick from. The one picked becomes the route being planned, its turning
 * points ordinary waypoints, so it can be edited, reversed, shared and
 * ridden like any other.
 *
 * The planner (route-plan.js) hands in what this needs through
 * `wireLoopPlanner`, so the two don't import each other.
 */

import { state, el } from "./state.js";
import { formatElevation, haversineMeters } from "./format.js";
import { distanceUnitLabel } from "./map-visuals.js";

const LOOP_SOURCE = "plan-loop";
const LOOP_COLOR = "#6d4ad8";
const OTHER_LOOP_COLOR = "#8f84b8";
// Lengths offered, in the rider's unit, and how far the stepper moves.
const LENGTH_CHOICES = { metric: [10, 25, 40, 60], imperial: [5, 15, 25, 40] };
const LENGTH_STEP = 5;
const LENGTH_MIN = 5;
// A loop's tiles grow with its size, so loops are capped at about this long.
const MAX_LOOP_M = 80000;
const METERS_PER = { metric: 1000, imperial: 1609.344 };
// Heading out a given way, the three loops lean this many degrees either side of it.
const HEADING_SPREAD_DEG = 35;
const HEADINGS = [
	["any", "Any", null],
	["n", "N", 0],
	["e", "E", 90],
	["s", "S", 180],
	["w", "W", 270],
];
// A loop that rides more than this share of itself twice is flagged.
const RETRACED_WARN = 0.1;
// Where the rider is, if the device knows within this long.
const POSITION_TIMEOUT_MS = 8000;
const POSITION_MAX_AGE_MS = 60000;
// The dashed guide circle is drawn with this many points.
const GUIDE_STEPS = 64;
// Must match LOOP_WINDING in route-worker.js: the guide circle shows roughly
// where the loop will run.
const LOOP_WINDING = 1.3;

let deps = null;
const loop = {
	open: false,
	// "setup", "working", "options" or "failed".
	stage: "setup",
	length: null,
	heading: "any",
	start: null,
	startLabel: "",
	options: [],
	picked: 0,
	done: 0,
	// Bumped whenever a run of loop requests should be forgotten (cancelled, closed, run again).
	run: 0,
};

/**
 * Wires the Loop button and panel. Called once from `wirePlanner`.
 *
 * @param {Object} planner
 * @param {(message: Object) => Promise<Object>} planner.request - Sends a request to the routing worker.
 * @param {(profile: Object) => {climb: number}|null} planner.summarizeProfile
 * @param {(coords: Array<[number, number]>) => void} planner.fit - Fits the planner map to these points.
 * @param {(loop: {waypoints, legs, meters}, name: string) => void} planner.apply - Makes a loop the route being planned.
 */
export function wireLoopPlanner(planner) {
	deps = planner;
	el.planLoopBtn.addEventListener("click", openLoopPanel);
	el.loopCloseBtn.addEventListener("click", closeLoopPanel);
	el.loopBody.addEventListener("click", handleClick);
}

/** Whether the loop panel is open, so taps on the map don't add points meanwhile. */
export function isLoopPanelOpen() {
	return loop.open;
}

/** Adds the loop previews' source and layers to the planner map. Called with the planner's own layers. */
export function addLoopLayers(map) {
	map.addSource(LOOP_SOURCE, { type: "geojson", data: loopFeatures() });
	const round = { "line-cap": "round", "line-join": "round" };
	map.addLayer({
		id: "plan-loop-guide",
		type: "line",
		source: LOOP_SOURCE,
		filter: ["==", ["get", "kind"], "guide"],
		layout: round,
		paint: { "line-color": LOOP_COLOR, "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.7 },
	});
	map.addLayer({
		id: "plan-loop-casing",
		type: "line",
		source: LOOP_SOURCE,
		filter: ["==", ["get", "kind"], "option"],
		layout: { ...round, "line-sort-key": ["case", ["get", "picked"], 1, 0] },
		paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "picked"], 10, 7], "line-opacity": 0.9 },
	});
	map.addLayer({
		id: "plan-loop-line",
		type: "line",
		source: LOOP_SOURCE,
		filter: ["==", ["get", "kind"], "option"],
		layout: { ...round, "line-sort-key": ["case", ["get", "picked"], 1, 0] },
		paint: {
			"line-color": ["case", ["get", "picked"], LOOP_COLOR, OTHER_LOOP_COLOR],
			"line-width": ["case", ["get", "picked"], 6, 4],
			"line-opacity": ["case", ["get", "picked"], 1, 0.55],
		},
	});
	map.addLayer({
		id: "plan-loop-start",
		type: "circle",
		source: LOOP_SOURCE,
		filter: ["==", ["get", "kind"], "start"],
		paint: { "circle-radius": 7, "circle-color": "#0b5d3b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
	});
}

/** Closes the panel without changing the route (when the planner opens on another route, say). */
export function closeLoopPanel() {
	if (!loop.open) return;
	loop.open = false;
	loop.run++;
	el.loopPanel.hidden = true;
	el.screens.plan.classList.remove("looping");
	setPlanLinesVisible(true);
	drawLoops();
}

async function openLoopPanel() {
	const route = state.editingRoute;
	if (!route || route.preview || loop.open) return;
	loop.open = true;
	loop.stage = "setup";
	loop.options = [];
	loop.length ??= LENGTH_CHOICES[unit()][1];
	el.loopPanel.hidden = false;
	el.screens.plan.classList.add("looping");
	setPlanLinesVisible(false);
	renderPanel();

	const run = ++loop.run;
	const { start, label } = await findStart(route);
	if (run !== loop.run) return;
	loop.start = start;
	loop.startLabel = label;
	renderPanel();
	showGuide();
}

/**
 * Where the loop starts and finishes: the route's first point when it has
 * one, else the rider (if the device can tell in time), else the middle of the map.
 */
async function findStart(route) {
	if (route.waypoints.length) return { start: route.waypoints[0], label: "the route’s first point" };
	const position = await new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(null);
		navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
			enableHighAccuracy: false,
			maximumAge: POSITION_MAX_AGE_MS,
			timeout: POSITION_TIMEOUT_MS,
		});
	});
	if (position) return { start: [position.coords.longitude, position.coords.latitude], label: "your location" };
	const center = state.planMap?.getCenter();
	return { start: center ? [center.lng, center.lat] : [-98.5, 39.8], label: "the middle of the map" };
}

function unit() {
	return state.prefs.unit === "imperial" ? "imperial" : "metric";
}

function targetMeters() {
	return Math.min(MAX_LOOP_M, loop.length * METERS_PER[unit()]);
}

function maxLength() {
	return Math.floor(MAX_LOOP_M / METERS_PER[unit()] / LENGTH_STEP) * LENGTH_STEP;
}

function headingBearing() {
	return HEADINGS.find(([id]) => id === loop.heading)?.[2] ?? null;
}

/** The panel's buttons, by their data-action. */
function handleClick(event) {
	const button = event.target.closest("[data-action]");
	if (!button || button.disabled) return;
	const { action, value } = button.dataset;
	if (action === "length") loop.length = Number(value);
	else if (action === "step") loop.length = Math.min(maxLength(), Math.max(LENGTH_MIN, loop.length + Number(value) * LENGTH_STEP));
	else if (action === "heading") loop.heading = value;
	else if (action === "make") return makeLoops();
	else if (action === "cancel" || action === "settings") {
		loop.run++;
		loop.stage = "setup";
		loop.options = [];
		renderPanel();
		showGuide();
		return;
	} else if (action === "pick") {
		loop.picked = Number(value);
		renderPanel();
		drawLoops();
		return;
	} else if (action === "use") return useLoop();
	else if (action === "shorter") {
		loop.length = Math.max(LENGTH_MIN, Number(value));
		return makeLoops();
	} else return;
	renderPanel();
	showGuide();
}

/**
 * Asks the worker for three loops, one after another so the panel can count
 * them off, then ranks them: nearest the length asked for, and riding the
 * fewest roads twice, first.
 */
async function makeLoops() {
	if (!loop.start) return;
	const run = ++loop.run;
	const meters = targetMeters();
	loop.stage = "working";
	loop.options = [];
	loop.done = 0;
	renderPanel();

	const found = [];
	for (const variant of loopVariants(headingBearing())) {
		let answer = null;
		try {
			answer = await deps.request({ type: "loop", start: loop.start, meters, profile: state.editingRoute?.profile ?? "bike", ...variant });
		} catch (error) {
			console.warn("Making a loop failed", error);
		}
		if (run !== loop.run) return;
		if (answer?.loop) found.push(answer.loop);
		loop.done++;
		renderPanel();
	}

	const score = (option) => Math.abs(option.meters - meters) / meters + 2 * option.retraced;
	loop.options = found.sort((a, b) => score(a) - score(b)).map((option) => ({ ...option, climb: null, coords: joinLegs(option.legs) }));
	loop.picked = 0;
	loop.stage = loop.options.length ? "options" : "failed";
	renderPanel();
	drawLoops();
	if (loop.options.length) deps.fit(loop.options.flatMap((option) => option.coords));
	measureClimbs(run);
}

/**
 * The three loops to ask for. Any way: spread round the compass from a
 * random start, so asking again gives new ones. One way: that way and a
 * little either side. Their corner counts and directions differ too.
 */
function loopVariants(bearing) {
	const base = bearing ?? Math.random() * 360;
	const bearings = bearing === null ? [base, base + 120, base + 240] : [base, base - HEADING_SPREAD_DEG, base + HEADING_SPREAD_DEG];
	const clockwise = Math.random() < 0.5;
	return bearings.map((b, i) => ({
		bearing: ((b % 360) + 360) % 360,
		corners: i === 1 ? 4 : 3,
		clockwise: i === 1 ? !clockwise : clockwise,
	}));
}

/** Fills in each option's climb, from the same elevation profile the planner measures. */
function measureClimbs(run) {
	for (const option of loop.options) {
		deps
			.request({ type: "elevation", coords: option.coords })
			.then(({ profile }) => {
				if (run !== loop.run) return;
				option.climb = deps.summarizeProfile(profile)?.climb ?? null;
				renderPanel();
			})
			.catch((error) => console.warn("Measuring a loop's climb failed", error));
	}
}

function useLoop() {
	const option = loop.options[loop.picked];
	if (!option) return;
	const name = `${Math.round(option.meters / METERS_PER[unit()])} ${distanceUnitLabel(unit())} loop`;
	closeLoopPanel();
	deps.apply(option, name);
}

function joinLegs(legs) {
	const coords = [];
	for (const leg of legs) coords.push(...(coords.length ? leg.coords.slice(1) : leg.coords));
	return coords;
}

// ---- Drawing ----

/** Shows or hides the route being planned while loops are drawn in its place. */
function setPlanLinesVisible(visible) {
	const map = state.planMap;
	if (!map) return;
	for (const id of ["plan-route-casing", "plan-route", "plan-route-unrouted"]) {
		if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
	}
}

function loopFeatures() {
	const features = [];
	if (loop.open && loop.start) {
		if (loop.stage === "setup" || loop.stage === "working") {
			features.push({ type: "Feature", properties: { kind: "guide" }, geometry: { type: "LineString", coordinates: guideCircle() } });
		}
		if (loop.stage === "options") {
			loop.options.forEach((option, index) => {
				features.push({
					type: "Feature",
					properties: { kind: "option", picked: index === loop.picked },
					geometry: { type: "LineString", coordinates: option.coords },
				});
			});
		}
		features.push({ type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: loop.start } });
	}
	return { type: "FeatureCollection", features };
}

function drawLoops() {
	state.planMap?.getSource(LOOP_SOURCE)?.setData(loopFeatures());
}

/**
 * A dashed circle showing about where loops of the chosen length will run:
 * through the start, toward the chosen heading, or (any way) round the start.
 */
function guideCircle() {
	const radius = targetMeters() / LOOP_WINDING / (2 * Math.PI);
	const bearing = headingBearing();
	const center = bearing === null ? loop.start : offset(loop.start, bearing, radius);
	// Any way: the loops reach about a diameter out, whichever way they go.
	const reach = bearing === null ? radius * 2 : radius;
	const points = [];
	for (let i = 0; i <= GUIDE_STEPS; i++) points.push(offset(center, (i * 360) / GUIDE_STEPS, reach));
	return points;
}

function showGuide() {
	drawLoops();
	if (loop.start && loop.stage === "setup") deps.fit(guideCircle());
}

function offset([lng, lat], bearing, meters) {
	const rad = (bearing * Math.PI) / 180;
	return [lng + (meters * Math.sin(rad)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (meters * Math.cos(rad)) / 111320];
}

// ---- The panel ----

function renderPanel() {
	const title = { setup: "Make a loop", working: "Making loops…", options: "Pick a loop", failed: "No good loop here" }[loop.stage];
	el.loopTitle.textContent = title;
	el.loopBody.innerHTML = { setup: setupHtml, working: workingHtml, options: optionsHtml, failed: failedHtml }[loop.stage]();
}

function setupHtml() {
	const label = distanceUnitLabel(unit());
	const lengths = LENGTH_CHOICES[unit()]
		.map((value) => `<button class="loop-choice" data-action="length" data-value="${value}" aria-pressed="${value === loop.length}">${value}</button>`)
		.join("");
	const headings = HEADINGS.map(
		([id, text]) =>
			`<button class="loop-segment" data-action="heading" data-value="${id}" aria-pressed="${id === loop.heading}"${id === "any" ? "" : ` aria-label="Head ${{ n: "north", e: "east", s: "south", w: "west" }[id]}"`}>${text}</button>`,
	).join("");
	const replacing = (state.editingRoute?.waypoints.length ?? 0) > 1;
	return `
		<p class="loop-start">${loop.start ? `Starts and finishes at <b>${loop.startLabel}</b>.` : "Finding where to start…"}</p>
		<div class="loop-field">
			<div class="loop-field-head">
				<span class="label" id="loopLengthLabel">Length</span>
				<span class="loop-length" aria-live="polite">${loop.length}<span class="unit"> ${label}</span></span>
			</div>
			<div class="loop-lengths" role="group" aria-labelledby="loopLengthLabel">
				<button class="loop-step" data-action="step" data-value="-1" aria-label="Shorter"${loop.length <= LENGTH_MIN ? " disabled" : ""}>−</button>
				${lengths}
				<button class="loop-step" data-action="step" data-value="1" aria-label="Longer"${loop.length >= maxLength() ? " disabled" : ""}>+</button>
			</div>
		</div>
		<div class="loop-field">
			<span class="label" id="loopHeadingLabel">Head out</span>
			<div class="loop-segments" role="group" aria-labelledby="loopHeadingLabel">${headings}</div>
		</div>
		${replacing ? `<p class="setting-note">The loop replaces this route’s points. Undo brings them back.</p>` : ""}
		<button class="btn primary pill loop-go" data-action="make"${loop.start ? "" : " disabled"}>Make 3 loops</button>`;
}

function workingHtml() {
	const steps = [0, 1, 2]
		.map((i) => {
			const status = i < loop.done ? "done" : i === loop.done ? "active" : "waiting";
			const text = i < loop.done ? `Loop ${i + 1} made` : i === loop.done ? `Making loop ${i + 1} of 3…` : `Loop ${i + 1}`;
			return `<li class="loop-progress-step is-${status}"><span class="loop-progress-mark" aria-hidden="true"></span>${text}</li>`;
		})
		.join("");
	return `
		<p class="loop-start">${loop.length} ${distanceUnitLabel(unit())} from ${loop.startLabel}. Map tiles are downloaded as needed.</p>
		<ol class="loop-progress" aria-live="polite">${steps}</ol>
		<button class="btn pill loop-go" data-action="cancel">Cancel</button>`;
}

function optionsHtml() {
	const u = unit();
	const label = distanceUnitLabel(u);
	const cards = loop.options
		.map((option, index) => {
			const length = (option.meters / METERS_PER[u]).toFixed(1);
			const retraced = Math.round(option.retraced * 100);
			const climb = option.climb === null ? "" : `<span>↑ ${formatElevation(option.climb, u)}</span>`;
			const away = farthest(option.coords);
			return `
				<button class="loop-option" role="radio" aria-checked="${index === loop.picked}" data-action="pick" data-value="${index}">
					<span class="loop-option-number" aria-hidden="true">${index + 1}</span>
					<span class="loop-option-text">
						<span class="loop-option-stats"><b>${length}<span class="unit"> ${label}</span></b>${climb}<span class="${option.retraced > RETRACED_WARN ? "loop-warn" : ""}">${retraced}% ridden twice</span></span>
						<span class="loop-option-note">Reaches ${(away.meters / METERS_PER[u]).toFixed(1)} ${label} ${away.direction} of the start</span>
					</span>
				</button>`;
		})
		.join("");
	const shortfall = loop.options.length < 3 ? `<p class="setting-note">Only ${loop.options.length} of 3 loops could be made here.</p>` : "";
	return `
		<div class="loop-options" role="radiogroup" aria-label="Loops">${cards}</div>
		${shortfall}
		<div class="loop-actions">
			<button class="btn pill" data-action="make">Shuffle</button>
			<button class="btn primary pill loop-use" data-action="use">Use loop ${loop.picked + 1}</button>
		</div>
		<button class="loop-link" data-action="settings">Change length or heading</button>`;
}

function failedHtml() {
	const shorter = Math.max(LENGTH_MIN, Math.round((loop.length * 0.6) / LENGTH_STEP) * LENGTH_STEP);
	const label = distanceUnitLabel(unit());
	return `
		<p class="loop-start">No loop could be routed from ${loop.startLabel}. There may be too few roads nearby (water, say), or the map couldn’t be downloaded.</p>
		<div class="loop-actions loop-actions-stack">
			${shorter < loop.length ? `<button class="btn" data-action="shorter" data-value="${shorter}">Try ${shorter} ${label}</button>` : ""}
			<button class="btn" data-action="settings">Change length or heading</button>
		</div>`;
}

/** How far from the start a loop reaches, and which way. */
function farthest(coords) {
	const [lng0, lat0] = coords[0];
	let best = { meters: 0, at: coords[0] };
	for (const point of coords) {
		const meters = haversineMeters(lat0, lng0, point[1], point[0]);
		if (meters > best.meters) best = { meters, at: point };
	}
	const east = (best.at[0] - lng0) * Math.cos((lat0 * Math.PI) / 180);
	const north = best.at[1] - lat0;
	const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
	const direction = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(bearing / 45) % 8];
	return { meters: best.meters, direction };
}
