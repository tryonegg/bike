/**
 * Whole-database operations: deleting one or all saved rides, and the JSON
 * export/import that backs up (or moves between devices) every saved ride
 * plus every preference. See gpx.js for the separate single-ride GPX
 * import/export.
 */

import { ACTIVE_SESSION_KEY, PREF_STORE } from "./constants.js";
import { state, el } from "./state.js";
import { confirmWithModal, showMessage } from "./modal.js";
import { deleteSessionById, getAllSessions, clearAllSessions, withStore, addSession, setPref, loadPrefs, getAllRoutes, putRoute, isRoute } from "./db.js";
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
 * Exports every saved ride, planned route and preference (excluding the machine-local
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
 * The hidden file input's `change` handler for JSON backup import: validates
 * the file, confirms with the rider (it overwrites preferences), imports
 * every session with a fresh auto-assigned id, and reloads prefs from the
 * merged result.
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

		if (data.version !== 1) {
			await showMessage("Import Error", "Unsupported file version.");
			return;
		}

		if (!Array.isArray(data.sessions) || typeof data.preferences !== "object") {
			await showMessage("Import Error", "Invalid file format.");
			return;
		}

		const confirmed = await confirmWithModal({
			title: "Import Confirmation",
			message: `This will import ${data.sessions.length} session(s)${Array.isArray(data.routes) && data.routes.length ? ` and ${data.routes.length} route(s)` : ""} and overwrite your preferences. Continue?`,
			confirmText: "Import",
			cancelText: "Cancel",
		});

		el.importFileInput.value = "";

		if (!confirmed) return;

		for (const session of data.sessions) {
			// Drop the exported primary key so the autoIncrement store assigns a fresh
			// one; re-adding a colliding id throws ConstraintError mid-loop.
			const { id, ...rest } = session;
			await addSession(rest);
		}

		// Planned routes, in backups made since they were added.
		for (const route of Array.isArray(data.routes) ? data.routes : []) {
			if (!isRoute(route)) continue;
			const { id, ...rest } = route;
			await putRoute(rest);
		}

		for (const [key, value] of Object.entries(data.preferences)) {
			if (key === ACTIVE_SESSION_KEY) continue;
			await setPref(key, value);
		}

		await loadPrefs();
		applyRideLayout();
		await renderPastRides();
		await showMessage("Import Success", "Your data has been imported successfully.");
	} catch (error) {
		el.importFileInput.value = "";
		await showMessage("Import Error", `Failed to import data: ${error.message}`);
	}
}
