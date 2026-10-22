/**
 * Riding a planned route: what the live map draws of the route picked in
 * ride setup. Followed "as is", that's the planned line. Followed "to each
 * point", it's a route worked out live from the rider to the next planned
 * point (route-follow.js), then the planned legs on from there; the next
 * point moves on as the rider reaches each one, and the points still to
 * come are marked on the map. Via points (point-marks.js) are followed the
 * same way, but passed quietly: one counts as passed once the rider is
 * riding the planned leg on from it, and the guidance looks past them to
 * the next stop, with the turns beyond them taken from the planned line.
 *
 * The ride keeps its place on the route in the session (`routeMode`,
 * `nextWaypoint`, `lastReached`, and `routeCancelled` once the rider has
 * stopped following it), so a recovered ride carries on from it.
 *
 * It also works out the guidance directions.js shows and speaks: the steps
 * of whatever's being followed (the live route to the next point, or the
 * planned line itself, whose steps the routing worker works out once), how
 * far along it the rider is, and what they're heading for.
 */

import { PLAN_ARRIVE_M, PLAN_SKIP_AWAY_M, PLAN_VIA_PASSED_M, PLAN_VIA_LOOK_M, PLAN_VIA_HEADING_DEG, ROUTE_OFF_ROUTE_M } from "./constants.js";
import { state } from "./state.js";
import { haversineMeters, bearingDegrees } from "./format.js";
import { createRouteFollower, createLineTracker, projectOntoSegment } from "./route-follow.js";
import { pointName, pointMarkerContent, isStop } from "./point-marks.js";

const follower = createRouteFollower("Route to next point");
let listener = null;
// The latest guidance for the ride's route (see `ridePlanGuidance`).
let guidance = null;
// Following a route as is: its progress tracker and its steps, once the
// worker has worked them out.
let asIs = null;
// Following point to point with via points: the planned line through all
// the points, how far along it each point is, and its steps once worked out.
let planned = null;
let directionsWorker = null;
let nextStepsId = 1;
// The markers for the points still to come, and which map and which next
// point they were drawn for.
let markers = [];
let markersMap = null;
let markersFrom = -1;

/**
 * Registers the function called whenever a new route to the next point
 * arrives, so the map can redraw without waiting for the next GPS fix.
 * @param {() => void} fn
 */
export function onRidePlanChange(fn) {
	listener = fn;
	follower.onChange(fn);
}

/**
 * Whether a route can be followed point to point: it needs planned points,
 * which a GPX track used as drawn doesn't have.
 * @param {Object|null} route
 * @returns {boolean}
 */
export function canFollowPoints(route) {
	return Boolean(route) && (route.destination || (route.source !== "gpx" && route.waypoints.length >= 2));
}

/**
 * A ride's destination (picked in ride setup, see destination.js) as a
 * route: unsaved, with its one point to follow to, and a line to draw
 * before the ride starts.
 *
 * @param {[number, number]} point - [lng, lat].
 * @param {Array<[number, number]>} [coords] - The line to draw in setup.
 * @returns {Object}
 */
export function destinationRoute(point, coords = [point]) {
	return { id: null, destination: true, name: "Destination", profile: "bike", waypoints: [point], legs: [], coords, meters: null };
}

/** The destination's pin: a flag, standing on the spot. */
export function destinationMarkerElement() {
	const element = document.createElement("div");
	element.className = "destination-pin";
	// MapLibre positions the marker with its own transform, so the drop's
	// rotation goes on an inner element.
	element.innerHTML =
		'<span class="destination-pin-drop"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/></svg></span>';
	return element;
}

/**
 * The planned route's line for the live map, with the rider at `point`.
 * Following point to point, this also moves the ride on to the next point
 * when the rider reaches one, and updates the markers.
 *
 * @param {{lat: number, lng: number}} point - The rider.
 * @param {Object} session - The live session.
 * @returns {Array<[number, number]>}
 */
export function ridePlanLine(point, session) {
	const route = state.rideRoute;
	if (!route || session.routeCancelled) {
		guidance = null;
		clearMarkers();
		return [];
	}
	if (session.routeMode !== "points" || !canFollowPoints(route)) {
		guidance = asIsGuidance(point, route);
		return route.coords;
	}

	advance(point, session, route);
	const next = session.nextWaypoint;
	drawMarkers(route, next);
	if (next >= route.waypoints.length) {
		guidance = { finished: true, destination: Boolean(route.destination) };
		return [];
	}

	const goal = route.waypoints[next];
	const live = follower.from(point, goal, session, { profile: route.profile ?? "bike" });
	const line = live ? [...live.coords] : [[point.lng, point.lat], goal];
	for (const leg of route.legs.slice(next)) line.push(...leg.coords.slice(1));

	// Until the live route arrives, the next point is just straight ahead.
	const straight = haversineMeters(point.lat, point.lng, goal[1], goal[0]);
	const toGoal = live ? live.meters : straight;
	// What's being headed for is the next stop, by way of any via points first.
	const stop = nextStop(route, next);
	const following = nextStop(route, stop + 1);
	guidance = {
		finished: false,
		steps: live ? stepsToStop(route, next, stop, live) : [],
		along: live?.along ?? 0,
		offRoute: live?.offRoute ?? false,
		target: {
			label: route.destination ? "Destination" : pointName(route, stop),
			meters: route.legs.slice(next, stop).reduce((sum, leg) => sum + leg.meters, toGoal),
			point: goal,
		},
		// The route's last point, by way of the planned legs on from the next one.
		finish: { meters: route.legs.slice(next).reduce((sum, leg) => sum + leg.meters, toGoal) },
		following: following < route.waypoints.length ? pointName(route, following) : null,
		stopsLeft: route.waypoints.slice(next).filter((_, i) => isStop(route, next + i)).length,
		// There's nothing to skip on to from a destination.
		canSkip: !route.destination,
		destination: Boolean(route.destination),
	};
	return line;
}

/** The first stop (not a via point) from waypoint `from` on, or the waypoint count when there's none. */
function nextStop(route, from) {
	for (let i = from; i < route.waypoints.length; i++) if (isStop(route, i)) return i;
	return route.waypoints.length;
}

/**
 * The steps to the next stop: the live route's to the next point, and when
 * that's a via point, the planned line's on from it (once worked out), in
 * the live route's reckoning, ending in arriving at the stop.
 */
function stepsToStop(route, next, stop, live) {
	if (stop === next) return live.steps;
	const plan = plannedLine(route);
	const steps = live.steps.filter((step) => step.turn !== "arrive");
	if (!plan.steps) return steps;
	const from = plan.waypointAlong[next];
	const to = plan.waypointAlong[stop];
	// The planned line's distances, counted on from the end of the live route.
	const shift = live.total - from;
	for (const step of plan.steps) {
		// A turn right at the via point is taken from the planned line too.
		if (step.turn === "arrive" || step.along < from - 5 || step.along >= to - 1) continue;
		steps.push({ ...step, along: step.along + shift });
	}
	steps.push({ index: -1, along: to + shift, turn: "arrive", name: null, kind: null, stay: false, point: route.waypoints[stop] });
	return steps;
}

/**
 * The planned line through all of a route's points, with how far along it
 * each point is, and its steps, asked for once and filled in when worked out.
 */
function plannedLine(route) {
	if (planned?.route === route) return planned;
	const coords = [];
	const ends = [0];
	route.legs.forEach((leg, i) => {
		coords.push(...(i ? leg.coords.slice(1) : leg.coords));
		ends.push(coords.length - 1);
	});
	const { distances } = createLineTracker(coords);
	const plan = { route, waypointAlong: ends.map((index) => distances[index] ?? 0), steps: null };
	planned = plan;
	if (coords.length >= 2) {
		requestSteps(coords, route.profile, (steps) => {
			if (planned === plan) plan.steps = steps.map((step) => ({ ...step, along: distances[step.index] }));
		});
	}
	return plan;
}

/**
 * Guidance along a route followed as is: the rider's progress along the
 * planned line, and its steps once the worker has worked them out.
 */
function asIsGuidance(point, route) {
	if (asIs?.route !== route) {
		const tracked = { route, tracker: createLineTracker(route.coords), steps: [] };
		asIs = tracked;
		requestSteps(route.coords, route.profile, (steps) => {
			if (asIs === tracked) tracked.steps = steps.map((step) => ({ ...step, along: tracked.tracker.distances[step.index] }));
		});
	}
	const { along, meters } = asIs.tracker.match(point);
	const total = asIs.tracker.total;
	// Once the end is reached the route's done, however far on the rider rides.
	asIs.finished ||= total - along <= PLAN_ARRIVE_M && meters <= PLAN_ARRIVE_M;
	return {
		finished: asIs.finished,
		steps: asIs.steps,
		along,
		offRoute: meters > ROUTE_OFF_ROUTE_M,
		target: { label: "End of route", meters: total - along + meters, point: route.coords[route.coords.length - 1] },
		following: null,
		stopsLeft: null,
		canSkip: false,
	};
}

/**
 * Asks the routing worker for the turn-by-turn steps along a line (a route
 * followed as is, or a planned line past via points), handing them to `done`.
 */
function requestSteps(coords, profile, done) {
	try {
		directionsWorker ??= new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
	} catch (error) {
		console.warn("Directions unavailable", error);
		return;
	}
	const id = nextStepsId++;
	const handle = (event) => {
		if (event.data.id !== id) return;
		directionsWorker?.removeEventListener("message", handle);
		if (event.data.error) console.warn("Working out directions failed", event.data.error);
		if (!event.data.steps) return;
		done(event.data.steps);
		listener?.();
	};
	directionsWorker.addEventListener("message", handle);
	directionsWorker.postMessage({ id, type: "directions", coords, profile: profile ?? "bike" });
}

/**
 * The latest guidance for the ride's planned route, or null when there's
 * none being followed (no route, or it's been cancelled).
 *
 * @returns {{finished: boolean, steps?: Array<Object>, along?: number, offRoute?: boolean,
 *   target?: {label: string, meters: number, point: [number, number]}, finish?: {meters: number},
 *   following?: string|null,
 *   stopsLeft?: number|null, canSkip?: boolean}|null}
 *   `finished` once the route's end has been reached; otherwise `steps`
 *   (each with `along`) and `along` in one reckoning, `target` the next
 *   stop (or the route's end) and how far it is along the way, `finish`
 *   how far the route's end is (only when there are points before it), `following`
 *   the stop after it, and `stopsLeft` how many stops are still to come.
 *   Via points (point-marks.js) aren't targets or counted: they're passed
 *   on the way.
 */
export function ridePlanGuidance() {
	return guidance;
}

/** Skips the next stop of a route followed point to point (and any via points before it), making for the one after. */
export function skipNextPoint(session) {
	const route = state.rideRoute;
	if (!route || session.routeMode !== "points" || session.nextWaypoint >= route.waypoints.length) return;
	session.nextWaypoint = nextStop(route, session.nextWaypoint) + 1;
}

/** Stops following the ride's route: it's taken off the map, and its directions end. */
export function cancelRideRoute(session) {
	session.routeCancelled = true;
	guidance = null;
	clearMarkers();
}

/**
 * Moves the ride on past any point the rider has reached: the next one, or
 * a later one (skipping those before it), though a later one only counts
 * once the rider is well away from the last point reached. Otherwise a loop
 * that ends where it starts would count as finished at the start. A via
 * point also counts as passed once the rider's riding the leg on from it.
 */
function advance(point, session, route) {
	const { waypoints } = route;
	const near = (lngLat, meters) => haversineMeters(point.lat, point.lng, lngLat[1], lngLat[0]) <= meters;
	const awayFromLast = !session.lastReached || !near(session.lastReached, PLAN_SKIP_AWAY_M);
	for (let i = session.nextWaypoint; i < waypoints.length; i++) {
		if (i > session.nextWaypoint && !awayFromLast) break;
		if (near(waypoints[i], PLAN_ARRIVE_M)) {
			session.nextWaypoint = i + 1;
			session.lastReached = waypoints[i];
			return;
		}
	}
	while (session.nextWaypoint < waypoints.length && !isStop(route, session.nextWaypoint) && ridingLegFrom(point, session, route, session.nextWaypoint)) {
		session.lastReached = waypoints[session.nextWaypoint];
		session.nextWaypoint += 1;
	}
}

/**
 * Whether the rider is on the planned leg on from waypoint `index`, past it
 * and heading the way the leg goes, so the point's been passed: taken a
 * different road to, or ridden by just out of reach. The heading keeps an
 * out-and-back from counting on the way out.
 */
function ridingLegFrom(point, session, route, index) {
	const leg = route.legs[index];
	const heading = session.currentHeading;
	if (!leg || !Number.isFinite(heading)) return false;
	let covered = 0;
	for (let i = 0; i + 1 < leg.coords.length && covered < PLAN_VIA_LOOK_M; i++) {
		const a = leg.coords[i];
		const b = leg.coords[i + 1];
		const length = haversineMeters(a[1], a[0], b[1], b[0]);
		const hit = projectOntoSegment(point, a, b);
		const along = covered + hit.t * length;
		covered += length;
		if (along < PLAN_VIA_PASSED_M || hit.meters > ROUTE_OFF_ROUTE_M) continue;
		const off = Math.abs(((bearingDegrees(a[1], a[0], b[1], b[0]) - heading + 540) % 360) - 180);
		if (off <= PLAN_VIA_HEADING_DEG) return true;
	}
	return false;
}

/** Marks the points still to come, numbered as they were planned (or with their icons). */
function drawMarkers(route, next) {
	const { waypoints } = route;
	const map = state.liveMap;
	if (map === markersMap && next === markersFrom) return;
	clearMarkers();
	markersMap = map;
	markersFrom = next;
	if (!map) return;
	if (state.rideRoute?.destination) {
		markers.push(new maplibregl.Marker({ element: destinationMarkerElement(), anchor: "bottom" }).setLngLat(waypoints[0]).addTo(map));
		return;
	}
	for (let i = next; i < waypoints.length; i++) {
		const element = document.createElement("div");
		const content = pointMarkerContent(route, i);
		element.className = `plan-waypoint live-waypoint ${content.className}${i === nextStop(route, next) ? " next" : ""}`;
		element.innerHTML = `<span>${content.html}</span>`;
		markers.push(new maplibregl.Marker({ element }).setLngLat(waypoints[i]).addTo(map));
	}
}

function clearMarkers() {
	for (const marker of markers) marker.remove();
	markers = [];
	markersMap = null;
	markersFrom = -1;
}

/** Forgets the route to the next point and its markers: at the end of a ride, or before a new one. */
export function resetRidePlan() {
	follower.reset();
	clearMarkers();
	guidance = null;
	asIs = null;
	planned = null;
	directionsWorker?.terminate();
	directionsWorker = null;
}
