/**
 * Visual configuration shared by the live and post-ride maps: unit/segment
 * labels, distance-marker sizing, the guide-line color scheme, and the
 * `applyMapVisualPrefs` entry point that re-applies all of it after a
 * settings change.
 */

import { METERS_PER_MILE, METERS_PER_KM, MAP_STYLE_NAMES, BLACK_ROAD_MAP_TYPES } from "./constants.js";
import { state, el } from "./state.js";
import { escapeHtml, formatDistance } from "./format.js";
import { applyLiveGuideStyle, styleGuideLabel, updateGuideLabel, rideLineStyle } from "./live-map.js";
import { renderPostSegmentMarkers } from "./post-session.js";

/**
 * The distance covered by one segment/mile-marker, in meters.
 *
 * @param {"imperial"|"metric"} unit
 * @returns {number} `METERS_PER_MILE` or `METERS_PER_KM`.
 */
export function getSegmentLengthMeters(unit) {
	return unit === "imperial" ? METERS_PER_MILE : METERS_PER_KM;
}

/** @param {"imperial"|"metric"} unit @returns {string} "mi" or "km". */
export function distanceUnitLabel(unit) {
	return unit === "imperial" ? "mi" : "km";
}

/** @param {"imperial"|"metric"} unit @returns {string} "mph" or "km/h". */
export function speedUnitLabel(unit) {
	return unit === "imperial" ? "mph" : "km/h";
}

/**
 * Label for a segment-table row.
 *
 * @param {number} number - 1-based segment number.
 * @param {"imperial"|"metric"} unit
 * @returns {string} e.g. "Mile 3" or "Km 3".
 */
export function segmentLabel(number, unit) {
	return unit === "imperial" ? `Mile ${number}` : `Km ${number}`;
}

/**
 * Label for a distance-marker flag on the map.
 *
 * @param {number} number - 1-based segment number.
 * @param {"imperial"|"metric"} unit
 * @returns {string} e.g. "3 mi" or "3 km".
 */
export function segmentDistanceLabel(number, unit) {
	return unit === "imperial" ? `${number} mi` : `${number} km`;
}

/**
 * Builds the DOM element for one distance-marker flag on the map.
 *
 * MapLibre markers anchor on their element's centre, so the flag sits
 * centred on the point where the segment ended.
 *
 * @param {string} label - Pre-formatted text (see `segmentDistanceLabel`).
 * @param {"small"|"medium"|"large"} [markerSizeValue] - Defaults to the
 *   current pref.
 * @returns {HTMLDivElement} Wrapper element ready to pass to a MapLibre `Marker`.
 */
export function createSegmentMarkerElement(label, markerSizeValue = state.prefs.markerSize) {
	const markerSize = getMarkerSizeConfig(markerSizeValue);
	const wrapper = document.createElement("div");
	wrapper.className = "segment-flag-wrapper";
	wrapper.style.width = `${markerSize.iconSize[0]}px`;
	wrapper.style.height = `${markerSize.iconSize[1]}px`;
	wrapper.innerHTML = `<div class="segment-flag-marker ${markerSize.className}"><span>${escapeHtml(label)}</span></div>`;
	return wrapper;
}

/**
 * Resolves the "small"/"medium"/"large" marker-size pref to its CSS class
 * name and pixel footprint.
 *
 * @param {string} size - Any value; anything other than "small"/"large" is
 *   treated as "medium".
 * @returns {{className: string, iconSize: [number, number]}}
 */
export function getMarkerSizeConfig(size) {
	if (size === "small") {
		return {
			className: "small",
			iconSize: [56, 28],
		};
	}

	if (size === "large") {
		return {
			className: "large",
			iconSize: [88, 40],
		};
	}

	return {
		className: "medium",
		iconSize: [72, 34],
	};
}

/**
 * Resolves the guide-line contrast pref to its paint values (line and halo
 * color/weight/opacity, dash pattern).
 *
 * @param {"low"|"medium"|"high"} contrast - Anything other than "low"/"medium"
 *   is treated as "high".
 * @param {string} [mapType] - Defaults to the saved map style. Toner's black
 *   roads swallow every contrast's dark halo and pale yellow line, so it gets
 *   a magenta line on a white halo whatever the contrast.
 * @returns {{lineColor: string, lineWeight: number, lineOpacity: number,
 *   haloColor: string, haloWeight: number, haloOpacity: number,
 *   dashArray: string}} `dashArray` is space-separated pixel lengths — see
 *   `linePaint` in live-map.js for how that's converted to MapLibre's
 *   line-width-relative units.
 */
export function getGuideLineStyle(contrast, mapType = state.prefs.mapType) {
	if (BLACK_ROAD_MAP_TYPES.includes(mapType)) {
		return {
			lineColor: "#ff1f8f",
			lineWeight: 3.5,
			lineOpacity: 1,
			haloColor: "#ffffff",
			haloWeight: 8,
			haloOpacity: 0.95,
			dashArray: "10 12",
		};
	}

	if (contrast === "low") {
		return {
			lineColor: "#ffffff",
			lineWeight: 2,
			lineOpacity: 0.85,
			haloColor: "#1f2d23",
			haloWeight: 5,
			haloOpacity: 0.55,
			dashArray: "8 10",
		};
	}

	if (contrast === "medium") {
		return {
			lineColor: "#fff48a",
			lineWeight: 3,
			lineOpacity: 0.95,
			haloColor: "#16231a",
			haloWeight: 6,
			haloOpacity: 0.72,
			dashArray: "9 11",
		};
	}

	return {
		lineColor: "#f6ff61",
		lineWeight: 3,
		lineOpacity: 1,
		haloColor: "#132017",
		haloWeight: 7,
		haloOpacity: 0.85,
		dashArray: "10 12",
	};
}

/**
 * Adds one distance-marker flag to a marker layer (see `createMarkerLayer`
 * in live-map.js).
 *
 * @param {{add: Function}} layer
 * @param {number} lat
 * @param {number} lng
 * @param {string} label - Pre-formatted text (see `segmentDistanceLabel`).
 * @param {"small"|"medium"|"large"} [markerSizeValue]
 */
export function addSegmentMarkerToLayer(layer, lat, lng, label, markerSizeValue = state.prefs.markerSize) {
	layer.add(lat, lng, createSegmentMarkerElement(label, markerSizeValue));
}

/**
 * Adds a whole ride's worth of distance-marker flags to a marker layer.
 *
 * @param {{add: Function}} layer
 * @param {Array<{lat: number, lng: number, label?: string, segmentNumber?: number}>} markers -
 *   Accepts both the current shape (`segmentNumber`, label computed on the
 *   fly from the current unit) and an older stored shape (`label` baked in
 *   at record time), for backward compatibility with previously-saved rides.
 * @param {"small"|"medium"|"large"} [markerSizeValue]
 */
export function renderSegmentMarkers(layer, markers, markerSizeValue = state.prefs.markerSize) {
	for (const marker of markers) {
		// Support both old format (with label) and new format (with segmentNumber)
		let label;
		if (marker.label) {
			// Old format - use stored label for backward compatibility
			label = marker.label;
		} else if (marker.segmentNumber) {
			// New format - compute label on-the-fly based on current units
			label = segmentDistanceLabel(marker.segmentNumber, state.prefs.unit);
		} else {
			// Fallback - try to infer segment number from array position
			const segmentNumber = markers.indexOf(marker) + 1;
			label = segmentDistanceLabel(segmentNumber, state.prefs.unit);
		}
		addSegmentMarkerToLayer(layer, marker.lat, marker.lng, label, markerSizeValue);
	}
}

/**
 * Adds only the distance-marker flags that fit at the map's current zoom, so
 * a long ride doesn't bury its own route. Round numbers claim their space
 * first (every 10th, then every 5th, then the rest), and any flag that would
 * overlap one already placed is left out; zooming in spreads the route out
 * and lets more through. Call again after the zoom changes.
 *
 * @param {maplibregl.Map} map
 * @param {{add: Function}} layer
 * @param {Array<{lat: number, lng: number, segmentNumber: number}>} markers
 * @param {Array<{lat: number, lng: number}>} [reserved] - Points the flags
 *   must keep clear of, such as the start and finish dots.
 * @param {"small"|"medium"|"large"} [markerSizeValue]
 */
export function renderFittedSegmentMarkers(map, layer, markers, reserved = [], markerSizeValue = state.prefs.markerSize) {
	// The flag's pill is narrower than the box around it, and that's what shows.
	const [boxWidth, boxHeight] = getMarkerSizeConfig(markerSizeValue).iconSize;
	const width = boxWidth * 0.85;
	const height = boxHeight * 0.85;
	const taken = reserved.map(({ lat, lng }) => map.project([lng, lat]));
	const tier = ({ segmentNumber }) => (segmentNumber % 10 === 0 ? 0 : segmentNumber % 5 === 0 ? 1 : 2);
	const byPriority = [...markers].sort((a, b) => tier(a) - tier(b) || a.segmentNumber - b.segmentNumber);

	for (const marker of byPriority) {
		const spot = map.project([marker.lng, marker.lat]);
		if (taken.some((other) => Math.abs(other.x - spot.x) < width && Math.abs(other.y - spot.y) < height)) continue;
		taken.push(spot);
		addSegmentMarkerToLayer(layer, marker.lat, marker.lng, segmentDistanceLabel(marker.segmentNumber, state.prefs.unit), markerSizeValue);
	}
}

/**
 * Re-applies the guide-line-contrast and marker-size prefs to whatever maps/
 * layers currently exist: the live map's guide line and label, the live
 * ride's distance markers, and the post-ride map's distance markers (which
 * are recomputed from the session, since they depend on the unit too). Called
 * after those settings change, and on every screen-navigation history
 * transition so a stale map picks up the current prefs.
 */
export function applyMapVisualPrefs() {
	const guideContrast = state.prefs.guideContrast;
	const markerSize = state.prefs.markerSize;
	applyLiveGuideStyle(getGuideLineStyle(guideContrast));

	if (state.guideLabelMarker) {
		styleGuideLabel(state.guideLabelMarker.getElement(), guideContrast, markerSize);
		// Re-rendered for the text too, which follows the units.
		updateGuideLabel();
	}

	if (state.markerLayer) {
		state.markerLayer.clearLayers();
		renderSegmentMarkers(state.markerLayer, state.currentSession?.segmentMarkers || [], markerSize);
	}

	renderPostSegmentMarkers(markerSize);
}

// Roughly what each map style's ground and roads look like, for the settings
// previews below: a patch of colour to judge a marker or line against, not a map.
const PREVIEW_GROUND = {
	road: { ground: "#ecebe6", road: "#ffffff" },
	roadDark: { ground: "#1f2422", road: "#3b423f" },
	topo: { ground: "#e3ead8", road: "#ffffff" },
	bike: { ground: "#e3ead8", road: "#111111" },
	bright: { ground: "#f2efe9", road: "#ffd98a" },
	fiord: { ground: "#2e3b4e", road: "#4b5c74" },
	classic: { ground: "#f2efe9", road: "#ffffff" },
	toner: { ground: "#ffffff", road: "#111111" },
	terrain: { ground: "#dde5cd", road: "#ffffff" },
};

/** The map style the previews imitate: the picked one, or Road where it needs a Stadia key that isn't set. */
function previewMapType() {
	const type = state.prefs.mapType;
	return MAP_STYLE_NAMES[type]?.free === null && !state.prefs.stadiaKey ? "road" : type;
}

/**
 * Draws the settings screen's two small previews: the distance marker at the
 * picked size, and the line back to the start at the picked contrast, each on
 * a patch coloured like the picked map style. They're built from the same
 * elements and paint values the maps use, so they change exactly as the maps
 * will. Called whenever a setting changes (navigation.js's `syncToggles`).
 */
export function renderSettingPreviews() {
	const type = previewMapType();
	const ground = PREVIEW_GROUND[type === "road" && state.prefs.theme === "dark" ? "roadDark" : type] ?? PREVIEW_GROUND.road;
	const ride = rideLineStyle(type);
	const unit = state.prefs.unit;
	const size = state.prefs.markerSize;
	const roads = `
		<path d="M-10 60 H330" stroke="${ground.road}" stroke-width="12"/>
		<path d="M96 -10 V100" stroke="${ground.road}" stroke-width="9"/>
		<path d="M236 -10 V100" stroke="${ground.road}" stroke-width="9"/>`;
	const svg = (body) => `<svg viewBox="0 0 320 88" preserveAspectRatio="none" fill="none" stroke-linecap="round" stroke-linejoin="round">${roads}${body}</svg>`;
	const rideLine = (d) => `${ride.casingWidth ? `<path d="${d}" stroke="#ffffff" stroke-width="${ride.casingWidth}"/>` : ""}<path d="${d}" stroke="${ride.color}" stroke-width="${ride.width}"/>`;
	// Placed by its middle, as a map marker is.
	const place = (element, left, top) => {
		const holder = document.createElement("div");
		holder.className = "setting-preview-item";
		holder.style.left = left;
		holder.style.top = top;
		holder.append(element);
		return holder;
	};

	// Distance markers: two flags along a stretch of ride.
	el.markerSizePreview.style.background = ground.ground;
	el.markerSizePreview.innerHTML = svg(rideLine("M-10 60 H330"));
	el.markerSizePreview.append(
		place(createSegmentMarkerElement(segmentDistanceLabel(1, unit), size), "30%", "68%"),
		place(createSegmentMarkerElement(segmentDistanceLabel(2, unit), size), "74%", "68%"),
	);

	// Guide line: the ride so far, the rider, and the dashed line back to the start with its distance chip.
	const guide = getGuideLineStyle(state.prefs.guideContrast, type);
	const guidePath = "M236 60 L60 22";
	el.guideContrastPreview.style.background = ground.ground;
	el.guideContrastPreview.innerHTML = svg(`
		${rideLine("M60 22 V60 H236")}
		<path d="${guidePath}" stroke="${guide.haloColor}" stroke-width="${guide.haloWeight}" stroke-opacity="${guide.haloOpacity}" stroke-dasharray="${guide.dashArray}"/>
		<path d="${guidePath}" stroke="${guide.lineColor}" stroke-width="${guide.lineWeight}" stroke-opacity="${guide.lineOpacity}" stroke-dasharray="${guide.dashArray}"/>`);
	const chip = document.createElement("div");
	chip.className = "guide-distance-label";
	const chipText = document.createElement("span");
	chipText.textContent = `${formatDistance(240, unit)} ${distanceUnitLabel(unit)}`;
	chip.append(chipText);
	styleGuideLabel(chip, state.prefs.guideContrast, size, type);
	const dot = (className) => {
		const element = document.createElement("div");
		element.className = className;
		return element;
	};
	el.guideContrastPreview.append(place(dot("route-start"), "18.75%", "25%"), place(dot("rider-dot"), "73.75%", "68.2%"), place(chip, "46.25%", "46.6%"));
}
