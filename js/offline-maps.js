/**
 * Offline map areas: downloading every map tile for an area ahead of time,
 * so the map draws there with no signal. The service worker's ordinary tile
 * cache only keeps what has been on screen, and evicts the tiles longest
 * unused; a saved area's tiles go into a cache of their own that nothing
 * evicts, which the worker also serves from (sw.js's `tileFirst`).
 *
 * An area is saved from the route planner (the map area in view) and listed,
 * with a Delete button, on the settings screen. For each area that's the
 * OpenFreeMap vector tiles at every zoom, which the Road, Topo and Bright
 * styles draw and routing reads, and the terrain tiles behind Topo's relief
 * and the grade readouts. Areas are recorded under one preference key as
 * `{id, name, bounds: [west, south, east, north], tiles, bytes, created}`;
 * the tiles themselves aren't listed, since an area's are worked out again
 * from its bounds.
 */

import { DEM_TILE_URL, DEM_MAX_ZOOM } from "./constants.js";
import { state, el } from "./state.js";
import { getPref, setPref } from "./db.js";
import { escapeHtml } from "./format.js";
import { showModal, showMessage, confirmWithModal, closeModal } from "./modal.js";

/** The preference the saved areas are listed under. Left out of backups (data-io.js). */
export const OFFLINE_AREAS_KEY = "offlineAreas";
// Must match sw.js's OFFLINE_CACHE and the prefix route-worker.js reads tiles from.
const OFFLINE_CACHE = "bike-tracker-offline-v1";
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
// OpenFreeMap's tiles stop at this zoom; the map draws closer zooms from them.
const VECTOR_MAX_ZOOM = 14;
// Terrain is saved from this zoom in. Further out, relief only shows on a map
// zoomed too far out to ride by.
const DEM_MIN_ZOOM = 10;
// The most tiles one area may hold: about a 60 km square. Beyond that the
// download is hundreds of megabytes, and better split into areas.
const MAX_AREA_TILES = 4000;
const DOWNLOAD_CONCURRENCY = 6;
// For the size quoted before downloading; real tiles vary a lot, town to country.
const ESTIMATED_TILE_BYTES = 45000;
// The few tiles of the zoomed-out world every area includes are far larger.
const ESTIMATED_BASE_BYTES = 2500000;

/**
 * The tile a point falls in at a zoom.
 * @returns {{x: number, y: number}}
 */
function tileAt(lng, lat, zoom) {
	const size = 2 ** zoom;
	const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
	const x = Math.floor(((lng + 180) / 360) * size);
	const y = Math.floor(((1 - Math.asinh(Math.tan((clampedLat * Math.PI) / 180)) / Math.PI) / 2) * size);
	return { x: Math.max(0, Math.min(size - 1, x)), y: Math.max(0, Math.min(size - 1, y)) };
}

/** Every "z/x/y" tile touching the bounds, from `minZoom` to `maxZoom`. */
function tilesIn([west, south, east, north], minZoom, maxZoom) {
	const keys = [];
	for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
		const topLeft = tileAt(west, north, zoom);
		const bottomRight = tileAt(east, south, zoom);
		for (let x = topLeft.x; x <= bottomRight.x; x++) {
			for (let y = topLeft.y; y <= bottomRight.y; y++) keys.push(`${zoom}/${x}/${y}`);
		}
	}
	return keys;
}

/**
 * The tiles an area needs, as "z/x/y" keys.
 * @param {[number, number, number, number]} bounds - West, south, east, north.
 * @returns {{vector: string[], dem: string[]}}
 */
export function areaTiles(bounds) {
	return { vector: tilesIn(bounds, 0, VECTOR_MAX_ZOOM), dem: tilesIn(bounds, DEM_MIN_ZOOM, DEM_MAX_ZOOM) };
}

/** How many tiles the area needs, without listing them (a zoomed-out view can be millions). */
function countAreaTiles([west, south, east, north]) {
	const count = (minZoom, maxZoom) => {
		let total = 0;
		for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
			const a = tileAt(west, north, zoom);
			const b = tileAt(east, south, zoom);
			total += (b.x - a.x + 1) * (b.y - a.y + 1);
		}
		return total;
	};
	return count(0, VECTOR_MAX_ZOOM) + count(DEM_MIN_ZOOM, DEM_MAX_ZOOM);
}

/** A cached tile's host and "z/x/y", whatever versioned path it sits under, or null for anything else. */
function tileIdentity(url) {
	const match = /^https:\/\/([^/]+)\/(?:.*\/)?(\d+)\/(\d+)\/(\d+)\.(?:pbf|png)$/.exec(url);
	return match ? `${match[1]}/${match[2]}/${match[3]}/${match[4]}` : null;
}

/** The saved areas, newest first. */
export async function offlineAreas() {
	const areas = await getPref(OFFLINE_AREAS_KEY, []);
	return Array.isArray(areas) ? areas.filter((area) => Array.isArray(area?.bounds) && area.bounds.length === 4) : [];
}

/** Tells the service worker its index of saved tiles is out of date. */
function notifyWorker() {
	navigator.serviceWorker?.controller?.postMessage({ type: "OFFLINE_TILES_CHANGED" });
}

/**
 * A byte count as a short size, e.g. "42 MB".
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
	const mb = bytes / (1024 * 1024);
	if (mb < 1) return "under 1 MB";
	return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/**
 * The route planner's Save Offline button: offers to download the map area
 * in view, shows progress in the modal while it does (Cancel stops it), and
 * records the area. Tiles fetched before a cancel or a lost connection are
 * kept, so trying again carries on from them.
 *
 * @param {maplibregl.Map} map - The map whose view is the area.
 * @param {string} [name] - The area's name, e.g. the open route's.
 * @returns {Promise<void>}
 */
export async function saveOfflineArea(map, name = "") {
	if (!map) return;
	if (!("caches" in window)) {
		await showMessage("Offline Maps", "This browser can't store maps for offline use.");
		return;
	}
	const view = map.getBounds();
	const bounds = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()];
	const total = countAreaTiles(bounds);
	if (total > MAX_AREA_TILES) {
		await showMessage("Zoom In First", `The area on screen is too large to save at once (${total.toLocaleString()} map tiles; the most is ${MAX_AREA_TILES.toLocaleString()}). Zoom in to the part you'll ride, or save it as several smaller areas.`);
		return;
	}

	const stadiaNote = state.prefs.stadiaKey ? " Saved areas use the free Road, Topo, Bike and Bright styles, not Stadia's." : "";
	const ok = await confirmWithModal({
		title: "Save This Area Offline?",
		message: `The map on screen will be downloaded so it works without a signal: about ${total.toLocaleString()} tiles, roughly ${formatSize(ESTIMATED_BASE_BYTES + total * ESTIMATED_TILE_BYTES)}. Best done on Wi-Fi.${stadiaNote}`,
		confirmText: "Download",
		cancelText: "Cancel",
	});
	if (!ok) return;

	let template;
	try {
		template = (await (await fetch(TILEJSON_URL)).json()).tiles?.[0];
	} catch {
		template = null;
	}
	if (!template) {
		await showMessage("Offline Maps", "The map server couldn't be reached. Check your connection and try again.");
		return;
	}

	const tiles = areaTiles(bounds);
	const urls = [
		...tiles.vector.map((key) => {
			const [z, x, y] = key.split("/");
			return template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
		}),
		...tiles.dem.map((key) => {
			const [z, x, y] = key.split("/");
			return DEM_TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
		}),
	];

	// The progress modal: its Cancel button (or anything else closing it) stops the download.
	let cancelled = false;
	let finished = false;
	const progress = showModal({ title: "Saving Map", message: `0 of ${urls.length.toLocaleString()} tiles`, cancelText: "Cancel", hideConfirm: true });
	progress.then(() => {
		if (!finished) cancelled = true;
	});

	const result = await downloadTiles(urls, {
		isCancelled: () => cancelled,
		onProgress: (done) => {
			if (!cancelled && !finished) el.modalMessage.textContent = `${done.toLocaleString()} of ${urls.length.toLocaleString()} tiles`;
		},
	});
	finished = true;
	if (!cancelled) closeModal("confirm");
	notifyWorker();

	if (!result.saved) {
		await showMessage("Offline Maps", cancelled ? "Nothing was saved." : "No map tiles could be downloaded. Check your connection and try again.");
		return;
	}

	const areas = await offlineAreas();
	const created = new Date();
	areas.unshift({
		id: created.getTime(),
		name: name.trim() || `Area saved ${created.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
		bounds,
		tiles: result.saved,
		bytes: result.bytes,
		created: created.toISOString(),
	});
	await setPref(OFFLINE_AREAS_KEY, areas);
	navigator.storage?.persist?.().catch(() => {});

	const missed = urls.length - result.saved;
	if (cancelled || missed) {
		await showMessage("Area Partly Saved", `${result.saved.toLocaleString()} of ${urls.length.toLocaleString()} tiles were saved${cancelled ? " before you stopped" : "; the rest couldn't be downloaded"}. Save the same area again to get the rest, or delete it in Settings under Offline maps.`);
	} else {
		await showMessage("Area Saved", `This part of the map now works offline. Saved areas are listed in Settings under Offline maps.`);
	}
}

/**
 * Downloads tiles into the offline cache, a few at a time. A tile already
 * there is counted without being fetched, and one in the worker's ordinary
 * tile cache is copied across rather than downloaded again.
 *
 * @param {string[]} urls
 * @param {{isCancelled: () => boolean, onProgress: (done: number) => void}} hooks
 * @returns {Promise<{saved: number, bytes: number}>} Tiles now in the cache, and the bytes newly stored.
 */
async function downloadTiles(urls, { isCancelled, onProgress }) {
	const cache = await caches.open(OFFLINE_CACHE);
	let next = 0;
	let done = 0;
	let saved = 0;
	let bytes = 0;

	const worker = async () => {
		while (next < urls.length && !isCancelled()) {
			const url = urls[next++];
			try {
				if (await cache.match(url)) {
					saved++;
				} else {
					// "no-store" also marks the request for sw.js to leave alone, so the
					// tile isn't stored a second time in the worker's own tile cache.
					const response = (await caches.match(url)) ?? (await fetch(url, { cache: "no-store" }));
					if (response.ok) {
						bytes += Number(response.headers.get("content-length")) || 0;
						await cache.put(url, response);
						saved++;
					}
				}
			} catch {
				// Offline, blocked or out of space: this tile stays missing.
			}
			onProgress(++done);
		}
	};
	await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
	return { saved, bytes };
}

/**
 * Deletes a saved area and its tiles, keeping any tile another saved area
 * also covers.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteOfflineArea(id) {
	const areas = await offlineAreas();
	const area = areas.find((candidate) => candidate.id === id);
	if (!area) return;
	const rest = areas.filter((candidate) => candidate.id !== id);

	const keep = new Set();
	for (const other of rest) {
		const tiles = areaTiles(other.bounds);
		for (const key of tiles.vector) keep.add(`v/${key}`);
		for (const key of tiles.dem) keep.add(`d/${key}`);
	}
	const tiles = areaTiles(area.bounds);
	const drop = new Set([...tiles.vector.map((key) => `v/${key}`), ...tiles.dem.map((key) => `d/${key}`)].filter((key) => !keep.has(key)));

	if ("caches" in window) {
		const demHost = new URL(DEM_TILE_URL.replace(/[{}]/g, "")).hostname;
		const cache = await caches.open(OFFLINE_CACHE);
		for (const request of await cache.keys()) {
			const identity = tileIdentity(request.url);
			if (!identity) continue;
			const [host, ...zxy] = identity.split("/");
			if (drop.has(`${host === demHost ? "d" : "v"}/${zxy.join("/")}`)) await cache.delete(request);
		}
	}
	await setPref(OFFLINE_AREAS_KEY, rest);
	notifyWorker();
}

/** Fills the settings screen's list of saved areas. */
export async function renderOfflineAreas() {
	const areas = await offlineAreas();
	el.offlineAreasEmpty.hidden = areas.length > 0;
	el.offlineAreasCount.textContent = areas.length === 1 ? "1 area" : `${areas.length} areas`;
	el.offlineAreasList.replaceChildren(
		...areas.map((area) => {
			const li = document.createElement("li");
			li.className = "offline-area";
			const saved = new Date(area.created);
			const when = Number.isNaN(saved.getTime()) ? "" : `Saved ${saved.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · `;
			const size = area.bytes ? ` · ${formatSize(area.bytes)}` : "";
			li.innerHTML = `
				<span class="offline-area-text">
					<strong>${escapeHtml(area.name || "Saved area")}</strong>
					<span class="setting-note">${escapeHtml(`${when}${Number(area.tiles || 0).toLocaleString()} tiles${size}`)}</span>
				</span>
				<button class="text-danger" type="button">Delete</button>`;
			li.querySelector("button").addEventListener("click", async () => {
				const ok = await confirmWithModal({
					title: "Delete Saved Area?",
					message: `"${area.name || "Saved area"}" will no longer work offline. Parts of it you've looked at recently may still show.`,
					confirmText: "Delete",
					cancelText: "Keep",
					danger: true,
				});
				if (!ok) return;
				await deleteOfflineArea(area.id);
				await renderOfflineAreas();
			});
			return li;
		}),
	);
}
