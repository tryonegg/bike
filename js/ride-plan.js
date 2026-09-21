/**
 * Riding a planned route: what the live map draws of the route picked in
 * ride setup. Followed "as is", that's the planned line. Followed "to each
 * point", it's a route worked out live from the rider to the next planned
 * point (route-follow.js), then the planned legs on from there; the next
 * point moves on as the rider reaches each one, and the points still to
 * come are marked on the map.
 *
 * The ride keeps its place on the route in the session (`routeMode`,
 * `nextWaypoint`, `lastReached`), so a recovered ride carries on from it.
 */

import { PLAN_ARRIVE_M, PLAN_SKIP_AWAY_M } from "./constants.js";
import { state } from "./state.js";
import { haversineMeters } from "./format.js";
import { createRouteFollower } from "./route-follow.js";

const follower = createRouteFollower("Route to next point");
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
	if (!route) return [];
	if (session.routeMode !== "points" || !canFollowPoints(route)) return route.coords;

	advance(point, session, route.waypoints);
	const next = session.nextWaypoint;
	drawMarkers(route.waypoints, next);
	if (next >= route.waypoints.length) return [];

	const goal = route.waypoints[next];
	const live = follower.from(point, goal, session, { profile: route.profile ?? "bike" });
	const line = live ? [...live.coords] : [[point.lng, point.lat], goal];
	for (const leg of route.legs.slice(next)) line.push(...leg.coords.slice(1));
	return line;
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
}
