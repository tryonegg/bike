/**
 * The IndexedDB persistence layer: one shared connection, a generic
 * transaction helper, and thin CRUD wrappers over the "sessions" (saved
 * rides) and "preferences" object stores. No other module talks to
 * `indexedDB` directly.
 */

import {
	DB_NAME,
	DB_VERSION,
	SESSION_STORE,
	PREF_STORE,
	LIVE_MAP_ZOOM,
	ACTIVITIES,
	CALENDAR_COLOR_NOTES,
	GUIDE_HIDE_DISTANCE_OPTIONS_M,
	GUIDE_HIDE_DISTANCE_DEFAULT_M,
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
		tx.onerror = () => reject(tx.error);
	});
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
	state.prefs.unit = await getPref("unit", "imperial");
	state.prefs.theme = await getPref("theme", "light");
	state.prefs.stadiaKey = await getPref("stadiaKey", "");
	state.prefs.mapType = await getPref("mapType", "road");
	state.prefs.terrain3d = (await getPref("terrain3d", false)) === true;
	// Checked because an imported backup could carry anything, and a bad zoom
	// would leave the live map unable to draw.
	const liveMapZoom = await getPref("liveMapZoom", LIVE_MAP_ZOOM);
	state.prefs.liveMapZoom = Number.isFinite(liveMapZoom) ? liveMapZoom : LIVE_MAP_ZOOM;
	state.prefs.comparePastRides = (await getPref("comparePastRides", true)) !== false;
	state.prefs.rideStatsSide = (await getPref("rideStatsSide", "left")) === "right" ? "right" : "left";
	state.prefs.guideContrast = await getPref("guideContrast", "high");
	state.prefs.markerSize = await getPref("markerSize", "medium");
	const guideHideDistance = await getPref("guideHideDistance", GUIDE_HIDE_DISTANCE_DEFAULT_M);
	state.prefs.guideHideDistance = GUIDE_HIDE_DISTANCE_OPTIONS_M.includes(guideHideDistance)
		? guideHideDistance
		: GUIDE_HIDE_DISTANCE_DEFAULT_M;
	state.prefs.ridesView = await getPref("ridesView", "list");
	const statsActivity = await getPref("statsActivity", "all");
	state.prefs.statsActivity = statsActivity === "all" || ACTIVITIES[statsActivity] ? statsActivity : "all";
	const calendarColor = await getPref("calendarColor", "distance");
	state.prefs.calendarColor = CALENDAR_COLOR_NOTES[calendarColor] ? calendarColor : "distance";
	state.prefs.installDismissed = await getPref("installDismissed", false);
	state.prefs.debugGpsAccuracy = (await getPref("debugGpsAccuracy", false)) === true;
	state.prefs.debugClipGpsWarmup = (await getPref("debugClipGpsWarmup", false)) === true;
	state.prefs.dataSaver = await getPref("dataSaver", false);
}

/**
 * Saves a finished ride to the sessions store.
 *
 * @param {Object} session - Plain session record (not the live in-progress
 *   session object — see `finalizeSession` in live-session.js for the shape).
 * @returns {Promise<number>} The new session's auto-assigned id.
 */
export async function addSession(session) {
	const req = await withStore(SESSION_STORE, "readwrite", (store) => store.add(session));
	return req;
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
	await withStore(SESSION_STORE, "readwrite", (store) => store.delete(id));
}

/**
 * Deletes every saved ride. Preferences are untouched.
 *
 * @returns {Promise<void>}
 */
export async function clearAllSessions() {
	await withStore(SESSION_STORE, "readwrite", (store) => store.clear());
}
