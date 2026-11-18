/**
 * Bike paths on the Bike map style when zoomed out (bike-style.js draws
 * them from zoom 14 in, straight from the map's own tiles).
 *
 * The map tiles only carry paths in full at zoom 14, a few at 13 and none
 * further out, so the style has nothing to draw them from. Here the zoom-14
 * tiles under the view are fetched instead, their bike paths picked out,
 * thinned, and handed to the map as one GeoJSON overlay shown from
 * FAR_MIN_ZOOM up to zoom 14.
 *
 * A zoomed-out view spans a lot of zoom-14 tiles (64 for every tile's worth
 * of screen at zoom 11), so only the paths are kept: a tile's few lines are
 * stored in a cache of their own and the tile itself is thrown away, leaving
 * the map's tile cache for the tiles the map draws. A stored tile is good
 * for PATHS_MAX_AGE_MS, and is still used past that when a fresh one can't
 * be had.
 */

import { state } from "./state.js";
import { decodeLineLayer } from "./mvt.js";
import { toLngLat, tileFor, TILE_ZOOM } from "./route-graph.js";

const SOURCE = "bike-far-paths";
const BIKE_COLOR = "#00b34a";
const UNPAVED_COLOR = "#8a5a2b";
export const FAR_MIN_ZOOM = 11;
// A very large window zoomed right out would ask for more than this; the
// tiles nearest its middle win.
const MAX_TILES = 400;
const FETCH_CONCURRENCY = 6;
const MOVE_DELAY_MS = 300;
// How often the overlay is redrawn while tiles are still arriving.
const DRAW_INTERVAL_MS = 500;
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
const PATHS_CACHE = "bike-tracker-bikepaths-v1";
const PATHS_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60000;
const MEMORY_TILE_LIMIT = 4000;
// Bends smaller than this are dropped, in tile units (4096 to a zoom-14
// tile, so about a fifth of a pixel at zoom 11 and under two at zoom 14).
const SIMPLIFY_UNITS = 12;
const TILE_UNITS = 4096;

// Each tile's bike paths by "x/y", newest last, as arrays of {u, c}: whether
// it is unpaved, and its [lng, lat] coordinates.
const loaded = new Map();
const loading = new Map();
const failedAt = new Map();
// Per map: the latest request, and what the overlay last drew.
const farStatus = new WeakMap();
let templatePromise = null;

/**
 * Adds the overlay's source and layers under `beforeId`. Called by
 * `applyBikeStyle` after every style load; `wireFarBikePaths` keeps it
 * filled as the map moves.
 *
 * @param {maplibregl.Map} map
 * @param {string|undefined} beforeId
 */
export function addFarBikePathLayers(map, beforeId) {
	if (map.getSource(SOURCE)) return;
	const width = (scale) => ["interpolate", ["exponential", 1.2], ["zoom"], 10, 1 * scale, 14, 2.5 * scale, 20, 9 * scale];
	const line = { type: "line", source: SOURCE, minzoom: FAR_MIN_ZOOM, maxzoom: TILE_ZOOM, layout: { "line-cap": "round", "line-join": "round" } };

	map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
	map.addLayer(
		{ ...line, id: `${SOURCE}-casing`, paint: { "line-color": ["case", ["==", ["get", "u"], 1], UNPAVED_COLOR, "#ffffff"], "line-width": width(1.9) } },
		beforeId,
	);
	map.addLayer({ ...line, id: SOURCE, paint: { "line-color": BIKE_COLOR, "line-width": width(1) } }, beforeId);

	const status = farStatus.get(map);
	if (status) {
		status.drawn = "";
		refresh(map);
	}
}

/**
 * Keeps a map's zoomed-out bike paths loaded as it moves. Wired once per
 * map; it does nothing while the map isn't in the Bike style.
 *
 * @param {maplibregl.Map} map
 */
export function wireFarBikePaths(map) {
	farStatus.set(map, { request: 0, timer: null, drawn: "" });
	map.on("moveend", () => {
		const status = farStatus.get(map);
		clearTimeout(status.timer);
		status.timer = setTimeout(() => refresh(map), MOVE_DELAY_MS);
	});
}

/** Loads the bike paths under the view, nearest the middle first, drawing them as they arrive. */
async function refresh(map) {
	const status = farStatus.get(map);
	if (!status || !map.getSource(SOURCE)) return;
	const request = ++status.request;
	const zoom = map.getZoom();
	// Outside these zooms the layers aren't drawn, so what they hold can stay.
	if (state.prefs.mapType !== "bike" || zoom < FAR_MIN_ZOOM || zoom >= TILE_ZOOM) return;

	const keys = tilesInView(map);
	const draw = () => {
		if (request !== status.request) return;
		const have = keys.filter((key) => loaded.has(key));
		// A map following a rider settles every second or so, mostly over the same tiles.
		const drawn = `${keys[0]}:${keys.length}:${have.length}`;
		if (drawn === status.drawn) return;
		status.drawn = drawn;
		const features = [];
		for (const key of have) {
			for (const { u, c } of loaded.get(key)) features.push({ type: "Feature", properties: { u }, geometry: { type: "LineString", coordinates: c } });
		}
		map.getSource(SOURCE)?.setData({ type: "FeatureCollection", features });
	};

	const now = Date.now();
	const missing = keys.filter((key) => !loaded.has(key) && !(now - failedAt.get(key) < RETRY_MS));
	if (!missing.length) {
		draw();
		return;
	}
	const interval = setInterval(draw, DRAW_INTERVAL_MS);
	const worker = async () => {
		while (missing.length && request === status.request) await loadTile(missing.shift());
	};
	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
	clearInterval(interval);
	draw();
}

/** The zoom-14 tiles under the view as "x/y" keys, nearest its middle first, MAX_TILES at most. */
function tilesInView(map) {
	const bounds = map.getBounds();
	const min = tileFor([bounds.getWest(), bounds.getNorth()]);
	const max = tileFor([bounds.getEast(), bounds.getSouth()]);
	const middle = tileFor(map.getCenter().toArray());
	const tiles = [];
	for (let x = min.x; x <= max.x; x++) {
		for (let y = min.y; y <= max.y; y++) tiles.push({ x, y, far: (x - middle.x) ** 2 + (y - middle.y) ** 2 });
	}
	tiles.sort((a, b) => a.far - b.far);
	return tiles.slice(0, MAX_TILES).map(({ x, y }) => `${x}/${y}`);
}

/** Loads one tile's bike paths into `loaded`: from the paths cache if fresh, else from its tile. */
function loadTile(key) {
	if (loading.has(key)) return loading.get(key);
	const load = (async () => {
		const stored = await readStored(key);
		let paths = stored && Date.now() - stored.t < PATHS_MAX_AGE_MS ? stored.f : null;
		if (!paths) {
			paths = await downloadPaths(key);
			if (paths) writeStored(key, paths);
			// Out of date beats nothing.
			else paths = stored?.f ?? null;
		}
		if (paths) {
			loaded.set(key, paths);
			if (loaded.size > MEMORY_TILE_LIMIT) loaded.delete(loaded.keys().next().value);
		} else {
			failedAt.set(key, Date.now());
		}
		loading.delete(key);
	})();
	loading.set(key, load);
	return load;
}

/**
 * Fetches a zoom-14 tile and picks out its bike paths. The tile is read
 * from the map's caches when it's there (a ridden or saved area) and
 * otherwise downloaded without being kept.
 * @returns {Promise<Array<{u: number, c: Array<[number, number]>}>|null>} Null when the tile can't be had.
 */
async function downloadPaths(key) {
	const template = await tileTemplate();
	if (!template) return null;
	const [x, y] = key.split("/").map(Number);
	const url = template.replace("{z}", TILE_ZOOM).replace("{x}", x).replace("{y}", y);
	try {
		// "no-store" also tells the service worker to leave this one out of the map's tile cache.
		const response = (await caches.match(url)) ?? (await fetch(url, { cache: "no-store" }));
		if (!response.ok) return null;
		const layer = decodeLineLayer(await response.arrayBuffer(), "transportation");
		const paths = [];
		for (const { properties, lines } of layer?.features ?? []) {
			if (properties.class !== "path" || !(properties.subclass === "cycleway" || properties.bicycle === "designated")) continue;
			const scale = TILE_UNITS / layer.extent;
			for (const line of lines) {
				const thinned = simplify(line.map(([px, py]) => [px * scale, py * scale]));
				if (thinned.length < 2) continue;
				paths.push({
					u: properties.surface === "unpaved" ? 1 : 0,
					c: thinned.map(([ux, uy]) => toLngLat([x * TILE_UNITS + ux, y * TILE_UNITS + uy]).map((degrees) => Number(degrees.toFixed(5)))),
				});
			}
		}
		return paths;
	} catch {
		// Offline, blocked, or a tile that wouldn't decode.
		return null;
	}
}

/** Drops the points of a line that stray less than SIMPLIFY_UNITS from the line through their neighbours (Douglas–Peucker). */
function simplify(points) {
	if (points.length < 3) return points;
	const keep = new Uint8Array(points.length);
	keep[0] = keep[points.length - 1] = 1;
	const spans = [[0, points.length - 1]];
	while (spans.length) {
		const [first, last] = spans.pop();
		const [ax, ay] = points[first];
		const [bx, by] = points[last];
		const [dx, dy] = [bx - ax, by - ay];
		const length = Math.hypot(dx, dy);
		let worst = 0;
		let worstAt = -1;
		for (let i = first + 1; i < last; i++) {
			const [px, py] = points[i];
			const off = length ? Math.abs(dy * (px - ax) - dx * (py - ay)) / length : Math.hypot(px - ax, py - ay);
			if (off > worst) {
				worst = off;
				worstAt = i;
			}
		}
		if (worst > SIMPLIFY_UNITS) {
			keep[worstAt] = 1;
			spans.push([first, worstAt], [worstAt, last]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

/** Where a tile's paths are stored: a made-up address on this origin, never fetched. */
function storedUrl(key) {
	return new URL(`./bike-paths/${TILE_ZOOM}/${key}.json`, location.href).href;
}

/** @returns {Promise<{t: number, f: Array}|null>} A tile's stored paths and when they were stored. */
async function readStored(key) {
	try {
		const response = await (await caches.open(PATHS_CACHE)).match(storedUrl(key));
		return response ? await response.json() : null;
	} catch {
		return null;
	}
}

async function writeStored(key, paths) {
	try {
		const body = JSON.stringify({ t: Date.now(), f: paths });
		await (await caches.open(PATHS_CACHE)).put(storedUrl(key), new Response(body, { headers: { "Content-Type": "application/json" } }));
	} catch {
		// Storage is full or unavailable: the paths are still in memory for this visit.
	}
}

/**
 * The current OpenFreeMap tile URL template, from its TileJSON (which the
 * service worker keeps for offline use). Null when it can't be had.
 * @returns {Promise<string|null>}
 */
function tileTemplate() {
	templatePromise ??= (async () => {
		try {
			return (await (await fetch(TILEJSON_URL)).json()).tiles?.[0] ?? null;
		} catch {
			return null;
		}
	})();
	// A failure isn't remembered, so the next view tries again.
	templatePromise.then((template) => {
		if (!template) templatePromise = null;
	});
	return templatePromise;
}
