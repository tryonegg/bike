/**
 * Whole-database operations: deleting one or all saved rides, and the JSON
 * export/import that backs up (or moves between devices) every saved ride
 * plus every preference. See gpx.js for the separate single-ride GPX
 * import/export.
 */

import { ACTIVE_SESSION_KEY, PREF_STORE } from "./constants.js";
import { state, el } from "./state.js";
import { confirmWithModal, showMessage } from "./modal.js";
import { deleteSessionById, getAllSessions, clearAllSessions, withStore, loadPrefs, getAllRoutes, isRoute, isSession, importRecords } from "./db.js";
import { protectStoredData } from "./pwa.js";
import { navigateToScreen, applyRideLayout } from "./navigation.js";
import { renderPastRides } from "./history-view.js";

/**
 * The post-ride summary screen's "Delete" button handler: confirms, then
 * deletes the currently-viewed ride and returns home.
 * @returns {Promise<void>}
 */
export async function deleteCurrentRide() {
	if (!state.currentPostSession) return;
	const ok = await confirmWithModal({
		title: "Delete Ride?",
		message: "This ride will be removed permanently.",
		confirmText: "Delete",
		cancelText: "Cancel",
	});
	if (!ok) return;

	await deleteSessionById(state.currentPostSession.id);
	state.currentPostSession = null;
	navigateToScreen("home", "replace");
	await renderPastRides();
}

// Asks twice: once to say what will go, then again as the point of no return.
// An in-progress ride is not a saved ride, so its checkpoint is left alone.
/**
 * The settings screen's "Delete All Rides" handler: asks twice (once to say
 * what will go, then again as the point of no return) before wiping every
 * saved ride. Preferences are left untouched, and an in-progress ride's
 * checkpoint is not a saved ride, so it's left alone too.
 * @returns {Promise<void>}
 */
export async function deleteAllRides() {
	const count = (await getAllSessions()).length;
	if (!count) {
		await showMessage("No Rides to Delete", "There are no saved rides on this device.");
		return;
	}

	const rides = count === 1 ? "1 saved ride" : `all ${count} saved rides`;
	const first = await confirmWithModal({
		title: "Delete All Past Rides?",
		message: `This will remove ${rides} from this device. Your settings are kept.`,
		confirmText: "Continue",
		cancelText: "Cancel",
	});
	if (!first) return;

	const second = await confirmWithModal({
		title: "Are You Sure?",
		message: `${count === 1 ? "This ride" : `All ${count} rides`} will be deleted permanently and cannot be recovered. Export your data first if you might want ${count === 1 ? "it" : "them"} back.`,
		confirmText: count === 1 ? "Delete Ride" : `Delete ${count} Rides`,
		cancelText: "Keep Rides",
		danger: true,
	});
	if (!second) return;

	await clearAllSessions();
	state.currentPostSession = null;
	// The calendar's range is worked out from the rides, so let it start over.
	state.calendarMonth = null;
	await renderPastRides();
	await showMessage("Rides Deleted", "All past rides have been deleted.");
}

/**
 * Exports every saved ride, planned route and preference (excluding the Stadia
 * API key and the machine-local
 * active-ride checkpoint) as a downloadable JSON backup file.
 * @returns {Promise<void>}
 */
export async function exportAllData() {
	try {
		const sessions = await getAllSessions();
		const routes = await getAllRoutes();
		const prefs = await withStore(PREF_STORE, "readonly", (store) => store.getAll());
		const prefsObj = {};
		prefs.forEach((pref) => {
			// The in-progress ride checkpoint is machine-local scratch state, not a
			// preference; exporting it would resurrect a stranger's ride on import.
			if (pref.key === ACTIVE_SESSION_KEY) return;
			// An API key is a secret tied to the rider's Stadia account; a backup
			// file gets copied and shared too freely to carry it.
			if (pref.key === "stadiaKey") return;
			prefsObj[pref.key] = pref.value;
		});

		const data = {
			version: 1,
			exportDate: new Date().toISOString(),
			sessions,
			routes,
			preferences: prefsObj,
		};

		const json = JSON.stringify(data, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `bike-tracker-export-${new Date().toISOString().split("T")[0]}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		await showMessage("Export Success", "Your data has been exported successfully.");
	} catch (error) {
		await showMessage("Export Error", `Failed to export data: ${error.message}`);
	}
}

/**
 * A ride's identity across devices and backups: ids are reassigned on every
 * import, but no two real rides start at the same moment and cover the same
 * distance.
 * @param {Object} session
 * @returns {string}
 */
function sessionKey(session) {
	return `${new Date(session.date).getTime()}|${Math.round(session.totalDistance)}`;
}

/**
 * A saved route's identity across devices and backups, as for `sessionKey`.
 * @param {Object} route
 * @returns {string}
 */
function routeKey(route) {
	return `${route.name || ""}|${route.created || ""}|${route.coords.length}`;
}

/**
 * The hidden file input's `change` handler for JSON backup import: validates
 * the file, confirms with the rider (it overwrites preferences), and imports
 * every ride and route not already on this device, with fresh ids, all in one
 * transaction. Rides and routes that are already here, or that don't look
 * like one, are skipped, so importing the same backup twice adds nothing.
 *
 * @param {Event} event - A `change` event on `el.importFileInput`.
 * @returns {Promise<void>}
 */
export async function importAllData(event) {
	const file = event.target.files[0];
	if (!file) return;

	try {
		const text = await file.text();
		const data = JSON.parse(text);

		if (data?.version !== 1) {
			await showMessage("Import Error", "Unsupported file version.");
			return;
		}

		if (!Array.isArray(data.sessions) || !data.preferences || typeof data.preferences !== "object") {
			await showMessage("Import Error", "Invalid file format.");
			return;
		}

		const fileRoutes = Array.isArray(data.routes) ? data.routes : [];
		const haveSessions = new Set((await getAllSessions()).filter(isSession).map(sessionKey));
		const haveRoutes = new Set((await getAllRoutes()).map(routeKey));

		// Keyed sets also catch a ride listed twice within the file itself.
		const sessions = [];
		let invalid = 0;
		let duplicates = 0;
		for (const session of data.sessions) {
			if (!isSession(session)) {
				invalid += 1;
				continue;
			}
			const key = sessionKey(session);
			if (haveSessions.has(key)) {
				duplicates += 1;
				continue;
			}
			haveSessions.add(key);
			sessions.push(session);
		}
		const routes = [];
		for (const route of fileRoutes) {
			if (!isRoute(route)) {
				invalid += 1;
				continue;
			}
			const key = routeKey(route);
			if (haveRoutes.has(key)) {
				duplicates += 1;
				continue;
			}
			haveRoutes.add(key);
			routes.push(route);
		}

		const prefs = [];
		for (const [key, value] of Object.entries(data.preferences)) {
			if (key === ACTIVE_SESSION_KEY) continue;
			// Backups no longer carry the Stadia key, but older ones did. Restore it
			// only onto a device without one, never over a key already entered here.
			if (key === "stadiaKey" && (state.prefs.stadiaKey || typeof value !== "string")) continue;
			prefs.push({ key, value });
		}

		const adding = [plural(sessions.length, "ride"), routes.length ? plural(routes.length, "route") : ""].filter(Boolean).join(" and ");
		const skipping = duplicates ? ` ${plural(duplicates, "duplicate")} will be skipped.` : "";
		const confirmed = await confirmWithModal({
			title: "Import Confirmation",
			message: `This will import ${adding} and overwrite your preferences.${skipping} Continue?`,
			confirmText: "Import",
			cancelText: "Cancel",
		});

		el.importFileInput.value = "";

		if (!confirmed) return;

		await importRecords({ sessions, routes, prefs });

		await loadPrefs();
		applyRideLayout();
		await renderPastRides();
		protectStoredData();
		const notes = [
			duplicates ? `Skipped ${plural(duplicates, "duplicate")}.` : "",
			invalid ? `Skipped ${plural(invalid, "item")} that couldn't be read.` : "",
		].filter(Boolean);
		await showMessage("Import Success", `Imported ${adding}.${notes.length ? ` ${notes.join(" ")}` : ""}`);
	} catch (error) {
		el.importFileInput.value = "";
		await showMessage("Import Error", `Failed to import data: ${error.message}`);
	}
}

/**
 * A count with its noun, e.g. "1 ride" or "3 rides".
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
