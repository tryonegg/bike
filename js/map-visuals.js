/**
 * Visual configuration shared by the live and post-ride maps: unit/segment
 * labels, distance-marker sizing, the guide-line color scheme, and the
 * `applyMapVisualPrefs` entry point that re-applies all of it after a
 * settings change.
 */

import { METERS_PER_MILE, METERS_PER_KM } from "./constants.js";
import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { applyLiveGuideStyle, styleGuideLabel, updateGuideLabel } from "./live-map.js";
import { recalculateSegmentMarkers } from "./post-session.js";

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
 * @returns {{lineColor: string, lineWeight: number, lineOpacity: number,
 *   haloColor: string, haloWeight: number, haloOpacity: number,
 *   dashArray: string}} `dashArray` is space-separated pixel lengths — see
 *   `linePaint` in live-map.js for how that's converted to MapLibre's
 *   line-width-relative units.
 */
export function getGuideLineStyle(contrast) {
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

	if (state.postMarkerLayer) {
		state.postMarkerLayer.clearLayers();
		if (state.currentPostSession) {
			const segmentMarkers = recalculateSegmentMarkers(state.currentPostSession);
			renderSegmentMarkers(state.postMarkerLayer, segmentMarkers, markerSize);
		}
	}
}
