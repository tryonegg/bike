/**
 * The "Route" option for Back to Start: a path home along roads from the
 * rider to the ride's start, followed by a route follower (route-follow.js).
 * live-map.js draws whatever it hands back.
 */

import { state } from "./state.js";
import { createRouteFollower } from "./route-follow.js";

const home = createRouteFollower("Route home");
// The latest route home as followed (rider first, with its steps and the
// rider's progress), for directions (directions.js).
let latest = null;

/**
 * Registers the function called whenever a new route home arrives, so the
 * map can redraw without waiting for the next GPS fix.
 * @param {() => void} fn
 */
export function onRouteHomeChange(fn) {
	home.onChange(fn);
}

/**
 * The route home from `rider`, trimmed to where the rider now is.
 *
 * @param {{lat: number, lng: number}} rider - The newest fix.
 * @param {Object} session - The live session (its first point is the start).
 * @returns {{coords: Array<[number, number]>, meters: number}|null} The route
 *   from the start to the rider (the guide line's order), and its length; or
 *   null while none is known, when the straight line stands in for it.
 */
export function routeHomeFrom(rider, session) {
	const start = session.points[0];
	const route = home.from(rider, [start.lng, start.lat], session, {
		profile: session.activityType === "bike" ? "bike" : "foot",
		avoidRetrace: state.prefs.routeAvoidRetrace,
	});
	latest = route;
	return route && { coords: [...route.coords].reverse(), meters: route.meters };
}

/**
 * The route home as last followed, rider first, with its turn-by-turn steps
 * and the rider's progress (see `FollowedRoute` in route-follow.js); null
 * when there's none.
 * @returns {Object|null}
 */
export function latestRouteHome() {
	return latest;
}

/**
 * Drops the current route home and stops its worker: at the end of a ride,
 * when Back to Start leaves Route, or when Avoid Retracing changes (the next
 * fix then asks for a route under the new setting).
 */
export function resetRouteHome() {
	home.reset();
	latest = null;
}
