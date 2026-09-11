/**
 * Unit conversion, string formatting, and small geometry/array helpers shared
 * across the app. Nothing here touches `state`, the DOM, or MapLibre — these
 * are pure functions safe to call from any module.
 */

import { METERS_PER_MILE, METERS_PER_KM, MPS_TO_MPH, MPS_TO_KPH, FEET_PER_METER, WARMUP_STABLE_FACTOR, WARMUP_CONFIRM_COUNT } from "./constants.js";

/**
 * Escapes a value for safe insertion into HTML text/attribute content.
 *
 * @param {*} value - Value to escape; coerced to a string first.
 * @returns {string} The value with `& < > " '` replaced by their entity equivalents.
 */
export function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Formats a distance in meters as a display string in the given unit, rounded
 * to two decimal places. Does not append the unit label — see `distanceUnitLabel`
 * in map-visuals.js for that.
 *
 * @param {number} meters - Distance in meters.
 * @param {"imperial"|"metric"} unit - Which unit to render in.
 * @returns {string} e.g. "10.52".
 */
export function formatDistance(meters, unit) {
	if (unit === "imperial") return `${(meters / METERS_PER_MILE).toFixed(2)}`;
	return `${(meters / METERS_PER_KM).toFixed(2)}`;
}

/**
 * Formats a speed in meters/second as a display string in the given unit,
 * rounded to one decimal place. Does not append the unit label — see
 * `speedUnitLabel` in map-visuals.js for that.
 *
 * @param {number} mps - Speed in meters per second.
 * @param {"imperial"|"metric"} unit - Which unit to render in.
 * @returns {string} e.g. "14.2".
 */
export function formatSpeed(mps, unit) {
	if (unit === "imperial") return `${(mps * MPS_TO_MPH).toFixed(1)}`;
	return `${(mps * MPS_TO_KPH).toFixed(1)}`;
}

/**
 * Converts an elevation in meters to the display unit and rounds to a whole
 * number, without a unit suffix.
 *
 * @param {number} meters - Elevation (or elevation delta) in meters.
 * @param {"imperial"|"metric"} unit - Which unit to render in.
 * @returns {string} e.g. "118" (feet) or "36" (meters).
 */
export function formatElevationValue(meters, unit) {
	return (unit === "imperial" ? meters * FEET_PER_METER : meters).toFixed(0);
}

/**
 * Same as `formatElevationValue`, with the unit suffix ("ft"/"m") appended.
 *
 * @param {number} meters - Elevation (or elevation delta) in meters.
 * @param {"imperial"|"metric"} unit - Which unit to render in.
 * @returns {string} e.g. "118 ft".
 */
export function formatElevation(meters, unit) {
	return `${formatElevationValue(meters, unit)} ${unit === "imperial" ? "ft" : "m"}`;
}

/**
 * Ride length rounded to the nearest minute, for the at-a-glance list. The
 * summary screen and the segment table still carry seconds, where they matter.
 *
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} e.g. "<1m", "42m", "1h", or "1h 5m".
 */
export function formatDurationMinutes(ms) {
	const totalMinutes = Math.round((ms || 0) / 60000);
	if (totalMinutes < 1) return "<1m";

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (!hours) return `${minutes}m`;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Formats a duration as a clock string, carrying seconds and growing an hours
 * field only when needed.
 *
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} "MM:SS", or "HH:MM:SS" once the duration reaches an hour.
 */
export function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) {
		return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	}
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Great-circle distance between two lat/lng points using the haversine formula.
 *
 * @param {number} lat1 - First point's latitude, in degrees.
 * @param {number} lon1 - First point's longitude, in degrees.
 * @param {number} lat2 - Second point's latitude, in degrees.
 * @param {number} lon2 - Second point's longitude, in degrees.
 * @returns {number} Distance in meters.
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
	const toRad = (v) => (v * Math.PI) / 180;
	const R = 6371000;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

/**
 * Initial compass bearing from one lat/lng point to another.
 *
 * @param {number} lat1 - Starting point's latitude, in degrees.
 * @param {number} lon1 - Starting point's longitude, in degrees.
 * @param {number} lat2 - Target point's latitude, in degrees.
 * @param {number} lon2 - Target point's longitude, in degrees.
 * @returns {number} Bearing in degrees clockwise from north, in [0, 360).
 */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
	const toRad = (v) => (v * Math.PI) / 180;
	const toDeg = (v) => (v * 180) / Math.PI;

	const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
	const x =
		Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
		Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));

	return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Largest value of `pick(item)` across `items`.
 *
 * Iterates manually rather than spreading into `Math.max` — a long ride's
 * points array can be tens of thousands long, which risks a call-stack
 * overflow when spread as arguments.
 *
 * @param {Array} items
 * @param {(item: *) => number} pick - Extracts the number to compare from each item.
 * @returns {number} `-Infinity` if `items` is empty.
 */
export function maxOf(items, pick) {
	// Spreading a long ride's points into Math.max risks a call-stack overflow.
	let max = -Infinity;
	for (const item of items) {
		const value = pick(item);
		if (value > max) max = value;
	}
	return max;
}

/**
 * Smallest value of `pick(item)` across `items`. See `maxOf` for why this
 * loops instead of using `Math.min(...items)`.
 *
 * @param {Array} items
 * @param {(item: *) => number} pick - Extracts the number to compare from each item.
 * @returns {number} `Infinity` if `items` is empty.
 */
export function minOf(items, pick) {
	let min = Infinity;
	for (const item of items) {
		const value = pick(item);
		if (value < min) min = value;
	}
	return min;
}

/**
 * Debug "clip GPS warm-up" support: finds the index of the first fix in a
 * settled run (see the WARMUP_* constants), or 0 if the ride never settles by
 * that definition — better to clip nothing than to grey out an entire ride
 * that just never got great reception.
 *
 * @param {Array<{accuracy: number}>} points - A session's recorded points.
 * @returns {number} Index into `points` where the "settled" stretch begins.
 */
export function findStableStartIndex(points) {
	const known = points.filter((p) => Number.isFinite(p.accuracy));
	if (known.length < WARMUP_CONFIRM_COUNT) return 0;

	const bestAccuracy = minOf(known, (p) => p.accuracy);
	const settledThreshold = bestAccuracy * WARMUP_STABLE_FACTOR;

	for (let i = 0; i <= points.length - WARMUP_CONFIRM_COUNT; i++) {
		let settled = true;
		for (let k = i; k < i + WARMUP_CONFIRM_COUNT; k++) {
			const accuracy = points[k].accuracy;
			if (!Number.isFinite(accuracy) || accuracy > settledThreshold) {
				settled = false;
				break;
			}
		}
		if (settled) return i;
	}
	return 0;
}
