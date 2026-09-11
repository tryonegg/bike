/**
 * Color-ramp helpers. Everything here maps a 0..1 (or band-index) value onto
 * the shared `PACE_STOPS` gradient — used for the route/chart's speed
 * coloring, the calendar's pace coloring, and the debug GPS-accuracy overlay.
 */

import { PACE_STOPS, SPEED_BANDS, ACCURACY_BANDS } from "./constants.js";

/**
 * Maps a slow-to-fast fraction onto the `PACE_STOPS` gradient, blending
 * linearly between the two nearest stops.
 *
 * @param {number} t - 0 (slow) to 1 (fast). Out-of-range or non-finite values
 *   are clamped/defaulted to 0.5.
 * @returns {string} A `rgb(r, g, b)` CSS color string. Comma syntax is used
 *   deliberately — MapLibre's color parser does not accept the
 *   space-separated `rgb(r g b)` form.
 */
export function paceColor(t) {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
	const scaled = clamped * (PACE_STOPS.length - 1);
	const index = Math.min(PACE_STOPS.length - 2, Math.floor(scaled));
	const mix = scaled - index;
	const from = hexToRgb(PACE_STOPS[index]);
	const to = hexToRgb(PACE_STOPS[index + 1]);
	const channel = (a, b) => Math.round(a + (b - a) * mix);
	// Comma syntax: MapLibre's colour parser does not take the space-separated form.
	return `rgb(${channel(from[0], to[0])}, ${channel(from[1], to[1])}, ${channel(from[2], to[2])})`;
}

/**
 * Parses a `#rrggbb` hex color into its channel values.
 *
 * @param {string} hex - Hex color string, e.g. "#e05a3a".
 * @returns {[number, number, number]} `[r, g, b]`, each 0-255.
 */
export function hexToRgb(hex) {
	const value = parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Buckets a speed into one of `SPEED_BANDS` discrete bands, relative to the
 * fastest speed seen (`maxSpeed`). Used to batch a route/chart line into runs
 * of one color instead of drawing a unique color per point pair.
 *
 * @param {number} speed - Speed in meters/second.
 * @param {number} maxSpeed - The fastest speed to scale against.
 * @returns {number} Band index in `[0, SPEED_BANDS - 1]`.
 */
export function speedBand(speed, maxSpeed) {
	const clamped = Math.max(0, Math.min(1, speed / maxSpeed));
	return Math.min(SPEED_BANDS - 1, Math.floor(clamped * SPEED_BANDS));
}

/**
 * Resolves a speed band to its display color.
 *
 * @param {number} band - Band index from `speedBand`.
 * @returns {string} `rgb(...)` color string, sampled at the band's midpoint
 *   so bands stay evenly spaced across the gradient.
 */
export function speedBandColor(band) {
	// Sample the ramp mid-band so the bands stay evenly spaced across it.
	return paceColor((band + 0.5) / SPEED_BANDS);
}

/**
 * Debug GPS-accuracy overlay: buckets a fix's accuracy (radius of uncertainty
 * in meters — smaller is better) into one of `ACCURACY_BANDS` discrete bands,
 * scaled to this ride's own best/worst fixes. Inverted relative to
 * `speedBand` so band 0 is the worst fix (colors red) and the top band the
 * best (colors green).
 *
 * @param {number} accuracy - The fix's accuracy radius, in meters.
 * @param {number} minAccuracy - This ride's best (smallest) accuracy value.
 * @param {number} maxAccuracy - This ride's worst (largest) accuracy value.
 * @returns {number} Band index in `[0, ACCURACY_BANDS - 1]`.
 */
export function accuracyBand(accuracy, minAccuracy, maxAccuracy) {
	const range = maxAccuracy - minAccuracy;
	const t = range > 0 ? 1 - (accuracy - minAccuracy) / range : 1;
	return Math.min(ACCURACY_BANDS - 1, Math.floor(Math.max(0, Math.min(1, t)) * ACCURACY_BANDS));
}

/**
 * Resolves an accuracy band to its display color.
 *
 * @param {number} band - Band index from `accuracyBand`.
 * @returns {string} `rgb(...)` color string.
 */
export function accuracyBandColor(band) {
	return paceColor((band + 0.5) / ACCURACY_BANDS);
}
