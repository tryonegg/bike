/**
 * Shareable route links. A planned route is shared as just its waypoints,
 * in the URL's hash (which is never sent to a server): `#r1=<data>`. The
 * receiving app routes between them itself.
 *
 * <data> is the waypoints as [lat, lng] pairs at 1e-5 degrees (about a
 * meter), each as the difference from the one before, in the style of
 * Google's encoded polylines: every number is zigzagged to be non-negative
 * and split into 5-bit groups, lowest first, each written as one base64url
 * character whose top bit says another group follows. That keeps the link
 * short (about 8 characters per point) and free of anything a chat app
 * would percent-encode.
 */

const PREFIX = "#r1=";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SCALE = 1e5;
/** Most waypoints a link may carry, so a bad link can't start a huge amount of routing. */
export const MAX_SHARED_WAYPOINTS = 100;

/**
 * The link that opens a route in another copy of the app.
 * @param {Array<[number, number]>} waypoints - [lng, lat] pairs, in order.
 * @returns {string}
 */
export function buildShareUrl(waypoints) {
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
	return `${location.origin}${location.pathname}${PREFIX}${data}`;
}

/**
 * Whether a hash is a shared route link (valid or not).
 * @param {string} hash
 */
export function isShareHash(hash) {
	return hash.startsWith(PREFIX);
}

/**
 * The waypoints in a shared route hash.
 * @param {string} hash - `location.hash`.
 * @returns {Array<[number, number]>|null} [lng, lat] pairs, or null when the
 *   hash is damaged, has fewer than two points, or has too many.
 */
export function parseShareHash(hash) {
	if (!isShareHash(hash)) return null;
	const data = hash.slice(PREFIX.length);
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
	return points.length >= 2 && points.length <= MAX_SHARED_WAYPOINTS ? points : null;
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
