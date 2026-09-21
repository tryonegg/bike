/**
 * The routing Web Worker. It routes entirely on the device, from map tiles
 * cached by the service worker (sw.js). Driven by route-home.js during a
 * ride and by route-plan.js when planning one. All points are [lng, lat];
 * profile is "bike" or "foot".
 *
 * Messages in:
 * - {id, start, rider, track, profile, avoidRetrace} — a route from the
 *   rider to `start` (the ride's start, or the next point of a planned
 *   route), from cached tiles only; nothing is fetched mid-ride. `track` is
 *   the ride so far, thinned; avoidRetrace steers the route off roads it
 *   came out along.
 * - {id, type: "leg", from, to, profile} — one leg of a planned route. The
 *   rider is planning ahead, usually online, so missing tiles along the leg
 *   are downloaded (and cached, which also saves them for the ride itself).
 * - {id, type: "prefetch", coords} — downloads the tiles an imported route
 *   passes through, for the map and route home to use offline.
 * - {id, type: "elevation", coords} — the height profile along a route, from
 *   the terrain tiles topo mode uses (cached, or downloaded and cached).
 * - {id, type: "snap", point, profile, radius} — the nearest point, within
 *   `radius` meters, on a way the profile can use, for placing a planned
 *   route's point on the road or path the rider meant.
 * Message out: {id, route: {coords, meters}|null, stats}, {id, fetched},
 * {id, profile}, {id, snapped: [lng, lat]|null, meters}, or {id, error}.
 */

import { decodeLineLayer } from "./mvt.js";
import { DEM_TILE_URL, DEM_MAX_ZOOM } from "./constants.js";
import { buildGraph, findRoute, markRetraced, tileFor, toUnits, toLngLat, usableWay, TILE_ZOOM } from "./route-graph.js";

// The service worker's tile caches, matched by prefix so a version bump there
// doesn't need a matching change here.
const TILE_CACHE_PREFIXES = ["bike-tracker-mapdata-", "bike-tracker-stadia-"];
// Vector tiles only, at the zoom that carries every road and path. Raster
// (satellite) and elevation tiles share these caches and are skipped.
const TILE_PATH = new RegExp(`/${TILE_ZOOM}/(\\d+)/(\\d+)\\.(?:pbf|mvt)$`);
const TILE_HOSTS = ["tiles.openfreemap.org", "tiles.stadiamaps.com"];
// Where planning downloads missing tiles from: OpenFreeMap's TileJSON, which
// names the current versioned tile URL. Stored under the service worker's
// map-data cache so the map itself finds them too.
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
const MAP_DATA_CACHE_PREFIX = "bike-tracker-mapdata-";
const MAP_DATA_CACHE_FALLBACK = "bike-tracker-mapdata-v1";
const FETCH_CONCURRENCY = 6;

// A planned leg searches a corridor around the straight line between its
// ends: this share of the leg's length each side, but at least one tile,
// and never more than LEG_MAX_TILES tiles (the nearest ones win).
const LEG_CORRIDOR_SHARE = 0.3;
const LEG_MAX_TILES = 200;
// An imported route's tiles are looked up at points this far apart.
const PREFETCH_STEP_M = 100;
// Elevation profiles sample the route every ELEVATION_STEP_M, or further
// apart on a long route so there are no more than ELEVATION_MAX_SAMPLES.
// Terrain tiles are 256 pixels, and at DEM_MAX_ZOOM a pixel is about 15 m.
const ELEVATION_STEP_M = 25;
const ELEVATION_MAX_SAMPLES = 500;
const DEM_TILE_SIZE = 256;

// Beyond the tiles spanning the rider and the start, the search area reaches
// this far out (a share of that span, but at least one tile) so a route can
// swing wide of the straight line.
const MARGIN_SHARE = 0.5;
// Decoded tiles kept in memory between requests, most recently used last.
const DECODED_TILE_LIMIT = 300;
// A graph is reused until its tiles change or the track has grown by this
// many (thinned) points since it was built.
const TRACK_REBUILD_POINTS = 25;

const decodedTiles = new Map();
let built = null;

self.addEventListener("message", async (event) => {
	// goalKey is only passed back, so a follower can tell which goal it asked about.
	const { id, type, goalKey } = event.data;
	try {
		const handler = { leg: routeLeg, prefetch: prefetchLine, elevation: elevationProfile, snap: snapPoint }[type] ?? routeHome;
		self.postMessage({ id, goalKey, ...(await handler(event.data)) });
	} catch (error) {
		self.postMessage({ id, goalKey, error: String(error?.message ?? error) });
	}
});

/**
 * Builds (or reuses) the graph for this rider and start, and routes.
 * @returns {Promise<{route: {coords: Array<[number, number]>, meters: number}|null, stats: Object}>}
 */
async function routeHome({ start, rider, track, profile, avoidRetrace }) {
	const began = performance.now();
	const urls = await tileUrlsAround(start, rider);
	const key = `${profile}|${start.join(",")}|${urls.join("|")}`;

	if (!built || built.key !== key || track.length - built.trackLength >= TRACK_REBUILD_POINTS) {
		const tiles = [];
		for (const url of urls) {
			const tile = await loadTile(url);
			if (tile) tiles.push(tile);
		}
		built = { key, trackLength: track.length, graph: buildGraph({ tiles, start, track, profile }) };
	}

	if (avoidRetrace) markRetraced(built.graph, track);
	const route = findRoute(built.graph, rider, { avoidRetrace });
	return {
		route,
		stats: { tiles: urls.length, ...built.graph.stats, ms: Math.round(performance.now() - began) },
	};
}

/**
 * Routes one leg of a planned route, downloading any tiles its corridor is
 * missing first (skipped quietly when offline).
 * @returns {Promise<{route: {coords: Array<[number, number]>, meters: number}|null, stats: Object}>}
 */
async function routeLeg({ from, to, profile }) {
	const began = performance.now();
	const wanted = corridorTiles(from, to);
	const cached = await cachedTiles();
	const fetched = await fetchMissing(wanted, cached);

	const tiles = [];
	for (const key of wanted) {
		const url = cached.get(key);
		const tile = url && (await loadTile(url));
		if (tile) tiles.push(tile);
	}
	const graph = buildGraph({ tiles, start: to, profile });
	return {
		route: findRoute(graph, from),
		stats: { tiles: tiles.length, fetched, ...graph.stats, ms: Math.round(performance.now() - began) },
	};
}

/**
 * The nearest point to `point` on any way the profile can use, within
 * `radius` meters: from the tiles that reach that far (downloading any
 * missing ones, as planning does).
 *
 * @returns {Promise<{snapped: [number, number]|null, meters: number|null}>}
 */
async function snapPoint({ point, profile, radius }) {
	const [x, y] = toUnits(point);
	const reach = radius / metersPerUnitAt(point[1]);
	const wanted = [];
	for (let tx = Math.floor((x - reach) / 4096); tx <= Math.floor((x + reach) / 4096); tx++) {
		for (let ty = Math.floor((y - reach) / 4096); ty <= Math.floor((y + reach) / 4096); ty++) wanted.push(`${tx}/${ty}`);
	}
	const cached = await cachedTiles();
	await fetchMissing(wanted, cached);

	let best = null;
	let bestDistance = reach;
	for (const key of wanted) {
		const url = cached.get(key);
		const tile = url && (await loadTile(url));
		if (!tile) continue;
		const scale = 4096 / tile.extent;
		const originX = tile.x * 4096;
		const originY = tile.y * 4096;
		for (const feature of tile.features) {
			if (!usableWay(feature.properties, profile)) continue;
			for (const line of feature.lines) {
				for (let i = 1; i < line.length; i++) {
					const ax = originX + line[i - 1][0] * scale;
					const ay = originY + line[i - 1][1] * scale;
					const dx = originX + line[i][0] * scale - ax;
					const dy = originY + line[i][1] * scale - ay;
					const lengthSq = dx * dx + dy * dy;
					const t = lengthSq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
					const px = ax + dx * t;
					const py = ay + dy * t;
					const distance = Math.hypot(x - px, y - py);
					if (distance <= bestDistance) {
						bestDistance = distance;
						best = [px, py];
					}
				}
			}
		}
	}
	return best
		? { snapped: toLngLat(best), meters: bestDistance * metersPerUnitAt(point[1]) }
		: { snapped: null, meters: null };
}

/** Downloads the tiles a line passes through that aren't cached yet. */
async function prefetchLine({ coords }) {
	const wanted = new Set();
	for (let i = 0; i < coords.length; i++) {
		const tile = tileFor(coords[i]);
		wanted.add(`${tile.x}/${tile.y}`);
		// Long straight stretches between points are filled in along the way.
		if (i + 1 < coords.length) {
			const [ax, ay] = toUnits(coords[i]);
			const [bx, by] = toUnits(coords[i + 1]);
			const steps = Math.floor(Math.hypot(bx - ax, by - ay) / (PREFETCH_STEP_M / metersPerUnitAt(coords[i][1])));
			for (let k = 1; k <= steps; k++) {
				const t = k / (steps + 1);
				wanted.add(`${Math.floor((ax + (bx - ax) * t) / 4096)}/${Math.floor((ay + (by - ay) * t) / 4096)}`);
			}
		}
	}
	return { fetched: await fetchMissing([...wanted], await cachedTiles()) };
}

/**
 * The height profile along a route: samples at even spacing, each with its
 * distance along the route and its height (both meters), the height null
 * where its terrain tile couldn't be had (offline and never cached).
 *
 * @returns {Promise<{profile: {distances: number[], heights: Array<number|null>}}>}
 */
async function elevationProfile({ coords }) {
	const lengths = [0];
	for (let i = 1; i < coords.length; i++) lengths.push(lengths[i - 1] + haversine(coords[i - 1], coords[i]));
	const total = lengths[lengths.length - 1];
	const step = Math.max(ELEVATION_STEP_M, total / ELEVATION_MAX_SAMPLES);

	const distances = [];
	const heights = [];
	let segment = 1;
	for (let distance = 0; ; distance = Math.min(total, distance + step)) {
		while (segment < coords.length - 1 && lengths[segment] < distance) segment++;
		const span = lengths[segment] - lengths[segment - 1];
		const t = span ? (distance - lengths[segment - 1]) / span : 0;
		const a = coords[segment - 1];
		const b = coords[segment];
		distances.push(distance);
		heights.push(await heightAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
		if (distance >= total) break;
	}
	return { profile: { distances, heights } };
}

function haversine([lngA, latA], [lngB, latB]) {
	const toRad = Math.PI / 180;
	const dLat = (latB - latA) * toRad;
	const dLng = (lngB - lngA) * toRad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA * toRad) * Math.cos(latB * toRad) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const demTiles = new Map();

/**
 * The terrain height at a point, interpolated between the four nearest
 * pixels of its terrain tile, or null when the tile can't be had.
 * @returns {Promise<number|null>}
 */
async function heightAt(lngLat) {
	const scale = 2 ** DEM_MAX_ZOOM * DEM_TILE_SIZE;
	const [ux, uy] = toUnits(lngLat);
	// toUnits is at zoom 14 × 4096; rescale to terrain-tile pixels.
	const px = (ux / (2 ** TILE_ZOOM * 4096)) * scale - 0.5;
	const py = (uy / (2 ** TILE_ZOOM * 4096)) * scale - 0.5;
	const x0 = Math.floor(px);
	const y0 = Math.floor(py);
	const fx = px - x0;
	const fy = py - y0;
	const corners = [];
	for (const [dx, dy] of [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	]) {
		const height = await pixelHeight(x0 + dx, y0 + dy);
		if (height === null) return null;
		corners.push(height);
	}
	const top = corners[0] + (corners[1] - corners[0]) * fx;
	const bottom = corners[2] + (corners[3] - corners[2]) * fx;
	return top + (bottom - top) * fy;
}

/** One terrain pixel's height (global pixel coordinates at DEM_MAX_ZOOM). */
async function pixelHeight(gx, gy) {
	const tile = await demTile(Math.floor(gx / DEM_TILE_SIZE), Math.floor(gy / DEM_TILE_SIZE));
	if (!tile) return null;
	const i = ((gy % DEM_TILE_SIZE) * DEM_TILE_SIZE + (gx % DEM_TILE_SIZE)) * 4;
	// Terrarium encoding: (red × 256 + green + blue / 256) − 32768 meters.
	return tile[i] * 256 + tile[i + 1] + tile[i + 2] / 256 - 32768;
}

/**
 * A terrain tile's RGBA pixels: from the cache, else downloaded (and cached
 * for the map's topo mode too). Remembered, including a failure, for the
 * rest of this worker's life. Null when it can't be had or decoded (an old
 * browser without OffscreenCanvas in workers).
 * @returns {Promise<Uint8ClampedArray|null>}
 */
function demTile(x, y) {
	const key = `${x}/${y}`;
	if (!demTiles.has(key)) {
		demTiles.set(
			key,
			(async () => {
				const url = DEM_TILE_URL.replace("{z}", DEM_MAX_ZOOM).replace("{x}", x).replace("{y}", y);
				try {
					let response = await caches.match(url);
					if (!response) {
						response = await fetch(url);
						if (!response.ok) return null;
						const names = await caches.keys();
						const cache = await caches.open(names.find((name) => name.startsWith(MAP_DATA_CACHE_PREFIX)) ?? MAP_DATA_CACHE_FALLBACK);
						await cache.put(url, response.clone());
					}
					// Heights are encoded in exact colour values, so nothing may adjust them.
					const bitmap = await createImageBitmap(await response.blob(), {
						colorSpaceConversion: "none",
						premultiplyAlpha: "none",
					});
					const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
					const context = canvas.getContext("2d", { willReadFrequently: true });
					context.drawImage(bitmap, 0, 0);
					return context.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
				} catch {
					demTiles.delete(key);
					return null;
				}
			})(),
		);
	}
	return demTiles.get(key);
}

/** Meters per global tile unit at a latitude (see route-graph.js). */
function metersPerUnitAt(lat) {
	return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** TILE_ZOOM * 4096);
}

/**
 * The tiles around a planned leg: within a corridor either side of the
 * straight line between its ends, nearest first, as "x/y" keys.
 * @returns {string[]}
 */
function corridorTiles(from, to) {
	const [ax, ay] = toUnits(from).map((v) => v / 4096);
	const [bx, by] = toUnits(to).map((v) => v / 4096);
	const length = Math.hypot(bx - ax, by - ay);
	const reach = Math.max(1, length * LEG_CORRIDOR_SHARE) + Math.SQRT1_2;

	const found = [];
	for (let x = Math.floor(Math.min(ax, bx) - reach); x <= Math.max(ax, bx) + reach; x++) {
		for (let y = Math.floor(Math.min(ay, by) - reach); y <= Math.max(ay, by) + reach; y++) {
			const cx = x + 0.5;
			const cy = y + 0.5;
			const t = length ? Math.max(0, Math.min(1, ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (length * length))) : 0;
			const distance = Math.hypot(cx - (ax + (bx - ax) * t), cy - (ay + (by - ay) * t));
			if (distance <= reach) found.push({ key: `${x}/${y}`, distance });
		}
	}
	return found
		.sort((p, q) => p.distance - q.distance)
		.slice(0, LEG_MAX_TILES)
		.map((tile) => tile.key);
}

/**
 * Downloads the wanted tiles `cached` lacks, storing each in the map-data
 * cache and adding it to `cached`. A failed download (offline, say) is
 * skipped. Returns how many were fetched.
 *
 * @param {string[]} wanted - "x/y" keys.
 * @param {Map<string, string>} cached - From `cachedTiles`, updated in place.
 * @returns {Promise<number>}
 */
async function fetchMissing(wanted, cached) {
	const missing = wanted.filter((key) => !cached.has(key));
	if (!missing.length) return 0;
	const template = await tileTemplate();
	if (!template) return 0;

	const names = await caches.keys();
	const cache = await caches.open(names.find((name) => name.startsWith(MAP_DATA_CACHE_PREFIX)) ?? MAP_DATA_CACHE_FALLBACK);
	let fetched = 0;
	let next = 0;
	const fetchOne = async () => {
		while (next < missing.length) {
			const key = missing[next++];
			const [x, y] = key.split("/");
			const url = template.replace("{z}", TILE_ZOOM).replace("{x}", x).replace("{y}", y);
			try {
				const response = await fetch(url);
				if (!response.ok) continue;
				await cache.put(url, response);
				cached.set(key, url);
				fetched++;
			} catch {
				// Offline or blocked: this tile stays missing.
			}
		}
	};
	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, fetchOne));
	return fetched;
}

let templatePromise = null;

/**
 * The current OpenFreeMap tile URL template, from its TileJSON, or failing
 * that (offline) worked out from a tile already cached. Null when neither
 * is possible.
 * @returns {Promise<string|null>}
 */
function tileTemplate() {
	templatePromise ??= (async () => {
		try {
			const tileJson = await (await fetch(TILEJSON_URL)).json();
			if (tileJson.tiles?.[0]) return tileJson.tiles[0];
		} catch {
			// Fall through to the cache.
		}
		for (const url of (await cachedTiles()).values()) {
			if (new URL(url).hostname === "tiles.openfreemap.org") return url.replace(TILE_PATH, "/{z}/{x}/{y}.pbf");
		}
		return null;
	})();
	// A failure isn't remembered, so the next leg tries again.
	templatePromise.then((template) => {
		if (!template) templatePromise = null;
	});
	return templatePromise;
}

/**
 * Every cached zoom-14 vector tile, as "x/y" → URL. When a tile is cached
 * more than once (OpenFreeMap publishes new data under a new versioned path;
 * the rider may also have used Stadia), the URL that sorts last is used,
 * which for OpenFreeMap is the newest.
 *
 * @returns {Promise<Map<string, string>>}
 */
async function cachedTiles() {
	const byTile = new Map();
	for (const name of await caches.keys()) {
		if (!TILE_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		const cache = await caches.open(name);
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			if (!TILE_HOSTS.includes(url.hostname)) continue;
			const match = TILE_PATH.exec(url.pathname);
			if (!match) continue;
			const tileKey = `${match[1]}/${match[2]}`;
			const current = byTile.get(tileKey);
			if (!current || current < request.url) byTile.set(tileKey, request.url);
		}
	}
	return byTile;
}

/**
 * Lists the cached vector tiles in the search area around the rider and the
 * start.
 *
 * @returns {Promise<string[]>}
 */
async function tileUrlsAround(start, rider) {
	const a = tileFor(start);
	const b = tileFor(rider);
	const margin = Math.max(1, Math.ceil(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * MARGIN_SHARE));
	const minX = Math.min(a.x, b.x) - margin;
	const maxX = Math.max(a.x, b.x) + margin;
	const minY = Math.min(a.y, b.y) - margin;
	const maxY = Math.max(a.y, b.y) + margin;

	const urls = [];
	for (const [key, url] of await cachedTiles()) {
		const [x, y] = key.split("/").map(Number);
		if (x >= minX && x <= maxX && y >= minY && y <= maxY) urls.push(url);
	}
	return urls.sort();
}

/**
 * Reads one cached tile and decodes its road layer, remembering the result.
 * @returns {Promise<{x: number, y: number, extent: number, features: Array}|null>}
 */
async function loadTile(url) {
	if (decodedTiles.has(url)) {
		const tile = decodedTiles.get(url);
		decodedTiles.delete(url);
		decodedTiles.set(url, tile);
		return tile;
	}

	const response = await caches.match(url);
	if (!response) return null;
	const match = TILE_PATH.exec(new URL(url).pathname);
	const layer = decodeLineLayer(await response.arrayBuffer(), "transportation");
	const tile = layer ? { x: Number(match[1]), y: Number(match[2]), extent: layer.extent, features: layer.features } : null;

	decodedTiles.set(url, tile);
	if (decodedTiles.size > DECODED_TILE_LIMIT) decodedTiles.delete(decodedTiles.keys().next().value);
	return tile;
}
