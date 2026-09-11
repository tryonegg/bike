/**
 * "Best past pace" comparison: building a searchable index of past rides at
 * the start of a new one, then — as the rider moves — reading off the best
 * pace ever recorded near the current point and coloring the roads ahead by
 * how fast they were ridden before. `pace-index.js` holds the pure
 * geometry/matching logic; this module is the live-map-facing layer on top
 * of it (the readout chip and the colored band).
 */

import { BEST_PACE_LAYER, BEST_PACE_SLOTS, BEST_PACE_BAND_M, BEST_PACE_BAND_OPACITY, BEST_PACE_CLIMB_GRADE, CLEAR_LINE_GRADIENT } from "./constants.js";
import { state } from "./state.js";
import { getAllSessions } from "./db.js";
import { buildPaceIndex, bestPaceAt, pathsAhead, trailingPace } from "./pace-index.js";
import { animateMarkerTo, lineData, isMapStyleReady } from "./live-map.js";
import { haversineMeters, formatSpeed } from "./format.js";
import { speedUnitLabel } from "./map-visuals.js";
import { paceColor } from "./colors.js";

// ---- Best past pace ----

/**
 * Builds the pace index for this ride from every past saved ride of the same
 * activity type, and installs it on `state.paceIndex` once ready. Indexing
 * runs async and this ride may have ended (or another begun) before it
 * finishes, so the result is only installed if `session` is still the
 * current one. A no-op if the "compare with past rides" preference is off.
 *
 * @param {Object} session - The ride that's starting.
 * @returns {Promise<void>}
 */
export async function loadPaceIndex(session) {
	state.paceIndex = null;
	if (!state.prefs.comparePastRides) return;
	const activity = session.activityType || "bike";
	try {
		const sessions = (await getAllSessions()).filter((saved) => (saved.activityType || "bike") === activity);
		const index = await buildPaceIndex(sessions);
		// The ride may have ended, or another begun, while the index was building.
		if (state.currentSession === session) state.paceIndex = index;
	} catch (error) {
		console.warn("Indexing past rides failed", error);
	}
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

	// The band shows every known path ahead even where this spot has no history,
	// such as a new street leading onto roads ridden before.
	setBestPaceBand(pathsAhead(index, point, heading, BEST_PACE_BAND_M));

	const here = bestPaceAt(index, point.lat, point.lng, heading);
	if (!Number.isFinite(here.best)) {
		renderBestPaceChip({ empty: true });
		return;
	}
	renderBestPaceChip({ best: here.best, current: trailingPace(session.points), grade: here.grade });
}

/** Hides both the best-pace chip and the colored band of roads ahead. */
export function hideBestPace() {
	renderBestPaceChip(null);
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
 * Colours the known paths ahead of the rider by the best past pace recorded
 * along them, on the rider's own slow-to-fast range for this ride
 * (`index.slow`/`index.fast`), fading out with distance from the rider. Each
 * path becomes one MapLibre line-gradient layer, so color and fade change
 * smoothly along it and nothing overlaps itself. Only the longest
 * `BEST_PACE_SLOTS` paths are drawn — there is one map layer pre-allocated
 * per slot (see `addLiveOverlayLayers` in live-map.js).
 *
 * @param {null|Array<{coords: Array<[number, number]>, paces: number[],
 *   distances: number[]}>} lines - Candidate paths from `pathsAhead`, or
 *   `null` to clear the band entirely.
 */
export function setBestPaceBand(lines) {
	const index = state.paceIndex;
	const paths = [];
	if (lines && index) {
		const range = index.fast - index.slow;
		const measured = lines.map((line) => {
			const along = [0];
			for (let k = 1; k < line.coords.length; k++) {
				const [lngA, latA] = line.coords[k - 1];
				const [lngB, latB] = line.coords[k];
				along.push(along[k - 1] + haversineMeters(latA, lngA, latB, lngB));
			}
			return { line, along };
		});
		measured.sort((a, b) => b.along[b.along.length - 1] - a.along[a.along.length - 1]);

		for (const { line, along } of measured.slice(0, BEST_PACE_SLOTS)) {
			const total = along[along.length - 1];
			const stops = [];
			let lastProgress = -1;
			for (let k = 0; k < line.coords.length; k++) {
				const progress = along[k] / total;
				// line-gradient needs strictly rising stops.
				if (!(progress > lastProgress)) continue;
				lastProgress = progress;
				const t = range > 0 && Number.isFinite(line.paces[k]) ? (line.paces[k] - index.slow) / range : 0.5;
				const alpha = BEST_PACE_BAND_OPACITY * Math.max(0, 1 - (line.distances[k] / BEST_PACE_BAND_M) ** 1.4);
				stops.push(progress, paceColor(t).replace("rgb(", "rgba(").replace(")", `, ${alpha.toFixed(3)})`));
			}
			if (stops.length >= 4) {
				paths.push({ coords: line.coords, gradient: ["interpolate", ["linear"], ["line-progress"], ...stops] });
			}
		}
	}

	// Slots that were empty before and still are need no update.
	const slotsInUse = Math.max(state.bestPaceBand?.length ?? 0, paths.length);
	state.bestPaceBand = paths;

	const map = state.liveMap;
	if (!isMapStyleReady(map)) return;
	for (let slot = 0; slot < slotsInUse; slot++) {
		const id = `${BEST_PACE_LAYER}-${slot}`;
		if (!map.getLayer(id)) continue;
		map.getSource(id).setData(lineData(paths[slot]?.coords ?? []));
		map.setPaintProperty(id, "line-gradient", paths[slot]?.gradient ?? CLEAR_LINE_GRADIENT);
	}
}
