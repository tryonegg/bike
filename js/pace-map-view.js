/**
 * The Best Pace screen: the best pace map (pace-map.js) on a full-screen
 * map, every road section ever ridden colored by the fastest it was ridden,
 * so it doubles as a map of everywhere that's been ridden. Where a road is
 * steep enough to keep a best per direction, each direction draws on its own
 * side, like a traffic map; a flat road's one best draws down the middle. Tapping a section shows
 * its best and the ride that set it. Opening the screen also takes in any
 * rides not yet on the map.
 */

import { state, el } from "./state.js";
import { ACTIVITIES, PACE_STOPS } from "./constants.js";
import { getSessionById, getAllPaceSections } from "./db.js";
import { createVectorMap, isMapStyleReady } from "./live-map.js";
import { navigateToScreen } from "./navigation.js";
import { syncPaceMap, rebuildPaceMap, onPaceMapChange, isPaceMapSyncing } from "./pace-map.js";
import { paceRange } from "./pace-index.js";
import { openPostSession } from "./post-session.js";
import { confirmWithModal } from "./modal.js";
import { formatDistance, formatSpeed, escapeHtml, haversineMeters } from "./format.js";
import { paceColor } from "./colors.js";
import { distanceUnitLabel, speedUnitLabel } from "./map-visuals.js";

const SOURCE = "pace-map-sections";
const LINE_LAYER = "pace-map-lines";
const HIT_LAYER = "pace-map-hit";
const SELECTED_LAYER = "pace-map-selected";
// Sections ridden but too short to time.
const UNTIMED_COLOR = "#8a8f98";
// The two directions of a road have their middles within this many meters.
const TWIN_M = 10;
// While rides are being taken in, the map redraws after every this many.
const REDRAW_EVERY_RIDES = 5;

const view = {
	activity: null,
	sections: [],
	byId: new Map(),
	geo: { type: "FeatureCollection", features: [] },
	selectedId: null,
	fitted: false,
};

/**
 * Opens the screen, creating its map the first time (once the screen is
 * visible, since MapLibre measures its container when it is made), draws
 * the map as it stands, and starts taking in any rides not on it yet.
 *
 * @param {"push"|"replace"|string} [mode] - History mode, as `navigateToScreen`.
 * @returns {Promise<void>}
 */
export async function openPaceMap(mode = "push") {
	navigateToScreen("pacemap", mode);
	if (!state.paceMap) {
		state.paceMap = createVectorMap({ container: "paceMapMap", center: [0, 20], zoom: 1 }, addPaceMapLayers);
		state.paceMap.on("click", (event) => {
			const hit = state.paceMap.queryRenderedFeatures(event.point, { layers: [HIT_LAYER] })[0];
			selectSection(hit ? hit.properties.id : null);
		});
	} else {
		state.paceMap.resize();
	}
	view.fitted = false;
	await refresh();
	syncPaceMap();
}

/** Wires the screen's buttons, and redraws while rides are being taken in. */
export function wirePaceMap() {
	el.openPaceMapBtn.addEventListener("click", () => openPaceMap());
	el.paceMapBackBtn.addEventListener("click", () => history.back());
	el.paceMapRebuildBtn.addEventListener("click", confirmRebuild);
	el.paceMapActivities.addEventListener("click", (event) => {
		const button = event.target.closest("[data-activity]");
		if (!button || button.dataset.activity === view.activity) return;
		view.activity = button.dataset.activity;
		view.fitted = false;
		selectSection(null);
		refresh();
	});
	onPaceMapChange(({ done, total, running }) => {
		if (state.currentScreen !== "pacemap") return;
		renderStatus(running ? { done, total } : null);
		if (!running || (done > 0 && done % REDRAW_EVERY_RIDES === 0)) refresh();
	});
}

/** Reloads the sections for the chosen activity and redraws everything. */
async function refresh() {
	const all = await getAllPaceSections();
	const counts = new Map();
	for (const section of all) counts.set(section.activity, (counts.get(section.activity) ?? 0) + 1);
	if (!view.activity || !counts.has(view.activity)) {
		view.activity = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "bike";
	}
	renderActivities(counts);

	view.sections = all.filter((section) => section.activity === view.activity);
	view.byId = new Map(view.sections.map((section) => [section.id, section]));
	const { slow, fast } = paceRange(view.sections);
	const range = fast - slow;
	const twins = findTwins(view.sections);
	view.geo = {
		type: "FeatureCollection",
		// Pieces of sections first, so a whole section ridden later draws over them.
		features: [...view.sections].sort((a, b) => Boolean(b.partial) - Boolean(a.partial)).map((section) => ({
			type: "Feature",
			properties: {
				id: section.id,
				// Only a road with a best each way splits into two lines.
				split: twins.has(section),
				color: Number.isFinite(section.best) ? paceColor(range > 0 ? (section.best - slow) / range : 0.5) : UNTIMED_COLOR,
			},
			geometry: { type: "LineString", coordinates: section.coords },
		})),
	};
	if (isMapStyleReady(state.paceMap)) state.paceMap.getSource(SOURCE)?.setData(view.geo);

	renderLegend(slow, fast);
	renderSummary();
	if (!view.byId.has(view.selectedId)) selectSection(null);
	if (!isPaceMapSyncing()) renderStatus(null);
	if (!view.fitted && view.sections.length) {
		view.fitted = true;
		fitToSections();
	}
}

/**
 * Adds the map's own source and layers. Passed to `createVectorMap` as its
 * `addOverlays` callback, so it runs again after every style swap.
 *
 * @param {maplibregl.Map} map
 */
function addPaceMapLayers(map) {
	map.addSource(SOURCE, { type: "geojson", data: view.geo });
	// Lines run the way they were ridden, so a positive offset puts each
	// direction of a road on its own side. A road with a best one way only, or
	// one shared by both, draws centered.
	const side = (px) => ["case", ["get", "split"], px, 0];
	const offset = ["interpolate", ["exponential", 1.5], ["zoom"], 11, side(1.5), 15, side(4), 19, side(11)];
	const width = ["interpolate", ["exponential", 1.5], ["zoom"], 11, 3, 15, 7, 19, 20];
	map.addLayer({
		id: LINE_LAYER,
		type: "line",
		source: SOURCE,
		layout: { "line-cap": "butt", "line-join": "round" },
		paint: { "line-color": ["get", "color"], "line-width": width, "line-offset": offset },
	});
	map.addLayer({
		id: SELECTED_LAYER,
		type: "line",
		source: SOURCE,
		filter: ["==", ["get", "id"], view.selectedId ?? -1],
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": state.prefs.theme === "dark" ? "#ffffff" : "#1b1f24",
			"line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 6, 15, 11, 19, 26],
			"line-offset": offset,
			"line-opacity": 0.55,
		},
	});
	// A wide, invisible line to tap: the drawn ones are a few pixels across.
	map.addLayer({
		id: HIT_LAYER,
		type: "line",
		source: SOURCE,
		paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 24, "line-offset": offset },
	});
}

/** Frames every section of the chosen activity. */
function fitToSections() {
	const bounds = new maplibregl.LngLatBounds();
	for (const section of view.sections) for (const point of section.coords) bounds.extend(point);
	state.paceMap.fitBounds(bounds, { padding: { top: 120, bottom: 220, left: 40, right: 40 }, maxZoom: 15, duration: 0 });
}

/** Activity chips, shown only when more than one activity is on the map. */
function renderActivities(counts) {
	el.paceMapActivities.hidden = counts.size < 2;
	el.paceMapActivities.innerHTML = [...counts.keys()]
		.map((key) => {
			const activity = ACTIVITIES[key] ?? { label: key, icon: "" };
			const pressed = key === view.activity;
			return `<button class="map-chip${pressed ? " is-active" : ""}" data-activity="${escapeHtml(key)}" aria-pressed="${pressed}">${activity.icon} ${escapeHtml(activity.label)}</button>`;
		})
		.join("");
}

/** The slow-to-fast color bar, labeled with the speeds at either end. */
function renderLegend(slow, fast) {
	const unit = state.prefs.unit;
	el.paceMapScale.style.background = `linear-gradient(to right, ${PACE_STOPS.join(", ")})`;
	el.paceMapLegend.hidden = !(fast > 0);
	el.paceMapSlow.textContent = `${formatSpeed(slow, unit)} ${speedUnitLabel(unit)}`;
	el.paceMapFast.textContent = `${formatSpeed(fast, unit)} ${speedUnitLabel(unit)}`;
}

/**
 * How much road is on the map. A steep road ridden both ways has a section
 * for each direction; it counts once.
 */
function renderSummary() {
	const unit = state.prefs.unit;
	if (!view.sections.length) {
		el.paceMapSummary.textContent = "No rides on the map yet";
		return;
	}
	const twins = findTwins(view.sections);
	// A road with a best each way counts once.
	const meters = view.sections.reduce((sum, section) => sum + (twins.get(section)?.counted ? 0 : section.meters), 0);
	el.paceMapSummary.textContent = `${formatDistance(meters, unit)} ${distanceUnitLabel(unit)} of road ridden`;
}

/**
 * The sections with a twin: the same stretch of road the other way, with a
 * best of its own. Each twin's entry says whether the other of the pair is
 * the one already counted, so a pair's length can be counted once.
 *
 * @param {Array<Object>} sections
 * @returns {Map<Object, {twin: Object, counted: boolean}>}
 */
function findTwins(sections) {
	const cellOf = ([lng, lat]) => [Math.floor(lat * 5000), Math.floor(lng * 5000)];
	const byCell = new Map();
	for (const section of sections) {
		if (section.bothWays) continue;
		const key = cellOf(section.mid).join(":");
		const list = byCell.get(key);
		if (list) list.push(section);
		else byCell.set(key, [section]);
	}
	const twins = new Map();
	for (const section of sections) {
		if (section.bothWays || twins.has(section)) continue;
		const [row, col] = cellOf(section.mid);
		for (let r = row - 1; r <= row + 1 && !twins.has(section); r++) {
			for (let c = col - 1; c <= col + 1 && !twins.has(section); c++) {
				// The same road the other way runs opposite, from about the same middle.
				const twin = (byCell.get(`${r}:${c}`) ?? []).find(
					(other) =>
						!twins.has(other) &&
						Math.abs(((other.bearing - section.bearing + 540) % 360) - 180) > 135 &&
						haversineMeters(other.mid[1], other.mid[0], section.mid[1], section.mid[0]) <= TWIN_M,
				);
				if (!twin) continue;
				twins.set(section, { twin, counted: false });
				twins.set(twin, { twin: section, counted: true });
			}
		}
	}
	return twins;
}

/** Shows taking-in progress, or the tap hint when nothing is running. */
function renderStatus(progress) {
	el.paceMapStatus.textContent = progress
		? `Adding rides to the map… ${progress.done} of ${progress.total}`
		: view.sections.length
			? "Tap a road to see its best."
			: "Finished rides are added here once their map tiles can be downloaded.";
	el.paceMapRebuildBtn.disabled = Boolean(progress);
}

/** Highlights a section and shows its details, or clears the selection. */
async function selectSection(id) {
	view.selectedId = id ?? null;
	const map = state.paceMap;
	if (isMapStyleReady(map) && map.getLayer(SELECTED_LAYER)) map.setFilter(SELECTED_LAYER, ["==", ["get", "id"], view.selectedId ?? -1]);

	const section = view.byId.get(view.selectedId);
	el.paceMapDetail.hidden = !section;
	if (!section) return;
	const unit = state.prefs.unit;
	const best = Number.isFinite(section.best) ? `${formatSpeed(section.best, unit)} ${speedUnitLabel(unit)}` : "Too short to time";
	const when = section.bestDate ? new Date(section.bestDate).toLocaleDateString([], { dateStyle: "medium" }) : null;
	const grade = Number.isFinite(section.grade) && Math.abs(section.grade) >= 0.01 ? `${section.grade > 0 ? "+" : "−"}${Math.abs(Math.round(section.grade * 100))}% grade` : "Flat";
	const times = section.passes === 1 ? "Ridden once" : `Ridden ${section.passes} times`;
	el.paceMapDetailBest.textContent = best;
	el.paceMapDetailMeta.textContent = [when && `Set ${when}`, times, section.bothWays ? "Flat, either way" : grade].filter(Boolean).join(" · ");
	// The ride that set it may since have been deleted; its best stays.
	const ride = section.bestRideId != null ? await getSessionById(section.bestRideId) : null;
	if (view.selectedId !== section.id) return;
	el.paceMapDetailRide.hidden = !ride;
	el.paceMapDetailRide.onclick = ride ? () => openPostSession(ride.id, ride) : null;
}

async function confirmRebuild() {
	const confirmed = await confirmWithModal({
		title: "Rebuild best pace map?",
		message: "The map is built again from the rides saved now. Bests set by rides you've since deleted will be lost.",
		confirmText: "Rebuild",
		danger: true,
	});
	if (!confirmed) return;
	view.fitted = false;
	await rebuildPaceMap();
}
