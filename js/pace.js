/**
 * "Best past pace" comparison: as the rider moves, reading off the best pace
 * ever recorded on the road section they're on, and coloring the roads ahead
 * by how fast they were ridden before. Both come from the best pace map
 * (pace-map.js), loaded once as the ride starts; `pace-index.js` holds the
 * lookups, and this module is the live-map-facing layer on top of them (the
 * readout chip and the colored band).
 */

import { BEST_PACE_LAYER, BEST_PACE_BAND_M, BEST_PACE_BAND_OPACITY, BEST_PACE_CLIMB_GRADE, BEST_PACE_BAND_STEP_M } from "./constants.js";
import { state } from "./state.js";
import { getAllSessionSummaries } from "./db.js";
import { loadPaceSections } from "./pace-map.js";
import { buildSectionIndex, sectionAt, sectionsAhead, trailingPace } from "./pace-index.js";
import { animateMarkerTo, isMapStyleReady } from "./live-map.js";
import { haversineMeters, formatSpeed } from "./format.js";
import { speedUnitLabel } from "./map-visuals.js";
import { paceColor } from "./colors.js";

// ---- Best past pace ----

/**
 * Loads the best pace map's sections for this ride's activity and indexes
 * them on `state.paceIndex`. Loading is async and this ride may have ended
 * (or another begun) before it finishes, so the result is only installed if
 * `session` is still the current one. Skipped if the "compare with past
 * rides" preference is off. Also works out the average speed over past rides
 * of the ride's saved route, if it has one, for the pace chevron
 * (`state.routePastAvg`).
 *
 * @param {Object} session - The ride that's starting.
 * @returns {Promise<void>}
 */
export async function loadPaceIndex(session) {
	state.paceIndex = null;
	state.routePastAvg = null;
	state.bestPaceBandFrom = null;
	if (!state.prefs.comparePastRides && session.routeId == null) return;
	const activity = session.activityType || "bike";
	try {
		const summaries = (await getAllSessionSummaries()).filter((saved) => (saved.activityType || "bike") === activity);
		if (state.currentSession !== session) return;
		state.routePastAvg = routeAverage(summaries, session.routeId);
		if (!state.prefs.comparePastRides) return;
		const index = buildSectionIndex(await loadPaceSections(activity));
		// The ride may have ended, or another begun, while the sections loaded.
		if (state.currentSession === session) state.paceIndex = index;
	} catch (error) {
		console.warn("Loading the best pace map failed", error);
	}
}

/**
 * The average speed over every past ride of a saved route: all their
 * distance over all their moving time, so a long ride counts for more than
 * a short one.
 *
 * @param {Array<Object>} sessions - Saved rides, or their summaries.
 * @param {number|null} routeId
 * @returns {number|null} m/s, or null with no route or no past rides of it.
 */
function routeAverage(sessions, routeId) {
	if (routeId == null) return null;
	let meters = 0;
	let ms = 0;
	for (const saved of sessions) {
		if (saved.routeId !== routeId || !(saved.movingTime > 0)) continue;
		meters += saved.totalDistance || 0;
		ms += saved.movingTime;
	}
	return meters > 0 ? meters / (ms / 1000) : null;
}

/**
 * Called on every live GPS fix: moves the best-pace chip to the rider, and
 * refreshes both the colored band of roads ahead and the chip's readout
 * (best past pace here, the rider's own trailing pace over the same stretch,
 * and whether it's a climb). Hides everything when comparison is off, no
 * index is ready yet, or the ride is paused.
 *
 * @param {{lat: number, lng: number}} point - The rider's current position.
 * @param {number} heading - Current travel heading, in degrees.
 */
export function updateBestPace(point, heading) {
	const session = state.currentSession;
	const index = state.paceIndex;
	animateMarkerTo(state.bestPaceChip, [point.lng, point.lat]);

	if (!state.prefs.comparePastRides || !index || !session || session.paused) {
		hideBestPace();
		return;
	}

	// The band shows every known road ahead even where this spot has no history,
	// such as a new street leading onto roads ridden before. It only needs
	// redrawing once the rider has moved a little.
	const last = state.bestPaceBandFrom;
	if (!last || haversineMeters(last.lat, last.lng, point.lat, point.lng) >= BEST_PACE_BAND_STEP_M) {
		state.bestPaceBandFrom = { lat: point.lat, lng: point.lng };
		setBestPaceBand(sectionsAhead(index, point, heading, BEST_PACE_BAND_M));
	}

	const here = sectionAt(index, point.lat, point.lng, heading);
	if (!Number.isFinite(here?.best)) {
		renderBestPaceChip({ empty: true });
		return;
	}
	renderBestPaceChip({ best: here.best, current: trailingPace(session.points), grade: here.grade ?? 0 });
}

/** Hides both the best-pace chip and the colored band of roads ahead. */
export function hideBestPace() {
	renderBestPaceChip(null);
	state.bestPaceBandFrom = null;
	setBestPaceBand(null);
}

const GRADE_ICON =
	'<svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true"><path d="M5 9.6V1.8M1.6 5.1 5 1.6l3.4 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Creates the best-pace readout chip and adds it to the live map, hidden
 * until the first `renderBestPaceChip` call with real data. It's a MapLibre
 * marker anchored on its left edge, so it rides beside the rider dot, off
 * the road ahead, and follows the rider in screen space.
 *
 * @param {maplibregl.Map} map
 * @param {[number, number]} lngLat - Initial position.
 * @returns {maplibregl.Marker}
 */
export function createBestPaceChip(map, lngLat) {
	const element = document.createElement("div");
	element.className = "best-pace-chip";
	element.hidden = true;
	element.innerHTML = `
		<div class="best-pace-top"><span class="label">Best here</span><span class="best-pace-value"></span></div>
		<div class="best-pace-delta"><span class="best-pace-delta-value"></span><span class="best-pace-unit"></span></div>
		<div class="best-pace-grade" hidden>${GRADE_ICON}<span></span></div>
		<div class="best-pace-empty" hidden>No past rides this way</div>`;
	return new maplibregl.Marker({ element, anchor: "left", offset: [22, 0] }).setLngLat(lngLat).addTo(map);
}

/**
 * Updates the best-pace chip's DOM to match `view`.
 *
 * @param {null|{empty: true}|{best: number, current: number, grade: number}} view -
 *   `null` hides the chip; `{empty: true}` shows "No past rides this way";
 *   otherwise the best past pace (m/s), the rider's own pace over the same
 *   stretch (m/s, possibly non-finite if not yet available), and the grade
 *   (rise/run fraction) are rendered.
 */
export function renderBestPaceChip(view) {
	const element = state.bestPaceChip?.getElement();
	if (!element) return;
	element.hidden = !view;
	if (!view) return;

	const part = (selector) => element.querySelector(selector);
	element.classList.toggle("is-empty", Boolean(view.empty));
	part(".best-pace-top").hidden = Boolean(view.empty);
	part(".best-pace-delta").hidden = Boolean(view.empty);
	part(".best-pace-empty").hidden = !view.empty;
	if (view.empty) {
		part(".best-pace-grade").hidden = true;
		element.classList.remove("is-ahead", "is-pending");
		return;
	}

	const unit = state.prefs.unit;
	const best = formatSpeed(view.best, unit);
	part(".best-pace-value").textContent = best;
	part(".best-pace-unit").textContent = speedUnitLabel(unit);

	// The delta is taken between the rounded figures so it always matches what
	// the two numbers on screen say.
	if (Number.isFinite(view.current)) {
		const delta = Number(formatSpeed(view.current, unit)) - Number(best);
		const ahead = delta >= 0;
		part(".best-pace-delta-value").textContent = `${ahead ? "+" : "−"}${Math.abs(delta).toFixed(1)}`;
		element.classList.toggle("is-ahead", ahead);
		element.classList.remove("is-pending");
	} else {
		part(".best-pace-delta-value").textContent = "–";
		element.classList.remove("is-ahead");
		element.classList.add("is-pending");
	}

	const climbing = view.grade >= BEST_PACE_CLIMB_GRADE;
	part(".best-pace-grade").hidden = !climbing;
	if (climbing) part(".best-pace-grade span").textContent = `${Math.round(view.grade * 100)}% climb`;
}

/**
 * Colours the road sections ahead of the rider by the best past pace on
 * each, on the rider's own slow-to-fast range (`index.slow`/`index.fast`),
 * fading out with distance from the rider. Drawn as one GeoJSON source with
 * each section's color and opacity as feature properties (see
 * `addLiveOverlayLayers` in live-map.js).
 *
 * @param {null|Array<{section: Object, distance: number}>} ahead - From
 *   `sectionsAhead`, or `null` to clear the band entirely.
 */
export function setBestPaceBand(ahead) {
	const index = state.paceIndex;
	const features = [];
	if (ahead && index) {
		const range = index.fast - index.slow;
		for (const { section, distance } of ahead) {
			const t = range > 0 ? (section.best - index.slow) / range : 0.5;
			const opacity = BEST_PACE_BAND_OPACITY * Math.max(0, 1 - (distance / BEST_PACE_BAND_M) ** 1.4);
			if (opacity <= 0.01) continue;
			features.push({
				type: "Feature",
				properties: { color: paceColor(t), opacity },
				geometry: { type: "LineString", coordinates: section.coords },
			});
		}
	}
	// Clearing a band that's already clear (every fix while there's no index) needs no redraw.
	const wasEmpty = !state.bestPaceBand?.features.length;
	state.bestPaceBand = { type: "FeatureCollection", features };
	if (wasEmpty && !features.length) return;

	const map = state.liveMap;
	if (isMapStyleReady(map)) map.getSource(BEST_PACE_LAYER)?.setData(state.bestPaceBand);
}
