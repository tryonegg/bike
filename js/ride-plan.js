/**
 * Riding a planned route: what the live map draws of the route picked in
 * ride setup. Followed "as is", that's the planned line. Followed "to each
 * point", it's a route worked out live from the rider to the next planned
 * point (route-follow.js), then the planned legs on from there; the next
 * point moves on as the rider reaches each one, and the points still to
 * come are marked on the map.
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

import { PLAN_ARRIVE_M, PLAN_SKIP_AWAY_M, ROUTE_OFF_ROUTE_M } from "./constants.js";
import { state } from "./state.js";
import { haversineMeters } from "./format.js";
import { createRouteFollower, createLineTracker } from "./route-follow.js";

const follower = createRouteFollower("Route to next point");
let listener = null;
// The latest guidance for the ride's route (see `ridePlanGuidance`).
let guidance = null;
// Following a route as is: its progress tracker and its steps, once the
// worker has worked them out.
let asIs = null;
let directionsWorker = null;
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
	return Boolean(route) && route.source !== "gpx" && route.waypoints.length >= 2;
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

	advance(point, session, route.waypoints);
	const next = session.nextWaypoint;
	drawMarkers(route.waypoints, next);
	if (next >= route.waypoints.length) {
		guidance = { finished: true };
		return [];
	}

	const goal = route.waypoints[next];
	const live = follower.from(point, goal, session, { profile: route.profile ?? "bike" });
	const line = live ? [...live.coords] : [[point.lng, point.lat], goal];
	for (const leg of route.legs.slice(next)) line.push(...leg.coords.slice(1));

	// Until the live route arrives, the next point is just straight ahead.
	const straight = haversineMeters(point.lat, point.lng, goal[1], goal[0]);
	guidance = {
		finished: false,
		steps: live?.steps ?? [],
		along: live?.along ?? 0,
		offRoute: live?.offRoute ?? false,
		target: { label: `Point ${next + 1}`, meters: live ? live.meters : straight, point: goal },
		following: next + 1 < route.waypoints.length ? `Point ${next + 2}` : null,
		stopsLeft: route.waypoints.length - next,
		canSkip: true,
	};
	return line;
}

/**
 * Guidance along a route followed as is: the rider's progress along the
 * planned line, and its steps once the worker has worked them out.
 */
function asIsGuidance(point, route) {
	if (asIs?.route !== route) {
		asIs = { route, tracker: createLineTracker(route.coords), steps: [] };
		requestSteps(route);
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

/** Asks the routing worker for the turn-by-turn steps along a route followed as is. */
function requestSteps(route) {
	try {
		directionsWorker ??= new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
	} catch (error) {
		console.warn("Directions unavailable", error);
		return;
	}
	const id = Date.now();
	const handle = (event) => {
		if (event.data.id !== id) return;
		directionsWorker?.removeEventListener("message", handle);
		if (event.data.error) console.warn("Working out directions failed", event.data.error);
		if (asIs?.route !== route || !event.data.steps) return;
		asIs.steps = event.data.steps.map((step) => ({ ...step, along: asIs.tracker.distances[step.index] }));
		listener?.();
	};
	directionsWorker.addEventListener("message", handle);
	directionsWorker.postMessage({ id, type: "directions", coords: route.coords, profile: route.profile ?? "bike" });
}

/**
 * The latest guidance for the ride's planned route, or null when there's
 * none being followed (no route, or it's been cancelled).
 *
 * @returns {{finished: boolean, steps?: Array<Object>, along?: number, offRoute?: boolean,
 *   target?: {label: string, meters: number, point: [number, number]}, following?: string|null,
 *   stopsLeft?: number|null, canSkip?: boolean}|null}
 *   `finished` once the route's end has been reached; otherwise `steps`
 *   (each with `along`) and `along` in one reckoning, `target` the next
 *   point (or the route's end) and how far it is along the way, `following`
 *   the point after it, and `stopsLeft` how many points are still to come.
 */
export function ridePlanGuidance() {
	return guidance;
}

/** Skips the next point of a route followed point to point, making for the one after. */
export function skipNextPoint(session) {
	const route = state.rideRoute;
	if (!route || session.routeMode !== "points" || session.nextWaypoint >= route.waypoints.length) return;
	session.nextWaypoint += 1;
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
 * that ends where it starts would count as finished at the start.
 */
function advance(point, session, waypoints) {
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
}

/** Marks the points still to come, numbered as they were planned. */
function drawMarkers(waypoints, next) {
	const map = state.liveMap;
	if (map === markersMap && next === markersFrom) return;
	clearMarkers();
	markersMap = map;
	markersFrom = next;
	if (!map) return;
	for (let i = next; i < waypoints.length; i++) {
		const element = document.createElement("div");
		element.className = `plan-waypoint live-waypoint${i === next ? " next" : ""}`;
		element.innerHTML = `<span>${i + 1}</span>`;
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
	directionsWorker?.terminate();
	directionsWorker = null;
}
