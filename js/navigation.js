/**
 * The app's central wiring hub and screen-navigation layer: every DOM event
 * listener (`wireEvents`), the settings-toggle sync, and the
 * `history.pushState`-backed screen router (`showScreen`/`navigateToScreen`/
 * `applyHistoryState`) that the browser's back/forward gestures and buttons
 * drive. Because it's the glue layer, this module imports from nearly every
 * other feature module — that fan-out is expected here, not a sign the
 * module needs splitting further.
 */

import { CALENDAR_COLOR_NOTES } from "./constants.js";
import { state, el } from "./state.js";
import { setPref } from "./db.js";
import { renderPastRides, shiftCalendarMonth } from "./history-view.js";
import { updateLiveStats, togglePauseSession, endSessionWithConfirm, saveActiveSessionCheckpoint, finalizeSession } from "./live-session.js";
import { applyMapVisualPrefs } from "./map-visuals.js";
import { refreshTopoLayers, rebuildMapStyles, recenterLiveMap, mapTypeNeedsStadiaKey, rebuildTerrain } from "./live-map.js";
import { renderPostSummary, openPostSession } from "./post-session.js";
import { renderElevationChart, clearChartHighlight } from "./chart.js";
import { startCountdownFlow, handleStartRideClick, cancelSetupAndReturnHome, abortRideSetup } from "./ride-setup.js";
import { exportAllData, importAllData, deleteAllRides, deleteCurrentRide } from "./data-io.js";
import { importGpxSession, exportCurrentGpx } from "./gpx.js";
import { confirmWithModal, closeModal } from "./modal.js";
import { requestWakeLock, releaseWakeLock, maybeShowInstallBanner } from "./pwa.js";

/**
 * Wires up every DOM event listener the app uses: every settings toggle
 * (each one saves its preference, re-syncs the toggle UI, and re-applies
 * whatever depends on it), the activity picker, import/export/delete
 * buttons, the ride controls (pause/stop/recenter), the install-prompt
 * banner, the modal's own buttons, and the app-level `resize`/
 * `visibilitychange`/`pagehide`/`popstate` handlers that keep a ride's wake
 * lock and checkpoint correct across backgrounding and browser navigation.
 * Called once from `init()`.
 */
export function wireEvents() {
	el.unitToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-unit]");
		if (!btn) return;
		state.prefs.unit = btn.dataset.unit;
		await setPref("unit", state.prefs.unit);
		syncToggles();
		await renderPastRides();
		updateLiveStats();
		applyMapVisualPrefs();
		refreshTopoLayers();
		if (state.currentPostSession) {
			renderPostSummary(state.currentPostSession);
			renderElevationChart(state.currentPostSession);
		}
	});

	el.themeToggle.addEventListener("click", (event) => handleThemeClick(event));
	el.debugThemeToggle.addEventListener("click", (event) => handleThemeClick(event));

	el.mapTypeSelect.addEventListener("change", () => handleMapTypeChange(el.mapTypeSelect));
	el.debugMapTypeSelect.addEventListener("change", () => handleMapTypeChange(el.debugMapTypeSelect));

	el.terrain3dToggle.addEventListener("click", (event) => handleTerrain3dClick(event));
	el.debugTerrain3dToggle.addEventListener("click", (event) => handleTerrain3dClick(event));

	// Takes effect from the next ride, which is when the past rides are indexed.
	el.compareToggle.addEventListener("click", (event) => handleCompareClick(event));
	el.debugCompareToggle.addEventListener("click", (event) => handleCompareClick(event));

	el.dataSaverToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-data-saver");
		if (!btn) return;
		state.prefs.dataSaver = btn.dataset.dataSaver === "on";
		await setPref("dataSaver", state.prefs.dataSaver);
		syncToggles();
	});

	el.statsSideToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-stats-side]");
		if (!btn) return;
		state.prefs.rideStatsSide = btn.dataset.statsSide;
		await setPref("rideStatsSide", state.prefs.rideStatsSide);
		syncToggles();
		applyRideLayout();
	});

	el.calendarColorToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-calendar-color]");
		if (!btn) return;
		state.prefs.calendarColor = btn.dataset.calendarColor;
		await setPref("calendarColor", state.prefs.calendarColor);
		syncToggles();
		await renderPastRides();
	});

	// Takes effect next time a ride's summary map is opened, not on the map
	// underneath settings, since there isn't one — settings only opens from home.
	el.debugAccuracyToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-debug-accuracy]");
		if (!btn) return;
		state.prefs.debugGpsAccuracy = btn.dataset.debugAccuracy === "on";
		await setPref("debugGpsAccuracy", state.prefs.debugGpsAccuracy);
		syncToggles();
	});

	el.debugClipWarmupToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-debug-clip-warmup]");
		if (!btn) return;
		state.prefs.debugClipGpsWarmup = btn.dataset.debugClipWarmup === "on";
		await setPref("debugClipGpsWarmup", state.prefs.debugClipGpsWarmup);
		syncToggles();
	});

	el.ridesViewToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-rides-view]");
		if (!btn) return;
		state.prefs.ridesView = btn.dataset.ridesView;
		await setPref("ridesView", state.prefs.ridesView);
		syncToggles();
		await renderPastRides();
	});

	el.calPrevBtn.addEventListener("click", () => shiftCalendarMonth(-1));
	el.calNextBtn.addEventListener("click", () => shiftCalendarMonth(1));

	el.startRideBtn.addEventListener("click", startCountdownFlow);
	el.setupBackBtn.addEventListener("click", cancelSetupAndReturnHome);

	document.querySelectorAll(".activity-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const activity = event.target.dataset.activity;
			state.selectedActivityType = activity;
			document.querySelectorAll(".activity-btn").forEach((b) => b.classList.remove("active"));
			event.target.classList.add("active");
			// Auto-enable screen on for bike activity
			if (activity === "bike") {
				el.keepScreenOnToggle.checked = true;
				state.selectedKeepScreenOn = true;
			} else {
				el.keepScreenOnToggle.checked = false;
				state.selectedKeepScreenOn = false;
			}
		});
	});

	el.keepScreenOnToggle.addEventListener("change", (event) => {
		state.selectedKeepScreenOn = event.target.checked;
	});

	el.startActivityBtn.addEventListener("click", handleStartRideClick);

	el.exportDataBtn.addEventListener("click", exportAllData);
	el.importDataBtn.addEventListener("click", () => el.importFileInput.click());
	el.importFileInput.addEventListener("change", importAllData);
	el.importGpxBtn.addEventListener("click", () => el.importGpxFileInput.click());
	el.importGpxFileInput.addEventListener("change", importGpxSession);
	el.deleteAllRidesBtn.addEventListener("click", deleteAllRides);

	el.openSettingsBtn.addEventListener("click", () => {
		fillSettingsForm();
		navigateToScreen("settings");
	});

	// The debug FAB floats above every screen, so guard against pushing a
	// duplicate "debug" history entry if it's tapped while already there.
	el.debugMenuBtn.addEventListener("click", () => {
		if (state.currentScreen === "debug") return;
		navigateToScreen("debug");
	});
	el.debugBackBtn.addEventListener("click", () => history.back());

	el.guideContrastToggle.addEventListener("click", (event) => handleGuideContrastClick(event));
	el.debugGuideContrastToggle.addEventListener("click", (event) => handleGuideContrastClick(event));

	el.markerSizeToggle.addEventListener("click", (event) => handleMarkerSizeClick(event));
	el.debugMarkerSizeToggle.addEventListener("click", (event) => handleMarkerSizeClick(event));

	el.statsActivitySelect.addEventListener("change", async () => {
		state.prefs.statsActivity = el.statsActivitySelect.value;
		await setPref("statsActivity", state.prefs.statsActivity);
		await renderPastRides();
	});

	// Back leaves an unsaved, pasted API key behind. Everything else on this
	// screen saves the moment it's changed.
	el.settingsBackBtn.addEventListener("click", () => history.back());

	el.saveStadiaKeyBtn.addEventListener("click", async () => {
		state.prefs.stadiaKey = el.stadiaKeyInput.value.trim();
		el.stadiaKeyInput.value = state.prefs.stadiaKey;
		await setPref("stadiaKey", state.prefs.stadiaKey);
		syncToggles();
		rebuildMapStyles();
		flashButtonLabel(el.saveStadiaKeyBtn, "Saved");
	});

	el.pauseBtn.addEventListener("click", togglePauseSession);
	el.stopBtn.addEventListener("click", endSessionWithConfirm);
	el.recenterBtn.addEventListener("click", recenterLiveMap);

	el.exportGpxBtn.addEventListener("click", exportCurrentGpx);
	el.deleteRideBtn.addEventListener("click", deleteCurrentRide);
	el.backHomeBtn.addEventListener("click", leavePostSession);
	el.postBackBtn.addEventListener("click", leavePostSession);

	el.modalCancelBtn.addEventListener("click", () => closeModal("cancel"));
	el.modalConfirmBtn.addEventListener("click", () => closeModal("confirm"));

	window.addEventListener("beforeinstallprompt", (event) => {
		event.preventDefault();
		state.deferredInstallPrompt = event;
		maybeShowInstallBanner();
	});

	window.addEventListener("appinstalled", async () => {
		state.deferredInstallPrompt = null;
		el.installBanner.classList.add("hidden");
		state.prefs.installDismissed = true;
		await setPref("installDismissed", true);
	});

	el.installBtn.addEventListener("click", async () => {
		if (!state.deferredInstallPrompt) return;
		state.deferredInstallPrompt.prompt();
		await state.deferredInstallPrompt.userChoice;
		state.deferredInstallPrompt = null;
		el.installBanner.classList.add("hidden");
	});

	el.dismissInstallBtn.addEventListener("click", async () => {
		state.prefs.installDismissed = true;
		await setPref("installDismissed", true);
		el.installBanner.classList.add("hidden");
	});

	// Both maps watch their own containers; only the chart needs redrawing.
	window.addEventListener("resize", () => {
		if (state.currentPostSession) renderElevationChart(state.currentPostSession);
	});

	document.addEventListener("visibilitychange", async () => {
		const session = state.currentSession;
		if (!session) return;
		if (document.hidden) {
			// Backgrounding is when a mobile browser is most likely to evict the tab,
			// so flush the ride before giving up the wake lock.
			await saveActiveSessionCheckpoint();
			await releaseWakeLock();
		} else if (!session.paused) {
			await requestWakeLock();
		}
	});

	window.addEventListener("pagehide", () => {
		if (state.currentSession) saveActiveSessionCheckpoint();
	});

	// The nav guard: leaving the active screen mid-ride via back/forward would
	// otherwise silently abandon (and lose) the ride, so this intercepts that
	// navigation, confirms with the rider, and either restores the "active"
	// history entry (Stay) or finalizes the ride before letting the
	// navigation through (End Ride).
	window.addEventListener("popstate", async (event) => {
		if (state.handlingPopstate) return;
		const targetState = event.state || { screen: "home" };

		if (state.currentSession && state.currentScreen === "active" && targetState.screen !== "active") {
			if (state.navGuardActive) return;
			state.navGuardActive = true;
			const shouldLeave = await confirmWithModal({
				title: "End Active Ride?",
				message: "Leaving this screen will end and save your ride.",
				confirmText: "End Ride",
				cancelText: "Stay",
				timeoutMs: 5000,
				timeoutLabel: "Navigation canceled automatically",
			});

			if (!shouldLeave) {
				history.pushState({ screen: "active" }, "");
				showScreen("active");
				state.navGuardActive = false;
				return;
			}

			const saved = await finalizeSession();
			state.navGuardActive = false;
			await applyHistoryState(targetState, "replace", saved);
			return;
		}

		await applyHistoryState(targetState, "none");
	});
}

// The five handlers below back both the settings screen's own toggles and
// their duplicates on the debug screen (see index.html), so the two copies
// share one place that actually changes state instead of drifting apart.

/** Shared handler for both theme toggles (settings screen and debug screen). */
async function handleThemeClick(event) {
	const btn = event.target.closest("button[data-theme]");
	if (!btn) return;
	state.prefs.theme = btn.dataset.theme;
	await setPref("theme", state.prefs.theme);
	applyTheme();
	syncToggles();
	rebuildMapStyles();
	// The chart reads its colours from the theme when it draws.
	if (state.currentPostSession) renderElevationChart(state.currentPostSession);
}

/** Shared handler for both map-style selects (settings screen and debug screen). */
async function handleMapTypeChange(select) {
	state.prefs.mapType = select.value;
	await setPref("mapType", state.prefs.mapType);
	syncToggles();
	rebuildMapStyles();
}

/** Shared handler for both 3D-terrain toggles (settings screen and debug screen). */
async function handleTerrain3dClick(event) {
	const btn = event.target.closest("button[data-terrain3d]");
	if (!btn) return;
	state.prefs.terrain3d = btn.dataset.terrain3d === "on";
	await setPref("terrain3d", state.prefs.terrain3d);
	syncToggles();
	rebuildTerrain();
}

/** Shared handler for both "compare with past rides" toggles (settings screen and debug screen). */
async function handleCompareClick(event) {
	const btn = event.target.closest("button[data-compare]");
	if (!btn) return;
	state.prefs.comparePastRides = btn.dataset.compare === "on";
	await setPref("comparePastRides", state.prefs.comparePastRides);
	syncToggles();
}

/** Shared handler for both guide-line-contrast toggles (settings screen and debug screen). */
async function handleGuideContrastClick(event) {
	const btn = event.target.closest("button[data-guide-contrast]");
	if (!btn) return;
	state.prefs.guideContrast = btn.dataset.guideContrast;
	await setPref("guideContrast", state.prefs.guideContrast);
	syncToggles();
	applyMapVisualPrefs();
}

/** Shared handler for both distance-marker-size toggles (settings screen and debug screen). */
async function handleMarkerSizeClick(event) {
	const btn = event.target.closest("button[data-marker-size]");
	if (!btn) return;
	state.prefs.markerSize = btn.dataset.markerSize;
	await setPref("markerSize", state.prefs.markerSize);
	syncToggles();
	applyMapVisualPrefs();
}

/**
 * Re-applies every settings-toggle button's `active` class (and the
 * calendar-color note text) from the current `state.prefs`. Called after
 * every preference change and whenever the settings screen is (re-)entered.
 */
export function syncToggles() {
	const unitButtons = el.unitToggle.querySelectorAll("button");
	unitButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.unit === state.prefs.unit));

	const themeButtons = el.themeToggle.querySelectorAll("button");
	themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === state.prefs.theme));
	const debugThemeButtons = el.debugThemeToggle.querySelectorAll("button");
	debugThemeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === state.prefs.theme));

	// Styles with no free rendition (Classic, Satellite, Toner, Terrain) stay
	// selectable — a saved choice shouldn't vanish — but are greyed out until a
	// Stadia key makes them show anything but plain Road.
	const noStadiaKey = !state.prefs.stadiaKey;
	for (const select of [el.mapTypeSelect, el.debugMapTypeSelect]) {
		select.value = state.prefs.mapType;
		for (const option of select.options) {
			option.disabled = noStadiaKey && mapTypeNeedsStadiaKey(option.value);
		}
	}

	const terrain3dButtons = el.terrain3dToggle.querySelectorAll("button");
	terrain3dButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.terrain3d === "on") === state.prefs.terrain3d));
	const debugTerrain3dButtons = el.debugTerrain3dToggle.querySelectorAll("button");
	debugTerrain3dButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.terrain3d === "on") === state.prefs.terrain3d));

	const compareButtons = el.compareToggle.querySelectorAll("button");
	compareButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.compare === "on") === state.prefs.comparePastRides));
	const debugCompareButtons = el.debugCompareToggle.querySelectorAll("button");
	debugCompareButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.compare === "on") === state.prefs.comparePastRides));

	const dataSaverButtons = el.dataSaverToggle.querySelectorAll("button");
	dataSaverButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.dataSaver === "on") === state.prefs.dataSaver));

	const sideButtons = el.statsSideToggle.querySelectorAll("button");
	sideButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.statsSide === state.prefs.rideStatsSide));

	const colorButtons = el.calendarColorToggle.querySelectorAll("button");
	colorButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.calendarColor === state.prefs.calendarColor));
	el.calendarColorNote.textContent = CALENDAR_COLOR_NOTES[state.prefs.calendarColor];

	const debugAccuracyButtons = el.debugAccuracyToggle.querySelectorAll("button");
	debugAccuracyButtons.forEach((btn) =>
		btn.classList.toggle("active", (btn.dataset.debugAccuracy === "on") === state.prefs.debugGpsAccuracy),
	);

	const debugClipWarmupButtons = el.debugClipWarmupToggle.querySelectorAll("button");
	debugClipWarmupButtons.forEach((btn) =>
		btn.classList.toggle("active", (btn.dataset.debugClipWarmup === "on") === state.prefs.debugClipGpsWarmup),
	);

	const viewButtons = el.ridesViewToggle.querySelectorAll("button");
	viewButtons.forEach((btn) => {
		const on = btn.dataset.ridesView === state.prefs.ridesView;
		btn.classList.toggle("active", on);
		btn.setAttribute("aria-pressed", String(on));
	});

	const guideContrastButtons = el.guideContrastToggle.querySelectorAll("button");
	guideContrastButtons.forEach((btn) =>
		btn.classList.toggle("active", btn.dataset.guideContrast === state.prefs.guideContrast),
	);
	const debugGuideContrastButtons = el.debugGuideContrastToggle.querySelectorAll("button");
	debugGuideContrastButtons.forEach((btn) =>
		btn.classList.toggle("active", btn.dataset.guideContrast === state.prefs.guideContrast),
	);

	const markerSizeButtons = el.markerSizeToggle.querySelectorAll("button");
	markerSizeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.markerSize === state.prefs.markerSize));
	const debugMarkerSizeButtons = el.debugMarkerSizeToggle.querySelectorAll("button");
	debugMarkerSizeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.markerSize === state.prefs.markerSize));
}

// Briefly swaps a button's label to confirm an action, then restores it.
/**
 * Briefly swaps a button's label (e.g. to "Saved") to confirm an action,
 * then restores the original text. Re-entrant calls while a flash is
 * already in progress are ignored, so a rapid double-click can't clobber
 * the button's real label with "Saved" permanently.
 *
 * @param {HTMLButtonElement} btn
 * @param {string} text - Temporary label.
 * @param {number} [duration] - Milliseconds before reverting.
 */
export function flashButtonLabel(btn, text, duration = 1200) {
	if (btn.dataset.flashing) return;
	const original = btn.textContent;
	btn.dataset.flashing = "true";
	btn.textContent = text;
	setTimeout(() => {
		btn.textContent = original;
		delete btn.dataset.flashing;
	}, duration);
}

// Only the landscape layout reads this; in portrait the stats sit above the map.
/**
 * Applies the "stats side" preference to the active screen's layout. Only
 * the landscape CSS layout reads this class — in portrait, the stats sit
 * above the map regardless.
 */
export function applyRideLayout() {
	el.screens.active.classList.toggle("stats-right", state.prefs.rideStatsSide === "right");
}

/** Applies the light/dark theme preference to the document root and the browser's theme-color meta tag. */
export function applyTheme() {
	const dark = state.prefs.theme === "dark";
	document.documentElement.classList.toggle("dark", dark);
	// The browser chrome matches the screen background.
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111413" : "#fcfcfa");
}

/** Populates the settings screen's form fields from `state.prefs`. */
export function fillSettingsForm() {
	el.stadiaKeyInput.value = state.prefs.stadiaKey;
	el.statsActivitySelect.value = state.prefs.statsActivity;
}

/**
 * Leaves the post-ride summary screen: clears the chart highlight and the
 * current post session, and returns home with a refreshed rides list.
 * @returns {Promise<void>}
 */
export async function leavePostSession() {
	clearChartHighlight();
	state.currentPostSession = null;
	navigateToScreen("home");
	await renderPastRides();
}

/**
 * Shows one screen and hides the rest, and records which one is current.
 * Does not touch browser history — see `navigateToScreen` for that.
 * @param {"home"|"active"|"post"|"settings"|"debug"} name
 */
export function showScreen(name) {
	Object.entries(el.screens).forEach(([key, screen]) => {
		screen.classList.toggle("hidden", key !== name);
		screen.classList.toggle("active", key === name);
	});
	state.currentScreen = name;
}

/**
 * Shows a screen and updates browser history to match, so back/forward and
 * the popstate handler in `wireEvents` can navigate between the app's screens.
 *
 * @param {"home"|"active"|"post"|"settings"|"debug"} name
 * @param {"push"|"replace"|string} [mode] - `"push"` adds a new history
 *   entry (the normal case, e.g. following a link/button); `"replace"` swaps
 *   the current entry (used when restoring state without wanting an extra
 *   back-stop, e.g. after a browser-driven navigation already changed the
 *   entry); anything else updates the screen without touching history at all.
 */
export function navigateToScreen(name, mode = "push") {
	showScreen(name);
	const navState = { screen: name };
	if (mode === "replace") {
		history.replaceState(navState, "");
	} else if (mode === "push") {
		history.pushState(navState, "");
	}
}

/**
 * Resolves a `history.state`-shaped target (from `popstate`, or from a
 * direct call after finalizing a ride) into the right screen, doing whatever
 * setup that screen needs (loading a post-ride session, filling the
 * settings form, re-applying map visual prefs) along the way. Wrapped in
 * `state.handlingPopstate` so the navigation this performs doesn't
 * re-trigger the popstate handler recursively.
 *
 * Also aborts an in-progress pre-ride setup/countdown when navigating away
 * from it to anything other than "active" — that flow's own screen never
 * gets its own history entry, so this is the one place that can catch a
 * rider backing out of it via browser navigation.
 *
 * @param {{screen: string, sessionId?: number}} targetState
 * @param {"push"|"replace"|string} [mode] - Passed through to whichever
 *   navigation function ultimately runs.
 * @param {Object|null} [savedSession] - When resolving to the post-ride
 *   screen right after finalizing a ride, pass the session directly to skip
 *   an IndexedDB round-trip.
 * @returns {Promise<void>}
 */
export async function applyHistoryState(targetState, mode = "none", savedSession = null) {
	state.handlingPopstate = true;
	try {
		// Backing out of the pre-ride setup/countdown, which never got as far as a
		// recorded session. The active screen's own history entry pops straight to
		// whatever came before it (usually home), never to a "countdown" entry of
		// its own, so this has to be caught here rather than in the "active" case
		// below.
		if (state.rideFlowPhase && state.rideFlowPhase !== "active" && targetState.screen !== "active") {
			abortRideSetup();
		}

		if (targetState.screen === "post") {
			if (savedSession) {
				await openPostSession(savedSession.id, savedSession, mode);
			} else if (targetState.sessionId != null) {
				await openPostSession(targetState.sessionId, null, mode);
			} else {
				navigateToScreen("home", mode);
			}
			return;
		}

		if (targetState.screen === "settings") {
			fillSettingsForm();
			navigateToScreen("settings", mode);
			return;
		}

		if (targetState.screen === "debug") {
			navigateToScreen("debug", mode);
			return;
		}

		if (targetState.screen === "active") {
			applyMapVisualPrefs();
			navigateToScreen(state.currentSession ? "active" : "home", mode);
			return;
		}

		applyMapVisualPrefs();
		navigateToScreen("home", mode);
	} finally {
		state.handlingPopstate = false;
	}
}
