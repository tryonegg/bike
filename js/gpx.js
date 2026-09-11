/**
 * Single-ride GPX interchange: exporting the currently-viewed ride as a
 * `.gpx` file, and importing a `.gpx` file (from any source — another
 * device, a different tracking app) as a new saved ride, including deriving
 * speed from consecutive points since GPX files rarely carry it themselves.
 */

import { ACTIVITIES } from "./constants.js";
import { state, el } from "./state.js";
import { confirmWithModal, showMessage } from "./modal.js";
import { haversineMeters } from "./format.js";
import { addSession } from "./db.js";
import { renderPastRides } from "./history-view.js";

/**
 * The post-ride summary screen's "Export GPX" button handler: downloads the
 * currently-viewed ride as a `.gpx` file.
 */
export function exportCurrentGpx() {
	const session = state.currentPostSession;
	if (!session || !session.points?.length) return;

	const gpx = buildGpx(session);
	const blob = new Blob([gpx], { type: "application/gpx+xml" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");

	a.href = url;
	a.download = `bike-ride-${new Date(session.date).toISOString().replace(/[:.]/g, "-")}.gpx`;
	a.click();

	URL.revokeObjectURL(url);
}

/**
 * Serializes a ride's points as GPX 1.1 XML.
 *
 * @param {Object} session
 * @returns {string} A complete `.gpx` document.
 */
function buildGpx(session) {
	const trkpts = session.points
		.map((p) => {
			const ele = Number.isFinite(p.altitude) ? `<ele>${p.altitude.toFixed(1)}</ele>` : "";
			return `<trkpt lat="${p.lat}" lon="${p.lng}">${ele}<time>${new Date(p.timestamp).toISOString()}</time></trkpt>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Tracker" xmlns="http://www.topografix.com/GPX/1/1">
	<trk>
		<name>Bike Ride ${new Date(session.date).toLocaleString()}</name>
		<trkseg>
			${trkpts}
		</trkseg>
	</trk>
</gpx>`;
}

/**
 * The hidden file input's `change` handler for GPX import: parses the file,
 * confirms with the rider, derives every summary stat (distance, moving
 * time, speeds, elevation gain/drop) from the raw points the same way a live
 * ride would accumulate them, and saves it as a new ride.
 *
 * @param {Event} event - A `change` event on `el.importGpxFileInput`.
 * @returns {Promise<void>}
 */
export async function importGpxSession(event) {
	const file = event.target.files[0];
	if (!file) return;

	try {
		const text = await file.text();
		const { points, activityType } = buildSessionFromGpx(text);

		const confirmed = await confirmWithModal({
			title: "Import GPX Ride",
			message: `Import a ${ACTIVITIES[activityType].noun} with ${points.length} point(s)?`,
			confirmText: "Import",
			cancelText: "Cancel",
		});

		el.importGpxFileInput.value = "";

		if (!confirmed) return;

		const totalDistance = points.reduce((sum, p, i) => {
			if (i === 0) return 0;
			return sum + haversineMeters(points[i - 1].lat, points[i - 1].lng, p.lat, p.lng);
		}, 0);
		const movingTime = Math.max(0, points[points.length - 1].timestamp - points[0].timestamp);
		const maxSpeed = points.reduce((max, p) => Math.max(max, p.speed), 0);

		let elevationGain = 0;
		let elevationDrop = 0;
		const altitudeSamples = [];
		let smoothAltitudePrev = null;
		for (const p of points) {
			if (!Number.isFinite(p.altitude)) continue;
			altitudeSamples.push(p.altitude);
			if (altitudeSamples.length > 5) altitudeSamples.shift();
			const smooth = altitudeSamples.reduce((sum, v) => sum + v, 0) / altitudeSamples.length;
			if (smoothAltitudePrev != null) {
				const delta = smooth - smoothAltitudePrev;
				if (delta > 0) elevationGain += delta;
				if (delta < 0) elevationDrop += Math.abs(delta);
			}
			smoothAltitudePrev = smooth;
		}

		const session = {
			date: new Date(points[0].timestamp).toISOString(),
			unit: state.prefs.unit,
			activityType,
			keepScreenOn: false,
			points,
			totalDistance,
			movingTime,
			maxSpeed,
			avgSpeed: movingTime > 0 ? totalDistance / (movingTime / 1000) : 0,
			elevationGain,
			elevationDrop,
			segments: [],
			segmentMarkers: [],
			pauses: [],
		};

		const id = await addSession(session);
		session.id = id;
		await renderPastRides();
		await showMessage("Import Success", "The ride has been imported.");
	} catch (error) {
		el.importGpxFileInput.value = "";
		await showMessage("Import Error", `Failed to import GPX file: ${error.message}`);
	}
}

// Parses a GPX file into track points shaped like a live-recorded session's,
// deriving per-point speed from consecutive distance/time since GPX rarely
// carries speed itself. Points without a <time> get one synthesised a second
// apart so moving time and speed can still be computed.
/**
 * Parses raw GPX XML into track points shaped like a live-recorded session's
 * (`lat`/`lng`/`altitude`/`speed`/`accuracy`/`timestamp`), deriving per-point
 * speed from consecutive distance/time since GPX rarely carries speed
 * itself. Points without a `<time>` get one synthesized a second apart, so
 * moving time and speed can still be computed for a file that has none.
 *
 * @param {string} text - Raw file contents.
 * @returns {{points: Array<Object>, activityType: string}}
 * @throws {Error} If the XML doesn't parse, or no usable track points are found.
 */
function buildSessionFromGpx(text) {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	if (doc.querySelector("parsererror")) {
		throw new Error("The file is not a valid GPX file.");
	}

	const nodes = Array.from(doc.getElementsByTagName("trkpt"));
	const source = nodes.length ? nodes : Array.from(doc.getElementsByTagName("rtept"));
	if (!source.length) {
		throw new Error("No track points found in this GPX file.");
	}

	const raw = source
		.map((node) => {
			const lat = parseFloat(node.getAttribute("lat"));
			const lng = parseFloat(node.getAttribute("lon"));
			const eleNode = node.getElementsByTagName("ele")[0];
			const altitude = eleNode ? parseFloat(eleNode.textContent) : NaN;
			const timeNode = node.getElementsByTagName("time")[0];
			const timestamp = timeNode ? new Date(timeNode.textContent).getTime() : NaN;
			return {
				lat,
				lng,
				altitude: Number.isFinite(altitude) ? altitude : null,
				timestamp: Number.isFinite(timestamp) ? timestamp : null,
			};
		})
		.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

	if (!raw.length) {
		throw new Error("No valid track points found in this GPX file.");
	}

	if (raw.some((p) => p.timestamp != null)) {
		let last = raw.find((p) => p.timestamp != null).timestamp;
		for (const p of raw) {
			if (p.timestamp == null) p.timestamp = last;
			last = p.timestamp;
		}
		raw.sort((a, b) => a.timestamp - b.timestamp);
	} else {
		const base = Date.now() - (raw.length - 1) * 1000;
		raw.forEach((p, i) => {
			p.timestamp = base + i * 1000;
		});
	}

	const speeds = smoothedGpxSpeeds(raw);
	const points = raw.map((p, index) => ({
		lat: p.lat,
		lng: p.lng,
		altitude: p.altitude,
		speed: speeds[index],
		accuracy: null,
		timestamp: p.timestamp,
	}));

	const typeNode = doc.getElementsByTagName("type")[0];
	const activityType = inferActivityType(typeNode ? typeNode.textContent : "");

	return { points, activityType };
}

// GPX timestamps are commonly only second-precision, so consecutive points
// often land on the same second (implying zero speed) followed by one that
// jumps two seconds' worth of distance at once (implying double speed).
// Speed per point, used only for the route/chart's slow-to-fast colouring,
// is instead the distance covered over a trailing several-second window,
// which rides out that jitter the way a device's own GPS speed already does.
const GPX_SPEED_WINDOW_MS = 6000;

/**
 * Derives a speed for every point from a trailing distance/time window
 * rather than the immediately preceding point pair. GPX timestamps are
 * commonly only second-precision, so consecutive points often land on the
 * same second (implying zero speed) followed by one that jumps two seconds'
 * worth of distance at once (implying double speed); a several-second
 * trailing window rides out that jitter the way a device's own GPS speed
 * already does.
 *
 * @param {Array<{lat: number, lng: number, timestamp: number}>} points -
 *   Sorted by timestamp.
 * @returns {number[]} One speed (meters/second) per point, `0` for the first.
 */
function smoothedGpxSpeeds(points) {
	const speeds = new Array(points.length).fill(0);
	let windowStart = 0;
	let windowDistance = 0;

	for (let i = 1; i < points.length; i++) {
		windowDistance += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);

		while (windowStart < i - 1 && points[i].timestamp - points[windowStart].timestamp > GPX_SPEED_WINDOW_MS) {
			windowDistance -= haversineMeters(
				points[windowStart].lat,
				points[windowStart].lng,
				points[windowStart + 1].lat,
				points[windowStart + 1].lng,
			);
			windowStart++;
		}

		const windowSeconds = (points[i].timestamp - points[windowStart].timestamp) / 1000;
		speeds[i] = windowSeconds > 0 ? windowDistance / windowSeconds : 0;
	}

	return speeds;
}

/**
 * Guesses the app's activity type from a GPX file's free-text `<type>`
 * element.
 *
 * @param {string} typeText
 * @returns {"hike"|"kayak"|"walk"|"bike"} Defaults to "bike" when nothing matches.
 */
function inferActivityType(typeText) {
	const t = (typeText || "").toLowerCase();
	if (t.includes("hik")) return "hike";
	if (t.includes("kayak") || t.includes("paddle") || t.includes("canoe")) return "kayak";
	if (t.includes("run") || t.includes("walk")) return "walk";
	return "bike";
}
