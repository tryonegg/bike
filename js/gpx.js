/**
 * GPX interchange: exporting the currently-viewed ride, or a planned route,
 * as a `.gpx` file, and importing a `.gpx` or `.fit` file (from any source —
 * another device, a different tracking app, Zwift; fit.js reads FIT) as a
 * new saved ride, including deriving
 * speed from consecutive points since GPX files rarely carry it themselves.
 */

import { ACTIVITIES } from "./constants.js";
import { state, el } from "./state.js";
import { confirmWithModal, showMessage } from "./modal.js";
import { haversineMeters, escapeHtml, formatDistance, addAltitudeReading } from "./format.js";
import { turnInstruction } from "./route-steps.js";
import { POINT_ICONS, markAt, isStop, pointName, placesOf, placeName } from "./point-marks.js";

// Each turn as a GPX waypoint's symbol and type, in the words Garmin and
// Ride with GPS cue sheets use, which other apps tend to follow.
const TURN_SYMBOLS = {
	left: "Left",
	right: "Right",
	"slight-left": "Slight Left",
	"slight-right": "Slight Right",
	"sharp-left": "Sharp Left",
	"sharp-right": "Sharp Right",
	uturn: "U Turn",
};
const TURN_TYPES = new Set(Object.values(TURN_SYMBOLS).map((symbol) => symbol.toLowerCase()));

/**
 * Whether a GPX `<wpt>` is a turn cue (as `exportRouteGpx` writes them, or
 * another app's cue sheet), rather than a point to ride to.
 * @param {Element} node
 * @returns {boolean}
 */
export function isTurnCue(node) {
	const type = node.getElementsByTagName("type")[0]?.textContent.trim().toLowerCase();
	return Boolean(type) && TURN_TYPES.has(type);
}
import { addSession } from "./db.js";
import { protectStoredData } from "./pwa.js";
import { renderPastRides } from "./history-view.js";
import { isFitFile, buildSessionFromFit } from "./fit.js";

/**
 * The post-ride summary screen's "Export GPX" button handler: downloads the
 * currently-viewed ride as a `.gpx` file.
 */
export function exportCurrentGpx() {
	const session = state.currentPostSession;
	if (!session || !session.points?.length) return;

	downloadGpx(buildGpx(session), `bike-ride-${new Date(session.date).toISOString().replace(/[:.]/g, "-")}.gpx`);
}

/**
 * Downloads a planned route (see route-plan.js) as a `.gpx` file: one track
 * following the whole route, which bike computers and other apps take as a
 * course to follow; a waypoint for each stop given an icon or title, or made
 * a stop, in the planner (point-marks.js; the title, or else the icon's name,
 * as its name, and the icon as its symbol and type), via points being left
 * to the track; a waypoint for each place beside the route (likewise, but
 * described as off the route); and a waypoint at each turn (its
 * instruction as the name, its symbol and type the turn, and how far along
 * the route it is in the description), which they take as cues or course
 * points. It has no times or elevations, since it hasn't been ridden yet.
 *
 * @param {Object} route
 * @param {Array<Object>} [steps] - Its turn-by-turn steps (route-steps.js).
 */
export function exportRouteGpx(route, steps = []) {
	if (!route || route.coords.length < 2) return;
	const name = route.name || "Planned route";
	const unit = state.prefs.unit;
	const unitLabel = unit === "imperial" ? "mi" : "km";
	const stops = route.waypoints.flatMap(([lng, lat], i) => {
		const mark = markAt(route, i);
		if (!mark || !isStop(route, i)) return [];
		const icon = mark.icon ? POINT_ICONS[mark.icon] : null;
		const name = escapeHtml(pointName(route, i));
		return [
			[
				`<wpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`,
				`<name>${name}</name>`,
				`<desc>${icon && mark.title ? `${escapeHtml(icon.label)}: ` : ""}${name} (point ${i + 1})</desc>`,
				`<sym>${escapeHtml(icon?.gpx ?? "Flag, Blue")}</sym>`,
				icon ? `<type>${escapeHtml(icon.label)}</type>` : "",
				`</wpt>`,
			].join(""),
		];
	});
	const beside = placesOf(route).map((place) => {
		const [lng, lat] = place.at;
		const icon = place.icon ? POINT_ICONS[place.icon] : null;
		const name = escapeHtml(placeName(place));
		return [
			`<wpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`,
			`<name>${name}</name>`,
			`<desc>${icon && place.title ? `${escapeHtml(icon.label)}: ` : ""}${name} (off route)</desc>`,
			`<sym>${escapeHtml(icon?.gpx ?? "Pin, Blue")}</sym>`,
			icon ? `<type>${escapeHtml(icon.label)}</type>` : "",
			`</wpt>`,
		].join("");
	});
	const turns = steps
		.filter((step) => step.turn !== "arrive")
		.map((step, i) => {
			const [lng, lat] = step.point;
			const text = escapeHtml(turnInstruction(step));
			const symbol = TURN_SYMBOLS[step.turn];
			return [
				`<wpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`,
				`<name>${text}</name>`,
				`<cmt>${text}</cmt>`,
				`<desc>${i + 1}. ${text} at ${formatDistance(step.along, unit)} ${unitLabel}</desc>`,
				`<sym>${symbol}</sym>`,
				`<type>${symbol}</type>`,
				`</wpt>`,
			].join("");
		});
	const trkpts = route.coords.map(([lng, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`).join("\n\t\t\t");
	const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Tracker" xmlns="http://www.topografix.com/GPX/1/1">
	<metadata>
		<name>${escapeHtml(name)}</name>
	</metadata>${[...stops, ...beside, ...turns].map((wpt) => `\n\t${wpt}`).join("")}
	<trk>
		<name>${escapeHtml(name)}</name>
		<trkseg>
			${trkpts}
		</trkseg>
	</trk>
</gpx>`;
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "route";
	downloadGpx(gpx, `${slug}.gpx`);
}

/** Saves GPX text as a file through a temporary download link. */
function downloadGpx(gpx, filename) {
	const blob = new Blob([gpx], { type: "application/gpx+xml" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");

	a.href = url;
	a.download = filename;
	a.click();

	// Not at once: some browsers (Safari) cancel a download whose URL is gone.
	setTimeout(() => URL.revokeObjectURL(url), 10000);
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
 * The hidden file input's `change` handler for ride import: reads a GPX or
 * FIT file (told apart by FIT's ".FIT" header, not the file name), confirms
 * with the rider, and saves it as a new ride. Summary stats (distance,
 * moving time, speeds, elevation gain/drop) are derived from the raw points
 * the same way a live ride would accumulate them, except where a FIT file
 * carries the device's own totals, which are kept so the ride matches what
 * the rider saw there. A virtual ride (Zwift, say) is saved with
 * `virtual: true`.
 *
 * @param {Event} event - A `change` event on `el.importGpxFileInput`.
 * @returns {Promise<void>}
 */
export async function importRideFile(event) {
	const file = event.target.files[0];
	if (!file) return;

	try {
		const buffer = await file.arrayBuffer();
		const fit = isFitFile(buffer);
		const ride = fit ? rideFromFit(buffer) : rideFromGpx(new TextDecoder().decode(buffer));
		const noun = `${ride.virtual ? "virtual " : ""}${ACTIVITIES[ride.activityType].noun}`;

		const confirmed = await confirmWithModal({
			title: fit ? "Import FIT Ride" : "Import GPX Ride",
			message: `Import a ${noun} with ${ride.points.length} point(s)?`,
			confirmText: "Import",
			cancelText: "Cancel",
		});

		el.importGpxFileInput.value = "";

		if (!confirmed) return;

		const session = {
			date: new Date(ride.points[0].timestamp).toISOString(),
			unit: state.prefs.unit,
			activityType: ride.activityType,
			keepScreenOn: false,
			points: ride.points,
			totalDistance: ride.totalDistance,
			movingTime: ride.movingTime,
			maxSpeed: ride.maxSpeed,
			avgSpeed: ride.avgSpeed,
			elevationGain: ride.elevationGain,
			elevationDrop: ride.elevationDrop,
			segments: [],
			segmentMarkers: [],
			pauses: ride.pauses,
		};
		if (ride.virtual) session.virtual = true;

		const id = await addSession(session);
		session.id = id;
		protectStoredData();
		await renderPastRides();
		await showMessage("Import Success", "The ride has been imported.");
	} catch (error) {
		el.importGpxFileInput.value = "";
		await showMessage("Import Error", `Failed to import the file: ${error.message}`);
	}
}

/**
 * A ride's totals worked out from its points, as a live ride accumulates
 * them: moving time is first to last point less any pauses.
 *
 * @param {Array<Object>} points - Sorted by timestamp, each with a speed.
 * @param {Array<{start: number, end: number}>} [pauses]
 * @returns {{totalDistance: number, movingTime: number, maxSpeed: number, avgSpeed: number, elevationGain: number, elevationDrop: number}}
 */
function totalsFromPoints(points, pauses = []) {
	const totalDistance = points.reduce((sum, p, i) => {
		if (i === 0) return 0;
		return sum + haversineMeters(points[i - 1].lat, points[i - 1].lng, p.lat, p.lng);
	}, 0);
	const paused = pauses.reduce((sum, pause) => sum + Math.max(0, pause.end - pause.start), 0);
	const movingTime = Math.max(0, points[points.length - 1].timestamp - points[0].timestamp - paused);
	const maxSpeed = points.reduce((max, p) => Math.max(max, p.speed), 0);

	const climb = { altitudeSamples: [], smoothAltitudePrev: null, elevationGain: 0, elevationDrop: 0 };
	for (const p of points) addAltitudeReading(climb, p.altitude);

	return {
		totalDistance,
		movingTime,
		maxSpeed,
		avgSpeed: movingTime > 0 ? totalDistance / (movingTime / 1000) : 0,
		elevationGain: climb.elevationGain,
		elevationDrop: climb.elevationDrop,
	};
}

/** A GPX file as a ride ready to save: its points, activity and totals. */
function rideFromGpx(text) {
	const { points, activityType } = buildSessionFromGpx(text);
	return { points, activityType, virtual: false, pauses: [], ...totalsFromPoints(points) };
}

/**
 * A FIT file as a ride ready to save. Points without the device's speed get
 * one derived as for GPX, and any total the device didn't record is worked
 * out from the points.
 */
function rideFromFit(buffer) {
	const { points, pauses, activityType, virtual, totals } = buildSessionFromFit(buffer);
	if (points.some((p) => p.speed == null)) {
		const derived = smoothedGpxSpeeds(points);
		points.forEach((p, i) => {
			if (p.speed == null) p.speed = derived[i];
		});
	}
	const ride = { ...totalsFromPoints(points, pauses), ...totals };
	if (totals.avgSpeed == null) ride.avgSpeed = ride.movingTime > 0 ? ride.totalDistance / (ride.movingTime / 1000) : 0;
	return { points, pauses, activityType, virtual, ...ride };
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
