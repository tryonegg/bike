/**
 * Shareable route links. A planned route is shared as its name, waypoints,
 * and what they are (point-marks.js), in the URL's hash (which is never sent
 * to a server): `#r1=<points>&n=<name>&m=<marks>`, the name and marks only
 * when there are any. The receiving app routes between the points itself.
 *
 * <points> is the waypoints as [lat, lng] pairs at 1e-5 degrees (about a
 * meter), each as the difference from the one before, in the style of
 * Google's encoded polylines: every number is zigzagged to be non-negative
 * and split into 5-bit groups, lowest first, each written as one base64url
 * character whose top bit says another group follows. That keeps the link
 * short (about 8 characters per point) and free of anything a chat app
 * would percent-encode. <name>, if the route had one, is just that text,
 * percent-encoded (the only part of the link that needs it, since <points>
 * never contains `&`, `=`, or `%`).
 *
 * <marks> lists the points that have a mark, comma-separated, each as
 * `<index>.<icon>.<title>`: the point's position (from 0), its icon's key
 * (empty for none), and its title, percent-encoded (so it has no comma; it
 * may have dots, but only the first two separate fields). The marks come
 * after the name, so an older copy of the app, which reads everything after
 * `&n=` as the name, still opens the route.
 */

import { normalizeMark } from "./point-marks.js";

const PREFIX = "#r1=";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SCALE = 1e5;
/** Most waypoints a link may carry, so a bad link can't start a huge amount of routing. */
export const MAX_SHARED_WAYPOINTS = 100;
/** Longest name a link may carry, matching the planner's name field. */
export const MAX_SHARED_NAME_LENGTH = 60;

/**
 * The link that opens a route in another copy of the app.
 * @param {Array<[number, number]>} waypoints - [lng, lat] pairs, in order.
 * @param {string} [name] - The route's name, carried along so the receiving
 *   app can offer it as a starting point (the recipient can still rename
 *   it). Left out when blank or auto-generated.
 * @param {Array} [marks] - What each waypoint is, in the same order (see point-marks.js).
 * @returns {string}
 */
export function buildShareUrl(waypoints, name = "", marks = []) {
	let data = "";
	let prevLat = 0;
	let prevLng = 0;
	for (const [lng, lat] of waypoints) {
		const latUnits = Math.round(lat * SCALE);
		const lngUnits = Math.round(lng * SCALE);
		data += encodeNumber(latUnits - prevLat) + encodeNumber(lngUnits - prevLng);
		prevLat = latUnits;
		prevLng = lngUnits;
	}
	const trimmedName = name.trim().slice(0, MAX_SHARED_NAME_LENGTH);
	const marked = waypoints
		.map((_, i) => [i, normalizeMark(marks[i])])
		.filter(([, mark]) => mark)
		.map(([i, mark]) => `${i}.${mark.icon ?? ""}.${encodeURIComponent(mark.title)}`);
	let suffix = trimmedName ? `&n=${encodeURIComponent(trimmedName)}` : "";
	if (marked.length) suffix += `&m=${marked.join(",")}`;
	return `${location.origin}${location.pathname}${PREFIX}${data}${suffix}`;
}

/**
 * Whether a hash is a shared route link (valid or not).
 * @param {string} hash
 */
export function isShareHash(hash) {
	return hash.startsWith(PREFIX);
}

/**
 * The route in a shared route hash.
 * @param {string} hash - `location.hash`.
 * @returns {{waypoints: Array<[number, number]>, name: string, marks: Array}|null}
 *   `name` is `""` when the link carried none, and `marks` has one entry per
 *   waypoint, null for a plain one. Null when the hash is damaged, has fewer
 *   than two points, or has too many.
 */
export function parseShareHash(hash) {
	if (!isShareHash(hash)) return null;
	const [data, ...params] = hash.slice(PREFIX.length).split("&");
	let name = "";
	let markText = "";
	for (const param of params) {
		if (param.startsWith("n=")) {
			try {
				name = decodeURIComponent(param.slice(2)).trim().slice(0, MAX_SHARED_NAME_LENGTH);
			} catch {
				return null;
			}
		} else if (param.startsWith("m=")) {
			markText = param.slice(2);
		}
	}

	const numbers = [];
	let value = 0;
	let shift = 0;
	for (const char of data) {
		const group = ALPHABET.indexOf(char);
		if (group < 0) return null;
		value += (group & 31) * 2 ** shift;
		if (group & 32) {
			shift += 5;
			if (shift > 30) return null;
			continue;
		}
		numbers.push(value % 2 ? -(value + 1) / 2 : value / 2);
		value = 0;
		shift = 0;
	}
	if (shift !== 0 || numbers.length % 2 !== 0) return null;

	const points = [];
	let lat = 0;
	let lng = 0;
	for (let i = 0; i < numbers.length; i += 2) {
		lat += numbers[i];
		lng += numbers[i + 1];
		if (Math.abs(lat) > 90 * SCALE || Math.abs(lng) > 180 * SCALE) return null;
		points.push([lng / SCALE, lat / SCALE]);
	}
	if (points.length < 2 || points.length > MAX_SHARED_WAYPOINTS) return null;
	return { waypoints: points, name, marks: parseMarks(markText, points.length) };
}

/**
 * The marks in a link, one per point. A damaged entry is left out rather
 * than spoiling the route.
 */
function parseMarks(text, count) {
	const marks = new Array(count).fill(null);
	for (const entry of text ? text.split(",") : []) {
		const first = entry.indexOf(".");
		const second = entry.indexOf(".", first + 1);
		if (first < 1 || second < 0) continue;
		const index = Number(entry.slice(0, first));
		if (!Number.isInteger(index) || index < 0 || index >= count) continue;
		try {
			marks[index] = normalizeMark({ icon: entry.slice(first + 1, second), title: decodeURIComponent(entry.slice(second + 1)) });
		} catch {
			// A badly encoded title: the point stays plain.
		}
	}
	return marks;
}

/** One integer as its zigzagged, 5-bits-per-character text. */
function encodeNumber(number) {
	let value = number < 0 ? -number * 2 - 1 : number * 2;
	let text = "";
	do {
		const group = value % 32;
		value = Math.floor(value / 32);
		text += ALPHABET[value > 0 ? group | 32 : group];
	} while (value > 0);
	return text;
}
