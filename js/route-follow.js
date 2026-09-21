/**
 * Following a route to a target during a ride: a path along roads from the
 * rider to a goal, worked out on the device by route-worker.js from map
 * tiles already cached, never from an online service. Each follower owns a
 * worker, decides when a new route is worth asking for (none yet, the rider
 * has left the current one, or the goal has changed), and keeps the current
 * route trimmed to the rider's progress between answers.
 *
 * Used for Back to Start's Route option (route-home.js, the goal being the
 * ride's start) and for riding a planned route point to point
 * (ride-plan.js, the goal being the next point).
 */

import { ROUTE_OFF_ROUTE_M, ROUTE_MIN_REQUEST_MS, ROUTE_RETRY_MS, ROUTE_TRACK_SPACING_M, ROUTE_LOOKAHEAD_M } from "./constants.js";
import { haversineMeters } from "./format.js";

/**
 * Creates a route follower.
 *
 * @param {string} name - For log messages, e.g. "Route home".
 * @returns {{
 *   onChange: (fn: () => void) => void,
 *   from: (rider: {lat: number, lng: number}, goal: [number, number], session: Object,
 *     options: {profile: "bike"|"foot", avoidRetrace?: boolean}) => ({coords: Array<[number, number]>, meters: number}|null),
 *   reset: () => void,
 * }}
 */
export function createRouteFollower(name) {
	let worker = null;
	let listener = null;
	let nextRequestId = 1;
	// The request in flight, if any: only one runs at a time.
	let pendingId = 0;
	let lastRequestAt = 0;
	// After a failure (no route, or the worker broke) requests wait longer.
	let retryAfter = 0;

	// The goal being routed to, as "lng,lat", and the current route to it,
	// rider first, as [lng, lat] points, with the cumulative distance from its
	// first point to each point, in meters.
	let goalKey = null;
	let route = null;
	let routeDistances = null;
	// Which segment of the route the rider was last matched to.
	let progressIndex = 0;

	// The ride so far, thinned for the worker's fallback graph edges: the
	// session it came from, the last point kept, and how far through the
	// session's points it has read.
	let track = [];
	let trackSource = null;
	let lastTrackPoint = null;
	let trackCursor = 0;

	/**
	 * The route from `rider` to `goal`, trimmed to where the rider now is,
	 * asking the worker for a fresh one when there's none yet, the rider has
	 * left it, or the goal is new. Until a fresh one arrives, a route the
	 * rider has left is still returned, with a straight hop from the rider
	 * back onto it, rather than flicking to nothing and back again.
	 *
	 * @returns {{coords: Array<[number, number]>, meters: number}|null} Rider
	 *   first, goal last, with its length; null while none is known.
	 */
	function from(rider, goal, session, options) {
		updateTrack(session);
		const key = goal.join(",");
		if (key !== goalKey) {
			goalKey = key;
			route = null;
			routeDistances = null;
			progressIndex = 0;
			// A new goal is worth asking about straight away.
			lastRequestAt = 0;
			retryAfter = 0;
		}

		if (!route) {
			maybeRequest(rider, goal, options);
			return null;
		}
		const match = matchRider(rider);
		if (match.meters > ROUTE_OFF_ROUTE_M) maybeRequest(rider, goal, options);
		return routeFromMatch(rider, match);
	}

	/** Drops the current route and stops the worker. */
	function reset() {
		worker?.terminate();
		worker = null;
		pendingId = 0;
		lastRequestAt = 0;
		retryAfter = 0;
		goalKey = null;
		route = null;
		routeDistances = null;
		progressIndex = 0;
		track = [];
		trackSource = null;
	}

	/**
	 * Keeps a thinned copy of the ride's points, only ever appending. Rebuilt
	 * from scratch when a different session is passed (a new or recovered ride).
	 */
	function updateTrack(session) {
		if (trackSource !== session) {
			trackSource = session;
			track = [];
			lastTrackPoint = null;
			trackCursor = 0;
		}
		const points = session.points;
		for (; trackCursor < points.length; trackCursor++) {
			const point = points[trackCursor];
			if (lastTrackPoint && haversineMeters(lastTrackPoint.lat, lastTrackPoint.lng, point.lat, point.lng) < ROUTE_TRACK_SPACING_M) {
				continue;
			}
			track.push([point.lng, point.lat]);
			lastTrackPoint = point;
		}
	}

	/** Asks the worker for a route, unless one is already on its way or it's too soon. */
	function maybeRequest(rider, goal, { profile, avoidRetrace = false }) {
		const now = Date.now();
		if (pendingId || now < retryAfter || now - lastRequestAt < ROUTE_MIN_REQUEST_MS) return;
		if (!worker) startWorker();
		if (!worker) return;

		lastRequestAt = now;
		pendingId = nextRequestId++;
		worker.postMessage({
			id: pendingId,
			goalKey,
			start: goal,
			rider: [rider.lng, rider.lat],
			// Includes the newest fix, which the thinning may have skipped.
			track: [...track, [rider.lng, rider.lat]],
			profile,
			avoidRetrace,
		});
	}

	/** Creates the worker. A browser that can't run a module worker gets no routes. */
	function startWorker() {
		try {
			worker = new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
		} catch (error) {
			console.warn(`${name} unavailable`, error);
			worker = null;
			retryAfter = Infinity;
			return;
		}
		worker.addEventListener("message", handleWorkerMessage);
		worker.addEventListener("error", (event) => {
			console.warn(`${name} worker failed`, event.message || event);
			pendingId = 0;
			retryAfter = Date.now() + ROUTE_RETRY_MS;
		});
	}

	function handleWorkerMessage(event) {
		const { id, route: found, error, stats, goalKey: answeredGoal } = event.data;
		if (id !== pendingId) return;
		pendingId = 0;
		// Asked before the goal moved on: the next fix asks again.
		if (answeredGoal !== goalKey) return;

		if (error || !found) {
			if (error) console.warn(`${name} failed`, error);
			// No route from here (too far from any cached road, say): keep the old
			// one if there is one, and try again after a pause.
			retryAfter = Date.now() + ROUTE_RETRY_MS;
			return;
		}
		console.debug(name, Math.round(found.meters), "m", stats);

		route = found.coords;
		routeDistances = [0];
		for (let i = 1; i < route.length; i++) {
			const [lngA, latA] = route[i - 1];
			const [lngB, latB] = route[i];
			routeDistances.push(routeDistances[i - 1] + haversineMeters(latA, lngA, latB, lngB));
		}
		progressIndex = 0;
		listener?.();
	}

	/**
	 * Finds the nearest point on the current route to the rider, looking only a
	 * little ahead of where they were last matched, so a route that doubles back
	 * on itself can't skip ahead. Advances the match only while the rider is
	 * actually on the route.
	 *
	 * @returns {{point: [number, number], t: number, meters: number, index: number}}
	 *   `meters` is the rider's distance from the route.
	 */
	function matchRider(rider) {
		let best = null;
		for (let i = progressIndex; i + 1 < route.length; i++) {
			if (i > progressIndex && routeDistances[i] - routeDistances[progressIndex] > ROUTE_LOOKAHEAD_M) break;
			const hit = projectOntoSegment(rider, route[i], route[i + 1]);
			if (!best || hit.meters < best.meters) best = { ...hit, index: i };
		}
		if (best.meters <= ROUTE_OFF_ROUTE_M) progressIndex = best.index;
		return best;
	}

	/** The rest of the route from a match, rider first, with its length. */
	function routeFromMatch(rider, match) {
		const { index, t, point, meters } = match;
		const along = routeDistances[index] + t * (routeDistances[index + 1] - routeDistances[index]);
		const remaining = routeDistances[routeDistances.length - 1] - along;
		return { coords: [[rider.lng, rider.lat], point, ...route.slice(index + 1)], meters: meters + remaining };
	}

	return {
		onChange: (fn) => {
			listener = fn;
		},
		from,
		reset,
	};
}

/**
 * The nearest point to `rider` on the segment a→b, on a flat local
 * approximation (fine at these distances).
 * @returns {{point: [number, number], t: number, meters: number}}
 */
function projectOntoSegment(rider, a, b) {
	const cosLat = Math.cos((rider.lat * Math.PI) / 180);
	const ax = (a[0] - rider.lng) * cosLat;
	const ay = a[1] - rider.lat;
	const dx = (b[0] - a[0]) * cosLat;
	const dy = b[1] - a[1];
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
	const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
	return { point, t, meters: haversineMeters(rider.lat, rider.lng, point[1], point[0]) };
}
