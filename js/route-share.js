/**
 * Shareable route links. A planned route is shared as its name, waypoints,
 * and what they are (point-marks.js), in the URL's hash (which is never sent
 * to a server): `#r1=<points>&n=<name>&m=<marks>&s=<kinds>&p=<places>`, the
 * name, marks, kinds and places only when there are any. The receiving app routes between the points itself.
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
 *
 * <kinds> lists the points made a stop or a via point against what their
 * icon and title would make them (point-marks.js), comma-separated, each as
 * `<index>.<1 for a stop, 0 for a via point>`. Copies of the app from before
 * via points ignore it.
 *
 * <places> lists the route's places (point-marks.js), comma-separated, each
 * as `<at>.<icon>.<title>`: its [lat, lng] encoded like <points> (but not as
 * a difference from anything), then its icon and title as in <marks>.
 * Copies of the app from before places ignore it.
 */

import { normalizeMark, normalizePlace, MAX_PLACES } from "./point-marks.js";

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
 * @param {Array} [places] - The places beside the route (see point-marks.js).
 * @returns {string}
 */
export function buildShareUrl(waypoints, name = "", marks = [], places = []) {
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
	const normalized = waypoints.map((_, i) => [i, normalizeMark(marks[i])]);
	const marked = normalized
		.filter(([, mark]) => mark?.icon || mark?.title)
		.map(([i, mark]) => `${i}.${mark.icon ?? ""}.${encodeURIComponent(mark.title)}`);
	const kinds = normalized.filter(([, mark]) => typeof mark?.stop === "boolean").map(([i, mark]) => `${i}.${mark.stop ? 1 : 0}`);
	let suffix = trimmedName ? `&n=${encodeURIComponent(trimmedName)}` : "";
	if (marked.length) suffix += `&m=${marked.join(",")}`;
	if (kinds.length) suffix += `&s=${kinds.join(",")}`;
	const placed = places
		.map(normalizePlace)
		.filter(Boolean)
		.slice(0, MAX_PLACES)
		.map(({ at: [lng, lat], icon, title }) => `${encodeNumber(Math.round(lat * SCALE))}${encodeNumber(Math.round(lng * SCALE))}.${icon ?? ""}.${encodeURIComponent(title)}`);
	if (placed.length) suffix += `&p=${placed.join(",")}`;
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
 * @returns {{waypoints: Array<[number, number]>, name: string, marks: Array, places: Array}|null}
 *   `name` is `""` when the link carried none, `marks` has one entry per
 *   waypoint, null for a plain one, and `places` may be empty. Null when the hash is damaged, has fewer
 *   than two points, or has too many.
 */
export function parseShareHash(hash) {
	if (!isShareHash(hash)) return null;
	const [data, ...params] = hash.slice(PREFIX.length).split("&");
	let name = "";
	let markText = "";
	let kindText = "";
	let placeText = "";
	for (const param of params) {
		if (param.startsWith("n=")) {
			try {
				name = decodeURIComponent(param.slice(2)).trim().slice(0, MAX_SHARED_NAME_LENGTH);
			} catch {
				return null;
			}
		} else if (param.startsWith("m=")) {
			markText = param.slice(2);
		} else if (param.startsWith("s=")) {
			kindText = param.slice(2);
		} else if (param.startsWith("p=")) {
			placeText = param.slice(2);
		}
	}

	const numbers = decodeNumbers(data);
	if (!numbers || numbers.length % 2 !== 0) return null;

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
	return { waypoints: points, name, marks: parseMarks(markText, kindText, points.length), places: parsePlaces(placeText) };
}

/** The places in a link. A damaged entry is left out rather than spoiling the route. */
function parsePlaces(text) {
	const places = [];
	for (const entry of text ? text.split(",").slice(0, MAX_PLACES) : []) {
		const first = entry.indexOf(".");
		const second = entry.indexOf(".", first + 1);
		if (first < 1 || second < 0) continue;
		const numbers = decodeNumbers(entry.slice(0, first));
		if (numbers?.length !== 2) continue;
		try {
			const title = decodeURIComponent(entry.slice(second + 1));
			const place = normalizePlace({ at: [numbers[1] / SCALE, numbers[0] / SCALE], icon: entry.slice(first + 1, second), title });
			if (place) places.push(place);
		} catch {
			// A badly encoded title: the place is left out.
		}
	}
	return places;
}

/** The integers in encoded text (see `encodeNumber`), or null when it's damaged. */
function decodeNumbers(text) {
	const numbers = [];
	let value = 0;
	let shift = 0;
	for (const char of text) {
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
	return shift === 0 ? numbers : null;
}

/**
 * The marks in a link, one per point, with which are stops or via points.
 * A damaged entry is left out rather than spoiling the route.
 */
function parseMarks(text, kindText, count) {
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
	for (const entry of kindText ? kindText.split(",") : []) {
		const [indexText, kind] = entry.split(".");
		const index = Number(indexText);
		if (!Number.isInteger(index) || index < 0 || index >= count || (kind !== "0" && kind !== "1")) continue;
		marks[index] = normalizeMark({ ...(marks[index] ?? {}), stop: kind === "1" });
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
