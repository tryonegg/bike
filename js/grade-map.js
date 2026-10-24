/**
 * The planner's grade overlay: with "Grades" on, the roads in view are
 * colored by how steep they are, so a route can be steered up a hill or
 * around one. Roads come from the base map's own vector tiles (the
 * OpenMapTiles "transportation" layer, which both map providers use) and
 * heights from the terrain tiles (terrain.js), so nothing extra is
 * downloaded beyond what topo mode and the route profile already fetch.
 *
 * Each road is cut into pieces about GRADE_MAP_PIECE_M long and each piece
 * colored by its rise or drop over its length, either way, since a road
 * can be ridden in both directions. Bridges and tunnels are left out: the
 * terrain under them isn't the road.
 */

import { GRADE_MODERATE, GRADE_STEEP } from "./constants.js";
import { state, el } from "./state.js";
import { setPref } from "./db.js";
import { haversineMeters } from "./format.js";
import { heightAt } from "./terrain.js";

const GRADE_SOURCE = "plan-grades";
// Below this zoom there are too many roads, and too many terrain tiles, to
// measure them all.
const MIN_ZOOM = 13;
const PIECE_M = 40;
// Shorter roads than this (a driveway's mouth, a crossing) are left out:
// over so short a run, a meter of roughness in the terrain reads as a hill.
const MIN_ROAD_M = 20;
const MOVE_DELAY_MS = 250;
// Ways that aren't ridden on.
const SKIP_CLASSES = new Set(["rail", "transit", "ferry", "aerialway", "pier"]);

// Upper bounds of each band, as rise over run, and their colors: green on
// the flat through amber to red, and plum on the steepest.
const GRADE_BANDS = [
	{ max: 0.02, color: "#2f9c4f", label: "Flat" },
	{ max: GRADE_MODERATE, color: "#a3c23a", label: "2–5%" },
	{ max: GRADE_STEEP, color: "#e0a63a", label: "5–8%" },
	{ max: 0.12, color: "#e05a3a", label: "8–12%" },
	{ max: Infinity, color: "#8e2a5e", label: "12%+" },
];

// Bumped by every redraw, so a measurement still waiting on terrain tiles
// when the map moves again, or the overlay is turned off, is dropped.
let latest = 0;
let moveTimer = null;
// Set when a map tile loads, so the overlay is measured again once the map is idle.
let tilesArrived = false;

/** Wires the Grades button, and fills its legend; its state is remembered between visits. */
export function wireGradeToggle() {
	el.planGradeBands.innerHTML = GRADE_BANDS.map(
		({ color, label }) => `<li><span class="plan-grade-swatch" style="background:${color}"></span>${label}</li>`,
	).join("");
	syncButton();
	el.planGradesBtn.addEventListener("click", () => {
		state.prefs.planGrades = !state.prefs.planGrades;
		setPref("planGrades", state.prefs.planGrades);
		syncButton();
		if (state.planMap) refreshGrades(state.planMap);
	});
}

/**
 * Adds the overlay's source and layer, under the route's. Re-run after
 * every style swap, like the planner's other layers.
 * @param {maplibregl.Map} map
 */
export function addGradeLayers(map) {
	map.addSource(GRADE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
	map.addLayer({
		id: GRADE_SOURCE,
		type: "line",
		source: GRADE_SOURCE,
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": ["get", "color"],
			"line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 6],
			"line-opacity": 0.85,
		},
	});
	refreshGrades(map);
}

/**
 * Measures the roads again once the map settles after a pan or zoom, or
 * once road tiles that arrived since the last measurement have drawn.
 * @param {maplibregl.Map} map
 */
export function wireGradeOverlay(map) {
	map.on("moveend", () => {
		clearTimeout(moveTimer);
		moveTimer = setTimeout(() => refreshGrades(map), MOVE_DELAY_MS);
	});
	map.on("sourcedata", (event) => {
		if (event.tile && event.source?.type === "vector") tilesArrived = true;
	});
	map.on("idle", () => {
		if (tilesArrived && state.prefs.planGrades) refreshGrades(map);
	});
}

function syncButton() {
	const on = state.prefs.planGrades;
	el.planGradesBtn.setAttribute("aria-pressed", String(on));
	el.planGradesBtn.classList.toggle("active", on);
	el.planGradeLegend.hidden = !on;
}

/**
 * Redraws the overlay for the current view, or clears it when it's off or
 * the map is zoomed out too far.
 * @param {maplibregl.Map} map
 */
async function refreshGrades(map) {
	const request = ++latest;
	const source = map.getSource(GRADE_SOURCE);
	if (!source) return;
	const tooFar = map.getZoom() < MIN_ZOOM;
	el.planGradeNote.hidden = !(state.prefs.planGrades && tooFar);
	tilesArrived = false;
	if (!state.prefs.planGrades || tooFar) {
		source.setData({ type: "FeatureCollection", features: [] });
		return;
	}
	const features = await gradeFeatures(roadsInView(map));
	if (request !== latest) return;
	map.getSource(GRADE_SOURCE)?.setData({ type: "FeatureCollection", features });
}

/**
 * The lines of the road layer that cross the view, each once, as arrays of
 * [lng, lat].
 * @param {maplibregl.Map} map
 * @returns {Array<Array<[number, number]>>}
 */
function roadsInView(map) {
	const roadLayer = map.getStyle().layers.find((layer) => layer["source-layer"] === "transportation");
	if (!roadLayer) return [];
	const bounds = map.getBounds();
	const inView = ([lng, lat]) => bounds.contains([lng, lat]);
	const seen = new Set();
	const lines = [];
	for (const feature of map.querySourceFeatures(roadLayer.source, { sourceLayer: "transportation" })) {
		const { class: kind, brunnel } = feature.properties;
		if (SKIP_CLASSES.has(kind) || brunnel === "bridge" || brunnel === "tunnel") continue;
		const { type, coordinates } = feature.geometry;
		const parts = type === "LineString" ? [coordinates] : type === "MultiLineString" ? coordinates : [];
		for (const line of parts) {
			if (line.length < 2 || !line.some(inView)) continue;
			// Tiles overlap a little at their edges, and a road can be in several.
			const key = `${line[0][0].toFixed(5)},${line[0][1].toFixed(5)},${line.at(-1)[0].toFixed(5)},${line.at(-1)[1].toFixed(5)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(line);
		}
	}
	return lines;
}

/**
 * Cuts roads into pieces about PIECE_M long and colors each by its grade.
 * @param {Array<Array<[number, number]>>} lines
 * @returns {Promise<Object[]>} GeoJSON line features with a `color`.
 */
async function gradeFeatures(lines) {
	const pieces = [];
	for (const line of lines) pieces.push(...cutLine(line));
	// Neighbouring pieces share their ends, so each point is looked up once.
	const heights = new Map();
	const heightOf = (lngLat) => {
		const key = `${lngLat[0].toFixed(6)},${lngLat[1].toFixed(6)}`;
		if (!heights.has(key)) heights.set(key, heightAt(lngLat));
		return heights.get(key);
	};
	const features = await Promise.all(
		pieces.map(async ({ coords, meters }) => {
			const [from, to] = await Promise.all([heightOf(coords[0]), heightOf(coords.at(-1))]);
			if (from === null || to === null) return null;
			const grade = Math.abs(to - from) / meters;
			return {
				type: "Feature",
				geometry: { type: "LineString", coordinates: coords },
				properties: { color: GRADE_BANDS.find((band) => grade < band.max).color },
			};
		}),
	);
	return features.filter(Boolean);
}

/**
 * A road split into even pieces about PIECE_M long, keeping its bends.
 * @param {Array<[number, number]>} line
 * @returns {Array<{coords: Array<[number, number]>, meters: number}>}
 */
function cutLine(line) {
	const lengths = [];
	let total = 0;
	for (let i = 1; i < line.length; i++) {
		const length = haversineMeters(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
		lengths.push(length);
		total += length;
	}
	if (total < MIN_ROAD_M) return [];
	const count = Math.max(1, Math.round(total / PIECE_M));
	const pieceLength = total / count;
	const pieces = [];
	let coords = [line[0]];
	let along = 0;
	let nextCut = pieceLength;
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const length = lengths[i - 1];
		while (pieces.length < count - 1 && nextCut <= along + length) {
			const t = length ? (nextCut - along) / length : 0;
			const cut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
			coords.push(cut);
			pieces.push({ coords, meters: pieceLength });
			coords = [cut];
			nextCut += pieceLength;
		}
		coords.push(b);
		along += length;
	}
	pieces.push({ coords, meters: pieceLength });
	return pieces;
}
