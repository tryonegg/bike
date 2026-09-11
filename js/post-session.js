/**
 * The post-ride summary screen: the route map (speed-colored, or the debug
 * GPS-accuracy overlay), the segment table, and the recalculation of
 * segment boundaries from a saved ride's raw points (done fresh on every
 * view rather than trusting whatever was stored, since the unit — and thus
 * the segment length — can change after a ride is saved).
 */

import { ACCURACY_UNKNOWN_COLOR } from "./constants.js";
import { state, el } from "./state.js";
import { createVectorMap, createMarkerLayer, createPointMarker, addAccuracyExtremeMarkers } from "./live-map.js";
import { findStableStartIndex, maxOf, minOf, haversineMeters, formatDistance, formatSpeed, formatElevationValue, formatDuration } from "./format.js";
import { speedBand, speedBandColor, accuracyBand, accuracyBandColor, paceColor } from "./colors.js";
import { getSegmentLengthMeters, renderSegmentMarkers, distanceUnitLabel, speedUnitLabel, segmentLabel } from "./map-visuals.js";
import { getSessionById } from "./db.js";
import { rideAvgSpeed, sessionTimeTitle } from "./history-view.js";
import { showScreen } from "./navigation.js";
import { renderElevationChart } from "./chart.js";

/**
 * Creates (replacing any existing one) the post-ride MapLibre map: the
 * route line (colored by speed band, or by GPS accuracy when the debug
 * overlay is on), start/finish markers, optional accuracy best/worst
 * markers, and recalculated distance-marker flags.
 *
 * @param {Object} session - A saved ride with a `points` array.
 */
export function initPostMap(session) {
	if (state.postMap) {
		state.postMap.remove();
		state.postMap = null;
	}

	// The highlight marker went with the map it was on.
	state.chartHighlightMarker = null;
	state.highlightedPointIndex = -1;

	const showAccuracy = state.prefs.debugGpsAccuracy;
	const clipIndex = showAccuracy && state.prefs.debugClipGpsWarmup ? findStableStartIndex(session.points) : 0;
	const routeData = showAccuracy ? buildAccuracyBandRoute(session.points, clipIndex) : buildSpeedBandRoute(session.points);
	const pointsData = showAccuracy ? buildAccuracyPointsData(session.points, clipIndex) : null;
	const bounds = routeBounds(session.points);
	const view = bounds
		? { bounds, fitBoundsOptions: { maxZoom: 17 } }
		: { center: [0, 0], zoom: 2 };

	state.postMap = createVectorMap({ container: "postMap", ...view }, (map) => {
		addPostRouteLayer(map, routeData);
		if (pointsData) addAccuracyPointsLayer(map, pointsData);
	});
	state.postMarkerLayer = createMarkerLayer(state.postMap);

	const points = session.points || [];
	if (points.length) {
		const first = points[0];
		const last = points[points.length - 1];
		// Finish first, so the start draws on top where a loop ends where it began.
		createPointMarker(state.postMap, "route-finish", [last.lng, last.lat]);
		createPointMarker(state.postMap, "route-start", [first.lng, first.lat]);
	}
	if (showAccuracy) addAccuracyExtremeMarkers(state.postMap, points, clipIndex);

	// Recalculate segment markers based on current unit settings
	const segmentMarkers = recalculateSegmentMarkers(session);
	renderSegmentMarkers(state.postMarkerLayer, segmentMarkers);
}

// One feature per speed band, not one per point pair. A two-hour ride is
// thousands of pairs; each band renders as a single multi-line, so no detail is
// lost.
/**
 * Builds the route's GeoJSON, grouped into one `MultiLineString` feature per
 * speed band (rather than one feature per point pair — a two-hour ride is
 * thousands of pairs, and batching by contiguous same-band runs keeps the
 * feature count small without losing any detail).
 *
 * @param {Array<{lat: number, lng: number, speed?: number}>} points
 * @returns {Object} GeoJSON `FeatureCollection`; each feature's `properties`
 *   carries `band` (for draw-order sorting) and `color`.
 */
function buildSpeedBandRoute(points) {
	const features = [];
	if (points.length < 2) return { type: "FeatureCollection", features };

	const maxSpeed = Math.max(maxOf(points, (p) => p.speed || 0), 0.0001);
	const bands = new Map();
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		const midSpeed = ((prev.speed || 0) + (curr.speed || 0)) / 2;
		const band = speedBand(midSpeed, maxSpeed);

		let runs = bands.get(band);
		if (!runs) {
			runs = [];
			bands.set(band, runs);
		}

		// Extend the previous run when this pair continues it, so a steady
		// stretch becomes one subpath rather than many.
		const lastRun = runs.length ? runs[runs.length - 1] : null;
		if (lastRun && lastRun.endIndex === i - 1) {
			lastRun.coords.push([curr.lng, curr.lat]);
			lastRun.endIndex = i;
		} else {
			runs.push({
				coords: [
					[prev.lng, prev.lat],
					[curr.lng, curr.lat],
				],
				endIndex: i,
			});
		}
	}

	for (const [band, runs] of bands) {
		features.push({
			type: "Feature",
			properties: { band, color: speedBandColor(band) },
			geometry: { type: "MultiLineString", coordinates: runs.map((run) => run.coords) },
		});
	}
	return { type: "FeatureCollection", features };
}

// Debug GPS accuracy overlay: same shape as buildSpeedBandRoute, but banded on
// each point's accuracy reading (in meters) rather than its speed, and scaled
// to this ride's own best and worst fixes rather than a fixed range. Points
// before clipIndex (the warm-up, when that's being clipped) draw in the same
// neutral gray as an unknown reading and are left out of the min/max range,
// so a shaky opening doesn't compress the color scale for the rest of the ride.
/**
 * Debug GPS-accuracy overlay: same shape/batching as `buildSpeedBandRoute`,
 * but banded on each point's accuracy reading (in meters) rather than its
 * speed, scaled to this ride's own best/worst fixes. Points before
 * `clipIndex` (the warm-up, when "clip GPS warm-up" is on) draw in the same
 * neutral gray as an unknown reading and are excluded from the min/max
 * range, so a shaky opening doesn't compress the color scale for the rest of
 * the ride.
 *
 * @param {Array<{lat: number, lng: number, accuracy?: number}>} points
 * @param {number} [clipIndex]
 * @returns {Object} GeoJSON `FeatureCollection`.
 */
function buildAccuracyBandRoute(points, clipIndex = 0) {
	const features = [];
	if (points.length < 2) return { type: "FeatureCollection", features };

	const known = points.filter((p, i) => i >= clipIndex && Number.isFinite(p.accuracy));
	const minAccuracy = known.length ? minOf(known, (p) => p.accuracy) : 0;
	const maxAccuracy = known.length ? maxOf(known, (p) => p.accuracy) : 0;

	const bands = new Map();
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		const clipped = i - 1 < clipIndex;
		const hasAccuracy = !clipped && Number.isFinite(prev.accuracy) && Number.isFinite(curr.accuracy);
		const band = hasAccuracy ? accuracyBand((prev.accuracy + curr.accuracy) / 2, minAccuracy, maxAccuracy) : "unknown";

		let runs = bands.get(band);
		if (!runs) {
			runs = [];
			bands.set(band, runs);
		}

		const lastRun = runs.length ? runs[runs.length - 1] : null;
		if (lastRun && lastRun.endIndex === i - 1) {
			lastRun.coords.push([curr.lng, curr.lat]);
			lastRun.endIndex = i;
		} else {
			runs.push({
				coords: [
					[prev.lng, prev.lat],
					[curr.lng, curr.lat],
				],
				endIndex: i,
			});
		}
	}

	for (const [band, runs] of bands) {
		const isUnknown = band === "unknown";
		features.push({
			type: "Feature",
			// Unknown draws first (and thus underneath), same as the worst real band.
			properties: { band: isUnknown ? -1 : band, color: isUnknown ? ACCURACY_UNKNOWN_COLOR : accuracyBandColor(band) },
			geometry: { type: "MultiLineString", coordinates: runs.map((run) => run.coords) },
		});
	}
	return { type: "FeatureCollection", features };
}

// Debug GPS accuracy overlay: one point per recorded fix, coloured the same
// way as the route line. The line's bands smooth over individual readings, so
// a gap between dots — not just a red stretch — is what shows a real dropout:
// GPS stopped delivering fixes for a while and the points simply thin out.
// One GL circle layer, not a marker per point: a long ride is thousands of
// fixes, and thousands of DOM markers would stall the map.
/**
 * Debug GPS-accuracy overlay: one GeoJSON point per recorded fix, colored
 * the same way as the route line. The line's bands smooth over individual
 * readings, so a visible gap between dots — not just a red stretch — is what
 * exposes a real dropout: GPS simply stopped delivering fixes for a while.
 * Rendered as one GL circle layer rather than a marker per point, since a
 * long ride is thousands of fixes and that many DOM markers would stall the map.
 *
 * @param {Array<{lat: number, lng: number, accuracy?: number}>} points
 * @param {number} [clipIndex]
 * @returns {Object} GeoJSON `FeatureCollection` of `Point` features.
 */
function buildAccuracyPointsData(points, clipIndex = 0) {
	const known = points.filter((p, i) => i >= clipIndex && Number.isFinite(p.accuracy));
	const minAccuracy = known.length ? minOf(known, (p) => p.accuracy) : 0;
	const maxAccuracy = known.length ? maxOf(known, (p) => p.accuracy) : 0;

	return {
		type: "FeatureCollection",
		features: points.map((point, i) => {
			const hasAccuracy = i >= clipIndex && Number.isFinite(point.accuracy);
			const color = hasAccuracy ? accuracyBandColor(accuracyBand(point.accuracy, minAccuracy, maxAccuracy)) : ACCURACY_UNKNOWN_COLOR;
			return {
				type: "Feature",
				properties: { color },
				geometry: { type: "Point", coordinates: [point.lng, point.lat] },
			};
		}),
	};
}

/**
 * Adds the post-ride route's two layers: a white/black casing (to lift the
 * colored line off busy map tiles) and the colored line itself, sorted so
 * slower bands draw first and faster stretches stay visible where a route
 * crosses itself.
 *
 * @param {maplibregl.Map} map
 * @param {Object} routeData - From `buildSpeedBandRoute` or `buildAccuracyBandRoute`.
 */
function addPostRouteLayer(map, routeData) {
	map.addSource("post-route", { type: "geojson", data: routeData });
	// A casing under the coloured line lifts it off busy tiles.
	const dark = state.prefs.theme === "dark";
	map.addLayer({
		id: "post-route-casing",
		type: "line",
		source: "post-route",
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": dark ? "#000000" : "#ffffff",
			"line-opacity": dark ? 0.45 : 0.85,
			"line-width": 10,
		},
	});
	map.addLayer({
		id: "post-route",
		type: "line",
		source: "post-route",
		layout: {
			"line-cap": "round",
			"line-join": "round",
			// Slower bands draw first so the faster stretches stay visible where a
			// route crosses itself.
			"line-sort-key": ["get", "band"],
		},
		paint: { "line-color": ["get", "color"], "line-width": 5 },
	});
}

// Debug GPS accuracy overlay: the per-point dots, drawn over the route line
// so they read as individual fixes rather than blending back into the band
// they sit on.
/**
 * Adds the debug GPS-accuracy overlay's per-point dot layer, drawn over the
 * route line so the dots read as individual fixes rather than blending back
 * into the band they sit on.
 *
 * @param {maplibregl.Map} map
 * @param {Object} pointsData - From `buildAccuracyPointsData`.
 */
function addAccuracyPointsLayer(map, pointsData) {
	const dark = state.prefs.theme === "dark";
	map.addSource("post-accuracy-points", { type: "geojson", data: pointsData });
	map.addLayer({
		id: "post-accuracy-points",
		type: "circle",
		source: "post-accuracy-points",
		paint: {
			"circle-radius": 3,
			"circle-color": ["get", "color"],
			"circle-stroke-width": 1,
			"circle-stroke-color": dark ? "#000000" : "#ffffff",
		},
	});
}

/**
 * The route's bounding box, padded 12% on every side so the route never
 * touches the map edge.
 *
 * @param {Array<{lat: number, lng: number}>} points
 * @returns {[[number, number], [number, number]]|null} `[[west, south],
 *   [east, north]]`, or `null` for an empty route.
 */
function routeBounds(points) {
	if (!points.length) return null;
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const point of points) {
		west = Math.min(west, point.lng);
		east = Math.max(east, point.lng);
		south = Math.min(south, point.lat);
		north = Math.max(north, point.lat);
	}
	const padLng = (east - west) * 0.12;
	const padLat = (north - south) * 0.12;
	return [
		[west - padLng, south - padLat],
		[east + padLng, north + padLat],
	];
}

/**
 * Recomputes where each segment (mile/km) boundary falls along a saved
 * ride's route, in the current display unit, and returns the marker
 * position for each — the nearest recorded point to each boundary. Done
 * fresh on every view rather than trusting stored markers, since a unit
 * change after the ride was saved would otherwise leave stale marker
 * positions on screen.
 *
 * @param {Object} session
 * @returns {Array<{lat: number, lng: number, segmentNumber: number}>}
 */
export function recalculateSegmentMarkers(session) {
	if (!session.points || !session.points.length) return [];

	const segmentMarkers = [];
	const stepDistance = getSegmentLengthMeters(state.prefs.unit);

	// Calculate cumulative distance for each point
	let cumulativeDistance = 0;
	const pointDistances = session.points.map((point, index) => {
		if (index > 0) {
			const prev = session.points[index - 1];
			cumulativeDistance += haversineMeters(prev.lat, prev.lng, point.lat, point.lng);
		}
		return cumulativeDistance;
	});

	// Find segment boundaries and nearest points
	let nextSegmentDistance = stepDistance;
	let segmentNumber = 1;

	for (let i = 1; i < pointDistances.length; i++) {
		const distance = pointDistances[i];

		while (distance >= nextSegmentDistance) {
			// Find the closest point to this segment boundary
			let closestIndex = i - 1;
			let closestDelta = Math.abs(pointDistances[i - 1] - nextSegmentDistance);

			for (let j = Math.max(0, i - 5); j < i; j++) {
				const delta = Math.abs(pointDistances[j] - nextSegmentDistance);
				if (delta < closestDelta) {
					closestDelta = delta;
					closestIndex = j;
				}
			}

			const point = session.points[closestIndex];
			segmentMarkers.push({
				lat: point.lat,
				lng: point.lng,
				segmentNumber,
			});

			segmentNumber++;
			nextSegmentDistance += stepDistance;
		}
	}

	return segmentMarkers;
}

// Wall-clock span between two point timestamps with any paused portion removed.
// getElapsedMs() already defines the headline moving time this way, so segment
// durations have to be measured the same way or the table will not sum to it.
/**
 * Wall-clock span between two point timestamps with any paused portion
 * removed. `getElapsedMs()` in live-session.js already defines the headline
 * moving time this way, so segment durations have to be measured the same
 * way or the segment table wouldn't sum back up to it.
 *
 * @param {number} startMs
 * @param {number} endMs
 * @param {Array<{start: number, end?: number}>} pauses
 * @returns {number} Milliseconds.
 */
function movingMsBetween(startMs, endMs, pauses) {
	let pausedMs = 0;
	for (const pause of pauses) {
		const overlapStart = Math.max(startMs, pause.start);
		const overlapEnd = Math.min(endMs, pause.end ?? endMs);
		if (overlapEnd > overlapStart) pausedMs += overlapEnd - overlapStart;
	}
	return Math.max(0, endMs - startMs - pausedMs);
}

/**
 * Recomputes the segment table's rows (duration + average speed per
 * segment) from a saved ride's raw points, in the current display unit.
 * Always ends with one trailing "partial" segment for whatever distance
 * remains past the last full boundary — without it, a ride that (almost
 * always) doesn't end exactly on a segment boundary would silently drop that
 * last stretch and the table wouldn't add up to the headline moving time.
 *
 * @param {Object} session
 * @returns {Array<{segmentNumber: number, duration: number, avgSpeed: number,
 *   partial?: boolean, distance?: number}>}
 */
function recalculateSegments(session) {
	if (!session.points || !session.points.length) return [];

	const segments = [];
	const stepDistance = getSegmentLengthMeters(state.prefs.unit);
	const pauses = Array.isArray(session.pauses) ? session.pauses : [];

	// Calculate cumulative distance and time for each point
	let cumulativeDistance = 0;
	let cumulativeTime = 0;
	const pointData = session.points.map((point, index) => {
		if (index > 0) {
			const prev = session.points[index - 1];
			cumulativeDistance += haversineMeters(prev.lat, prev.lng, point.lat, point.lng);
			cumulativeTime += movingMsBetween(prev.timestamp, point.timestamp, pauses);
		}
		return {
			distance: cumulativeDistance,
			time: cumulativeTime,
		};
	});

	// Find segment boundaries
	let nextSegmentDistance = stepDistance;
	let segmentNumber = 1;
	let segmentStartTime = 0;

	for (let i = 1; i < pointData.length; i++) {
		const data = pointData[i];

		while (data.distance >= nextSegmentDistance) {
			// Calculate time and average speed for this segment
			const segmentTime = data.time - segmentStartTime;
			const segmentAvgSpeed = segmentTime > 0 ? stepDistance / (segmentTime / 1000) : 0; // m/s

			segments.push({
				segmentNumber,
				duration: segmentTime,
				avgSpeed: segmentAvgSpeed,
			});

			segmentNumber++;
			segmentStartTime = data.time;
			nextSegmentDistance += stepDistance;
		}
	}

	// A ride almost never ends on a boundary. Without this row the table silently
	// drops the last stretch and never adds up to the headline moving time.
	const last = pointData[pointData.length - 1];
	const partialDistance = last.distance - (nextSegmentDistance - stepDistance);
	if (partialDistance > 1) {
		const segmentTime = last.time - segmentStartTime;
		segments.push({
			segmentNumber,
			duration: segmentTime,
			avgSpeed: segmentTime > 0 ? partialDistance / (segmentTime / 1000) : 0,
			partial: true,
			distance: partialDistance,
		});
	}

	return segments;
}

/**
 * Opens the post-ride summary screen for a saved ride: loads it (unless the
 * caller already has the record), renders the summary text and segment
 * table, switches screens and updates browser history, then builds the map
 * and elevation chart.
 *
 * @param {number} sessionId - Ignored if `sessionData` is given.
 * @param {Object|null} [sessionData] - Pass the session directly (e.g.
 *   right after `finalizeSession`) to skip an IndexedDB round-trip.
 * @param {"push"|"replace"|string} [mode] - History mode; anything other
 *   than `"push"`/`"replace"` updates the screen without touching history
 *   (used when the browser's own back/forward navigation already did).
 * @returns {Promise<void>}
 */
export async function openPostSession(sessionId, sessionData = null, mode = "push") {
	const session = sessionData || (await getSessionById(sessionId));
	if (!session) return;

	state.currentPostSession = session;
	renderPostSummary(session);
	showScreen("post");
	if (mode === "replace") {
		history.replaceState({ screen: "post", sessionId: session.id }, "");
	} else if (mode === "push") {
		history.pushState({ screen: "post", sessionId: session.id }, "");
	}
	initPostMap(session);
	renderElevationChart(session);
}

/**
 * Renders the post-ride summary screen's text stats (date, title, distance,
 * speeds, time, elevation gain/drop) and the segment table.
 *
 * @param {Object} session
 */
export function renderPostSummary(session) {
	const unit = state.prefs.unit;
	const date = new Date(session.date);

	el.postDate.textContent = Number.isNaN(date.getTime())
		? "Unknown date"
		: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
	el.postTitle.textContent = sessionTimeTitle(session, date);

	el.postDistance.textContent = formatDistance(session.totalDistance || 0, unit);
	el.postDistanceUnit.textContent = distanceUnitLabel(unit);
	el.postAvgSpeed.textContent = formatSpeed(rideAvgSpeed(session), unit);
	el.postTime.textContent = formatDuration(session.movingTime || 0);
	el.postMaxSpeed.textContent = formatSpeed(session.maxSpeed || 0, unit);
	el.postSpeedUnit.textContent = speedUnitLabel(unit);
	el.postAvgSpeedUnit.textContent = speedUnitLabel(unit);

	const elevationUnit = unit === "imperial" ? "ft" : "m";
	el.postGain.textContent = formatElevationValue(session.elevationGain || 0, unit);
	el.postDrop.textContent = formatElevationValue(session.elevationDrop || 0, unit);
	el.postGainUnit.textContent = elevationUnit;
	el.postDropUnit.textContent = elevationUnit;

	el.chartStartLabel.textContent = `0 ${distanceUnitLabel(unit)}`;
	el.chartEndLabel.textContent = `${formatDistance(session.totalDistance || 0, unit)} ${distanceUnitLabel(unit)}`;

	renderSegmentRows(recalculateSegments(session));
}

// Bar length is the segment's speed against the fastest one; its colour places
// it between the ride's slowest and fastest segments.
/**
 * Renders the segment table's rows. Each row's bar length is that segment's
 * speed against the fastest segment; its color places it between the ride's
 * slowest and fastest segments (the same red-to-green pace scale used
 * elsewhere in the app).
 *
 * @param {Array<Object>} segments - From `recalculateSegments`.
 */
function renderSegmentRows(segments) {
	const unit = state.prefs.unit;
	el.segmentsSpeedHeader.textContent = speedUnitLabel(unit);
	el.segmentsBody.innerHTML = "";

	const speeds = segments.map((seg) => seg.avgSpeed);
	const fastest = Math.max(...speeds, 0.0001);
	const slowest = Math.min(...speeds);

	for (const seg of segments) {
		const tr = document.createElement("tr");

		const name = document.createElement("td");
		name.className = seg.partial ? "seg-name partial" : "seg-name";
		name.textContent = seg.partial
			? `${formatDistance(seg.distance, unit)} ${distanceUnitLabel(unit)}`
			: segmentLabel(seg.segmentNumber, unit);

		const pace = document.createElement("td");
		const track = document.createElement("div");
		track.className = "pace-track";
		const fill = document.createElement("div");
		fill.className = "pace-fill";
		fill.style.width = `${Math.max(2, (seg.avgSpeed / fastest) * 100).toFixed(1)}%`;
		fill.style.background = paceColor(fastest - slowest > 0.01 ? (seg.avgSpeed - slowest) / (fastest - slowest) : 1);
		track.appendChild(fill);
		pace.appendChild(track);

		const time = document.createElement("td");
		time.className = "num seg-time";
		time.textContent = formatDuration(seg.duration);

		const speed = document.createElement("td");
		speed.className = "num seg-speed";
		speed.textContent = formatSpeed(seg.avgSpeed, unit);

		tr.append(name, pace, time, speed);
		el.segmentsBody.appendChild(tr);
	}
}
