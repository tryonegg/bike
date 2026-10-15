/**
 * Terrain heights, from the elevation tiles topo mode draws its relief from:
 * read from the map-data cache, or downloaded and cached there for the map
 * to find too. Shared by the routing worker (a planned route's height
 * profile) and the live ride screen (the grade underfoot, see grade.js), so
 * it runs in a worker or a page alike.
 */

import { DEM_TILE_URL, DEM_MAX_ZOOM, MAP_DATA_CACHE_PREFIX, MAP_DATA_CACHE_FALLBACK } from "./constants.js";
import { toUnits, TILE_ZOOM } from "./route-graph.js";

// Terrain tiles are 256 pixels, and at DEM_MAX_ZOOM a pixel is about 15 m.
const DEM_TILE_SIZE = 256;
// Decoded tiles kept in memory, most recently used last. Each is a quarter
// megabyte of pixels and a few kilometers across.
const DEM_TILE_LIMIT = 24;
// A tile that couldn't be had is asked for again after this long rather than
// on every lookup, which mid-ride would be every GPS fix while offline.
const DEM_RETRY_MS = 60000;

const demTiles = new Map();

/**
 * The terrain height at a point, interpolated between the four nearest
 * pixels of its terrain tile, or null when the tile can't be had.
 * @param {[number, number]} lngLat
 * @returns {Promise<number|null>} Meters.
 */
export async function heightAt(lngLat) {
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
 * A terrain tile's RGBA pixels, kept among the DEM_TILE_LIMIT most recently
 * used. A failure is remembered for DEM_RETRY_MS, then tried again.
 * @returns {Promise<Uint8ClampedArray|null>}
 */
function demTile(x, y) {
	const key = `${x}/${y}`;
	let tile = demTiles.get(key);
	if (tile) {
		demTiles.delete(key);
		demTiles.set(key, tile);
		return tile;
	}
	tile = loadDemTile(x, y).then((pixels) => {
		if (!pixels) setTimeout(() => demTiles.get(key) === tile && demTiles.delete(key), DEM_RETRY_MS);
		return pixels;
	});
	demTiles.set(key, tile);
	if (demTiles.size > DEM_TILE_LIMIT) demTiles.delete(demTiles.keys().next().value);
	return tile;
}

/**
 * A terrain tile's RGBA pixels: from the cache, else downloaded (and cached
 * for the map's topo mode too). Null when it can't be had or decoded (an old
 * browser without OffscreenCanvas).
 * @returns {Promise<Uint8ClampedArray|null>}
 */
async function loadDemTile(x, y) {
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
		return null;
	}
}
