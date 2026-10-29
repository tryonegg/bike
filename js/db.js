/**
 * The IndexedDB persistence layer: one shared connection, a generic
 * transaction helper, and thin CRUD wrappers over the "sessions" (saved
 * rides), "summaries" (one small record per ride), "preferences", "routes"
 * (saved planned routes), "checkpointPoints" (the in-progress ride's
 * points) and "paceSections" (the best pace map) object stores. No other
 * module talks to `indexedDB` directly.
 */

import {
	DB_NAME,
	DB_VERSION,
	SESSION_STORE,
	PREF_STORE,
	ROUTE_STORE,
	SUMMARY_STORE,
	CHECKPOINT_STORE,
	PACE_SECTION_STORE,
	LIVE_MAP_ZOOM,
	MAP_STYLE_NAMES,
	ACTIVITIES,
	CALENDAR_COLOR_NOTES,
	GUIDE_HIDE_DISTANCE_OPTIONS_M,
	GUIDE_HIDE_DISTANCE_DEFAULT_M,
	BACK_TO_START_MODES,
	BACK_TO_START_DEFAULT,
} from "./constants.js";
import { state } from "./state.js";

// Shared IndexedDB connection, opened once by openDB(). Declared here because
// init() reaches openDB() well before the function's own definition is evaluated.
let dbPromise = null;

/**
 * Opens (or returns the already-open) shared IndexedDB connection, creating
 * the object stores on first run. One connection is shared by every store
 * operation — opening a fresh one per call would leak a live IDBDatabase each
 * time and block any future version upgrade.
 *
 * @returns {Promise<IDBDatabase>} Resolves once the database is open.
 */
export function openDB() {
	if (dbPromise) return dbPromise;

	const pending = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SESSION_STORE)) {
				db.createObjectStore(SESSION_STORE, { keyPath: "id", autoIncrement: true });
			}
			if (!db.objectStoreNames.contains(PREF_STORE)) {
				db.createObjectStore(PREF_STORE, { keyPath: "key" });
			}
			if (!db.objectStoreNames.contains(ROUTE_STORE)) {
				db.createObjectStore(ROUTE_STORE, { keyPath: "id", autoIncrement: true });
			}
			if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
				db.createObjectStore(CHECKPOINT_STORE, { keyPath: "start" });
			}
			if (!db.objectStoreNames.contains(PACE_SECTION_STORE)) {
				db.createObjectStore(PACE_SECTION_STORE, { keyPath: "id", autoIncrement: true });
			}
			if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
				const summaries = db.createObjectStore(SUMMARY_STORE, { keyPath: "id" });
				// Rides saved before summaries existed get theirs now, once.
				request.transaction.objectStore(SESSION_STORE).openCursor().onsuccess = (event) => {
					const cursor = event.target.result;
					if (!cursor) return;
					summaries.put(summarizeSession(cursor.value));
					cursor.continue();
				};
			}
		};

		// Drop the cached handle if this connection goes away, so the next call
		// reopens instead of reusing a dead database.
		const forget = () => {
			if (dbPromise === pending) dbPromise = null;
		};

		request.onsuccess = () => {
			const db = request.result;
			db.onclose = forget;
			db.onversionchange = () => {
				db.close();
				forget();
			};
			resolve(db);
		};
		request.onerror = () => {
			forget();
			reject(request.error);
		};
	});

	dbPromise = pending;
	return pending;
}

/**
 * Runs `fn` against an object store inside a fresh transaction, wrapping the
 * transaction's completion/failure in a promise. This is the one place that
 * talks to raw `IDBTransaction`/`IDBObjectStore` — every other DB function in
 * this file is a thin wrapper over a `withStore` call.
 *
 * @param {string} storeName - `SESSION_STORE` or `PREF_STORE`.
 * @param {IDBTransactionMode} mode - `"readonly"` or `"readwrite"`.
 * @param {(store: IDBObjectStore) => IDBRequest|*} fn - Called synchronously
 *   with the open store; its return value (or that value's `.result`, if it
 *   looks like an `IDBRequest`) becomes this function's resolved value.
 * @returns {Promise<*>} Resolves with `fn`'s result once the transaction
 *   completes, or rejects with the transaction's error.
 */
export async function withStore(storeName, mode, fn) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, mode);
		const store = tx.objectStore(storeName);
		const result = fn(store);

		tx.oncomplete = () => resolve(result?.result ?? result);
		// A transaction can abort without any request failing (a full disk
		// raises QuotaExceededError this way), and then onerror never fires.
		tx.onerror = tx.onabort = () => reject(transactionError(tx));
	});
}

/**
 * Runs `fn` against a transaction over several stores, for writes that must
 * land together or not at all (a ride and its summary, say).
 *
 * @param {Array<string>} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => (() => *)|void} fn - Called synchronously
 *   with the open transaction. It may return a function, called once the
 *   transaction completes, whose value this resolves with (an id learned
 *   from a request's result, say).
 * @returns {Promise<*>}
 */
async function withStores(storeNames, mode, fn) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeNames, mode);
		const after = fn(tx);
		tx.oncomplete = () => resolve(typeof after === "function" ? after() : undefined);
		tx.onerror = tx.onabort = () => reject(transactionError(tx));
	});
}

/**
 * What a failed or aborted transaction rejects with. `tx.error` is null when
 * the transaction was aborted outright rather than by a failing request.
 *
 * @param {IDBTransaction} tx
 * @returns {Error}
 */
function transactionError(tx) {
	return tx.error ?? new DOMException("The database transaction was aborted.", "AbortError");
}

/**
 * Persists a single preference value.
 *
 * @param {string} key - Preference name.
 * @param {*} value - Any structured-cloneable value.
 * @returns {Promise<void>}
 */
export async function setPref(key, value) {
	await withStore(PREF_STORE, "readwrite", (store) => store.put({ key, value }));
}

/**
 * Reads a single preference value.
 *
 * @param {string} key - Preference name.
 * @param {*} fallback - Returned when the key has never been set.
 * @returns {Promise<*>} The stored value, or `fallback`.
 */
export async function getPref(key, fallback) {
	const result = await withStore(PREF_STORE, "readonly", (store) => store.get(key));
	return result?.value ?? fallback;
}

/**
 * Loads every preference from IndexedDB into `state.prefs`, applying
 * defaults and validating anything that could have come from an imported
 * backup (an out-of-range zoom, an unknown activity/calendar-color key)
 * rather than trusting it outright. Called once during `init()`, and again
 * after a data import.
 *
 * @returns {Promise<void>}
 */
export async function loadPrefs() {
	// One read for every preference, rather than a transaction per key.
	const stored = new Map(
		((await withStore(PREF_STORE, "readonly", (store) => store.getAll())) || []).map((pref) => [pref.key, pref.value]),
	);
	const pref = (key, fallback) => stored.get(key) ?? fallback;

	state.prefs.unit = pref("unit", "imperial");
	state.prefs.theme = pref("theme", "light");
	state.prefs.stadiaKey = pref("stadiaKey", "");
	const mapType = pref("mapType", "road");
	// Satellite was dropped (Stadia only serves it on a paid plan), and an
	// imported backup could carry any value.
	state.prefs.mapType = mapType === "road" || mapType in MAP_STYLE_NAMES ? mapType : "road";
	state.prefs.terrain3d = pref("terrain3d", false) === true;
	state.prefs.buildings3d = pref("buildings3d", false) === true;
	state.prefs.planGrades = pref("planGrades", false) === true;
	// Checked because an imported backup could carry anything, and a bad zoom
	// would leave the live map unable to draw.
	const liveMapZoom = pref("liveMapZoom", LIVE_MAP_ZOOM);
	state.prefs.liveMapZoom = Number.isFinite(liveMapZoom) ? liveMapZoom : LIVE_MAP_ZOOM;
	state.prefs.comparePastRides = pref("comparePastRides", true) !== false;
	state.prefs.rideStatsSide = pref("rideStatsSide", "left") === "right" ? "right" : "left";
	state.prefs.guideContrast = pref("guideContrast", "high");
	state.prefs.markerSize = pref("markerSize", "medium");
	const guideHideDistance = pref("guideHideDistance", GUIDE_HIDE_DISTANCE_DEFAULT_M);
	state.prefs.guideHideDistance = GUIDE_HIDE_DISTANCE_OPTIONS_M.includes(guideHideDistance)
		? guideHideDistance
		: GUIDE_HIDE_DISTANCE_DEFAULT_M;
	const backToStart = pref("backToStart", BACK_TO_START_DEFAULT);
	state.prefs.backToStart = BACK_TO_START_MODES.includes(backToStart) ? backToStart : BACK_TO_START_DEFAULT;
	state.prefs.routeAvoidRetrace = pref("routeAvoidRetrace", false) === true;
	state.prefs.rideRouteMode = pref("rideRouteMode", "asis") === "points" ? "points" : "asis";
	state.prefs.navRouteVisual = pref("navRouteVisual", true) !== false;
	state.prefs.navRouteVoice = pref("navRouteVoice", false) === true;
	state.prefs.navHomeVisual = pref("navHomeVisual", false) === true;
	state.prefs.navHomeVoice = pref("navHomeVoice", false) === true;
	state.prefs.navHillVoice = pref("navHillVoice", true) !== false;
	const voiceURI = pref("voiceURI", "");
	state.prefs.voiceURI = typeof voiceURI === "string" ? voiceURI : "";
	const voiceVolume = pref("voiceVolume", 1);
	state.prefs.voiceVolume = Number.isFinite(voiceVolume) && voiceVolume >= 0 && voiceVolume <= 1 ? voiceVolume : 1;
	await migratePlannedRoute(pref("plannedRoute", null));
	state.prefs.ridesView = pref("ridesView", "list");
	const statsActivity = pref("statsActivity", "all");
	state.prefs.statsActivity = statsActivity === "all" || ACTIVITIES[statsActivity] ? statsActivity : "all";
	const calendarColor = pref("calendarColor", "distance");
	state.prefs.calendarColor = CALENDAR_COLOR_NOTES[calendarColor] ? calendarColor : "distance";
	state.prefs.installDismissed = pref("installDismissed", false);
	state.prefs.debugGpsAccuracy = pref("debugGpsAccuracy", false) === true;
	state.prefs.debugClipGpsWarmup = pref("debugClipGpsWarmup", false) === true;
	state.prefs.dataSaver = pref("dataSaver", false);
}

/**
 * Moves the single planned route that earlier versions kept as a preference
 * (or that an old backup restored as one) into the routes store.
 * @param {Object|null} plan - The "plannedRoute" preference's value.
 * @returns {Promise<void>}
 */
async function migratePlannedRoute(plan) {
	if (!plan) return;
	if (isRoute(plan)) {
		const now = new Date().toISOString();
		await putRoute({ ...plan, name: plan.name || "Planned route", created: now, updated: now });
	}
	await setPref("plannedRoute", null);
}

/**
 * Whether a value looks like a saved route, for anything read back from
 * storage or a backup file.
 * @param {*} route
 * @returns {boolean}
 */
export function isRoute(route) {
	return Boolean(route) && Array.isArray(route.waypoints) && Array.isArray(route.legs) && Array.isArray(route.coords);
}

/**
 * Whether a value looks like a saved ride, for anything read back from a
 * backup file: a real date, a list of points and a distance.
 * @param {*} session
 * @returns {boolean}
 */
export function isSession(session) {
	return (
		Boolean(session) &&
		typeof session === "object" &&
		Number.isFinite(new Date(session.date).getTime()) &&
		Array.isArray(session.points) &&
		Number.isFinite(session.totalDistance) &&
		session.totalDistance >= 0
	);
}

/**
 * Writes a backup's rides, routes and preferences in one transaction, so a
 * failure part way through (a full disk, say) leaves the database exactly as
 * it was instead of half imported. Records get fresh ids from their stores.
 *
 * @param {{sessions: Array<Object>, routes: Array<Object>, prefs: Array<{key: string, value: *}>}} records
 * @returns {Promise<void>}
 */
export async function importRecords({ sessions, routes, prefs }) {
	await withStores([SESSION_STORE, SUMMARY_STORE, ROUTE_STORE, PREF_STORE], "readwrite", (tx) => {
		for (const { id, ...rest } of sessions) addSessionIn(tx, rest);
		const routeStore = tx.objectStore(ROUTE_STORE);
		for (const { id, ...rest } of routes) routeStore.add(rest);
		const prefStore = tx.objectStore(PREF_STORE);
		for (const pref of prefs) prefStore.put(pref);
	});
}

/**
 * Saves a planned route, adding it when it has no id yet.
 * @param {Object} route - See route-plan.js for the shape.
 * @returns {Promise<number>} Its id.
 */
export async function putRoute(route) {
	return withStore(ROUTE_STORE, "readwrite", (store) => store.put(route));
}

/**
 * Reads every saved route, most recently changed first.
 * @returns {Promise<Array<Object>>}
 */
export async function getAllRoutes() {
	const routes = (await withStore(ROUTE_STORE, "readonly", (store) => store.getAll())) || [];
	return routes.filter(isRoute).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/**
 * Reads one saved route.
 * @param {number} id
 * @returns {Promise<Object|undefined>}
 */
export async function getRoute(id) {
	// For a missing key withStore hands back the request itself, not undefined.
	const route = await withStore(ROUTE_STORE, "readonly", (store) => store.get(id));
	return isRoute(route) ? route : undefined;
}

/**
 * Deletes one saved route.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteRoute(id) {
	await withStore(ROUTE_STORE, "readwrite", (store) => store.delete(id));
}

/**
 * Saves a finished ride to the sessions store.
 *
 * @param {Object} session - Plain session record (not the live in-progress
 *   session object — see `finalizeSession` in live-session.js for the shape).
 * @returns {Promise<number>} The new session's auto-assigned id.
 */
export async function addSession(session) {
	return withStores([SESSION_STORE, SUMMARY_STORE], "readwrite", (tx) => {
		const request = addSessionIn(tx, session);
		return () => request.result;
	});
}

/**
 * Adds a ride, and its summary once the ride has its id, inside a
 * transaction that spans both stores.
 *
 * @param {IDBTransaction} tx
 * @param {Object} session
 * @returns {IDBRequest} The ride's add request; its result is the new id.
 */
function addSessionIn(tx, session) {
	const request = tx.objectStore(SESSION_STORE).add(session);
	request.onsuccess = () => {
		tx.objectStore(SUMMARY_STORE).put(summarizeSession({ ...session, id: request.result }));
	};
	return request;
}

/**
 * The summary record kept for a ride: what the rides list, calendar, totals
 * and merge picker need, with the first and last fix times standing in for
 * the points themselves.
 *
 * @param {Object} session - A saved ride, with its id.
 * @returns {Object}
 */
export function summarizeSession(session) {
	const points = Array.isArray(session.points) ? session.points : [];
	const first = points[0]?.timestamp;
	const last = points[points.length - 1]?.timestamp;
	return {
		id: session.id,
		date: session.date,
		activityType: session.activityType,
		totalDistance: session.totalDistance,
		movingTime: session.movingTime,
		avgSpeed: session.avgSpeed,
		routeId: session.routeId ?? null,
		startTime: Number.isFinite(first) ? first : null,
		endTime: Number.isFinite(last) ? last : null,
	};
}

/**
 * Makes sure every saved ride has a summary and every summary a ride, since
 * the rides list reads only summaries and a ride without one would vanish
 * from it. Counting both stores is cheap, so that's all a normal startup
 * does; only when the counts differ are the rides read (points and all) and
 * the summaries put right. A summary already there is kept as it is, so it
 * keeps its place in the best pace map.
 *
 * @returns {Promise<boolean>} Whether anything needed repairing.
 */
export async function repairSessionSummaries() {
	const counts = await withStores([SESSION_STORE, SUMMARY_STORE], "readonly", (tx) => {
		const rides = tx.objectStore(SESSION_STORE).count();
		const summaries = tx.objectStore(SUMMARY_STORE).count();
		return () => [rides.result, summaries.result];
	});
	if (counts[0] === counts[1]) return false;

	await withStores([SESSION_STORE, SUMMARY_STORE], "readwrite", (tx) => {
		const summaries = tx.objectStore(SUMMARY_STORE);
		summaries.getAllKeys().onsuccess = (event) => {
			const orphans = new Set(event.target.result);
			tx.objectStore(SESSION_STORE).openCursor().onsuccess = (cursorEvent) => {
				const cursor = cursorEvent.target.result;
				if (!cursor) {
					for (const id of orphans) summaries.delete(id);
					return;
				}
				if (!orphans.delete(cursor.key)) summaries.put(summarizeSession(cursor.value));
				cursor.continue();
			};
		};
	});
	return true;
}

/**
 * Reads every saved ride's summary (see `summarizeSession`), without any
 * of their GPS points.
 *
 * @returns {Promise<Array<Object>>} In store order (unsorted).
 */
export async function getAllSessionSummaries() {
	return (await withStore(SUMMARY_STORE, "readonly", (store) => store.getAll())) || [];
}

/**
 * Reads every saved ride.
 *
 * @returns {Promise<Array<Object>>} All sessions, in store order (unsorted).
 */
export async function getAllSessions() {
	const req = await withStore(SESSION_STORE, "readonly", (store) => store.getAll());
	return req || [];
}

/**
 * Counts the saved rides without reading them.
 *
 * @returns {Promise<number>}
 */
export async function countSessions() {
	return withStore(SESSION_STORE, "readonly", (store) => store.count());
}

/**
 * Counts the saved routes without reading them.
 *
 * @returns {Promise<number>}
 */
export async function countRoutes() {
	return withStore(ROUTE_STORE, "readonly", (store) => store.count());
}

/**
 * Reads one saved ride by id.
 *
 * @param {number} id
 * @returns {Promise<Object|undefined>} The session, or `undefined` if no
 *   session has that id.
 */
export async function getSessionById(id) {
	return withStore(SESSION_STORE, "readonly", (store) => store.get(id));
}

/**
 * Deletes one saved ride.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteSessionById(id) {
	await withStores([SESSION_STORE, SUMMARY_STORE], "readwrite", (tx) => {
		tx.objectStore(SESSION_STORE).delete(id);
		tx.objectStore(SUMMARY_STORE).delete(id);
	});
}

/**
 * Deletes every saved ride. Preferences are untouched.
 *
 * @returns {Promise<void>}
 */
export async function clearAllSessions() {
	await withStores([SESSION_STORE, SUMMARY_STORE], "readwrite", (tx) => {
		tx.objectStore(SESSION_STORE).clear();
		tx.objectStore(SUMMARY_STORE).clear();
	});
}

/**
 * Reads every section of the best pace map.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getAllPaceSections() {
	return (await withStore(PACE_SECTION_STORE, "readonly", (store) => store.getAll())) || [];
}

/**
 * Saves the best pace map's sections changed by one ride, and marks that
 * ride's summary as mapped, in one transaction: a ride is never counted
 * twice, nor marked without its sections. New sections are given their ids
 * in place.
 *
 * @param {number} rideId
 * @param {Array<Object>} sections - New (no id yet) and updated records.
 * @returns {Promise<void>}
 */
export async function savePaceSections(rideId, sections) {
	await withStores([PACE_SECTION_STORE, SUMMARY_STORE], "readwrite", (tx) => {
		const store = tx.objectStore(PACE_SECTION_STORE);
		for (const section of sections) {
			const request = store.put(section);
			request.onsuccess = () => {
				section.id = request.result;
			};
		}
		markPaceMapped(tx.objectStore(SUMMARY_STORE), rideId);
	});
}

/**
 * Updates some of the best pace map's sections and deletes others, in one
 * transaction.
 *
 * @param {Array<Object>} sections - Records to write back.
 * @param {Array<number>} deleteIds
 * @returns {Promise<void>}
 */
export async function replacePaceSections(sections, deleteIds) {
	await withStore(PACE_SECTION_STORE, "readwrite", (store) => {
		for (const section of sections) store.put(section);
		for (const id of deleteIds) store.delete(id);
	});
}

/**
 * Marks a ride's summary as taken into the best pace map without changing
 * it, for a ride with nothing to map (too few points, say).
 *
 * @param {number} rideId
 * @returns {Promise<void>}
 */
export async function markRidePaceMapped(rideId) {
	await withStore(SUMMARY_STORE, "readwrite", (store) => markPaceMapped(store, rideId));
}

/**
 * Empties the best pace map and marks every ride as not yet in it, so it is
 * built again from the rides saved now.
 *
 * @returns {Promise<void>}
 */
export async function clearPaceSections() {
	await withStores([PACE_SECTION_STORE, SUMMARY_STORE], "readwrite", (tx) => {
		tx.objectStore(PACE_SECTION_STORE).clear();
		tx.objectStore(SUMMARY_STORE).openCursor().onsuccess = (event) => {
			const cursor = event.target.result;
			if (!cursor) return;
			if (cursor.value.paceMapped) cursor.update({ ...cursor.value, paceMapped: false });
			cursor.continue();
		};
	});
}

/** Flags a summary as taken into the best pace map, inside an open transaction. */
function markPaceMapped(summaries, rideId) {
	const request = summaries.get(rideId);
	request.onsuccess = () => {
		if (request.result) summaries.put({ ...request.result, paceMapped: true });
	};
}

/**
 * Saves an in-progress ride's checkpoint: its small state record, under
 * `key` in the preferences store, and the points recorded since the last
 * save, as one chunk starting at index `start`. Both land in one
 * transaction, so the record never describes points that weren't saved.
 *
 * @param {string} key - The preference key the record lives under.
 * @param {number} start - Index of the chunk's first point in the ride.
 * @param {Array<Object>} points - The chunk.
 * @param {Object} record - Everything but the points.
 * @returns {Promise<void>}
 */
export async function writeCheckpoint(key, start, points, record) {
	await withStores([PREF_STORE, CHECKPOINT_STORE], "readwrite", (tx) => {
		const chunks = tx.objectStore(CHECKPOINT_STORE);
		// A save from the first point starts a new ride's chunks.
		if (start === 0) chunks.clear();
		if (points.length) chunks.put({ start, points });
		tx.objectStore(PREF_STORE).put({ key, value: record });
	});
}

/**
 * Reads the in-progress ride's saved points back into one array. Chunks may
 * overlap by a point (a save rewrites the last point before it, which data
 * saver can replace), so each is laid down at its own index, later over
 * earlier.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function readCheckpointPoints() {
	const chunks = (await withStore(CHECKPOINT_STORE, "readonly", (store) => store.getAll())) || [];
	const points = [];
	for (const chunk of chunks.sort((a, b) => a.start - b.start)) {
		chunk.points.forEach((point, index) => {
			points[chunk.start + index] = point;
		});
	}
	return points.filter(Boolean);
}

/**
 * Clears the in-progress ride's checkpoint: its record and its points.
 *
 * @param {string} key - The preference key the record lives under.
 * @returns {Promise<void>}
 */
export async function clearCheckpoint(key) {
	await withStores([PREF_STORE, CHECKPOINT_STORE], "readwrite", (tx) => {
		tx.objectStore(CHECKPOINT_STORE).clear();
		tx.objectStore(PREF_STORE).put({ key, value: null });
	});
}
