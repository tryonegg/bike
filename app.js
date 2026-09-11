import { bestPaceAt, buildPaceIndex, pathsAhead, trailingPace } from "./pace-index.js";

const DB_NAME = "bike-tracker-db";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const PREF_STORE = "preferences";

// Shared IndexedDB connection, opened once by openDB(). Declared here because
// init() reaches openDB() well before the function's own definition is evaluated.
let dbPromise = null;

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;
const MPS_TO_MPH = 2.236936;
const MPS_TO_KPH = 3.6;

// watchPosition normally delivers roughly one fix per second, so the dropout
// threshold must sit well clear of that interval.
const GPS_OUTAGE_THRESHOLD_MS = 3500;
const DEAD_RECKONING_STEP_MS = 250;
const MAX_DEAD_RECKONING_DRIFT_METERS = 50;

// An in-progress ride lives in memory, so it is checkpointed to IndexedDB and
// recovered on the next launch if the tab is evicted or the app is reloaded.
const ACTIVE_SESSION_KEY = "activeSession";
const CHECKPOINT_INTERVAL_MS = 10000;

// Number of discrete colors in the speed ramp used by the route line and chart.
const SPEED_BANDS = 16;

// The pre-ride countdown, which also bounds how long the initial GPS fix gets.
const COUNTDOWN_SECONDS = 5;

// Live map camera. Fixes land about once a second, so each follow move is eased
// over a little less than that to glide between fixes rather than jump. The
// zoom is only the starting default; the rider's own pick is saved as a pref.
const LIVE_MAP_ZOOM = 16;
const LIVE_CAMERA_EASE_MS = 900;
// A three-quarter view that tilts the road ahead into sight. It stays fixed for
// the ride: the tilt gestures are off and the follow camera never changes it.
const LIVE_MAP_PITCH = 55;
const LIVE_ROUTE_SOURCE = "live-route";
const LIVE_GUIDE_SOURCE = "live-guide";
// The distance-to-start chip sits this far from the rider along the guide line,
// measured as if the map were flat; tilt shortens it on screen toward the
// horizon. It hides when the whole line is shorter than the minimum.
const GUIDE_LABEL_OFFSET_PX = 90;
const GUIDE_LABEL_MIN_LINE_PX = 70;
// Width of the whole world in pixels at zoom 0, which MapLibre doubles per zoom.
const WORLD_SIZE_AT_ZOOM_0 = 512;

// Topo relief and contours are drawn from AWS's open terrain tiles. Zoom 13 is
// fine enough for riding-scale contours and keeps the download per view small.
const DEM_TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
const DEM_MAX_ZOOM = 13;
const DEM_ATTRIBUTION = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain Tiles</a>';
const FEET_PER_METER = 3.28084;
const TOPO_LAYER_IDS = ["topo-hillshade", "topo-contour-lines", "topo-contour-labels"];
const TOPO_SOURCE_IDS = ["topo-dem", "topo-contours"];

// Best past pace: the band colours the known paths within this distance ahead,
// fading out, and a stretch at least this steep gets a climb tag in the readout.
// Each path is a line layer of its own, since a line gradient is set per layer;
// the longest paths get the slots.
const BEST_PACE_LAYER = "live-best-pace";
const BEST_PACE_SLOTS = 12;
const BEST_PACE_BAND_M = 500;
const BEST_PACE_BAND_OPACITY = 0.6;
const BEST_PACE_CLIMB_GRADE = 0.03;
const CLEAR_LINE_GRADIENT = ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0, 0, 0, 0)", 1, "rgba(0, 0, 0, 0)"];

// noun names one outing in a title ("Morning walk"); plural heads the home count.
const ACTIVITIES = {
	bike: { label: "Bike", icon: "🚴", noun: "ride", plural: "Rides" },
	walk: { label: "Walk", icon: "🚶", noun: "walk", plural: "Walks" },
	hike: { label: "Hike", icon: "🥾", noun: "hike", plural: "Hikes" },
	kayak: { label: "Kayak", icon: "🛶", noun: "paddle", plural: "Paddles" },
};

// Slow to fast, evenly spaced. Shared by the route, the elevation line, the
// segment bars and the calendar so one colour means one pace everywhere.
const PACE_STOPS = ["#e05a3a", "#e07a3a", "#e0a63a", "#c9d63a", "#8fc93a", "#2f9c4f"];

// The settings note under the calendar colour choice, one per option.
const CALENDAR_COLOR_NOTES = {
	distance: "Green marks your longest days, red your shortest.",
	time: "Green marks the days with the most moving time, red the least.",
	pace: "Green marks your fastest days for that activity, red your slowest.",
};

const state = {
	prefs: {
		unit: "imperial",
		theme: "light",
		stadiaKey: "",
		mapType: "road",
		liveMapZoom: LIVE_MAP_ZOOM,
		comparePastRides: true,
		// Which side of the map the ride stats sit on in landscape: "left" or "right".
		rideStatsSide: "left",
		guideContrast: "high",
		markerSize: "medium",
		ridesView: "list",
		// Which activity the home screen's month and week totals count, or "all".
		statsActivity: "all",
		// What the calendar's top rule colours by: "distance", "time" or "pace".
		calendarColor: "distance",
		installDismissed: false,
	},
	// Which month the calendar view is paged to, as the 1st at local midnight.
	// Null until the first calendar render picks a starting month from the rides.
	calendarMonth: null,
	deferredInstallPrompt: null,
	// Both maps are MapLibre. The live map's sources are rebuilt from these
	// whenever the style is swapped, so they are the record of what it shows.
	liveMap: null,
	liveRouteCoords: [],
	liveGuideCoords: [],
	markerLayer: null,
	guideLabelMarker: null,
	riderMarker: null,
	// Built from the saved rides when a ride starts; null until it is ready.
	paceIndex: null,
	bestPaceChip: null,
	// What the band shows, kept so a style swap can redraw it.
	bestPaceBand: null,
	postMap: null,
	postMarkerLayer: null,
	// Per map: whether it is on Stadia and whether its current style has loaded.
	mapStatus: new WeakMap(),
	// Created once; it registers MapLibre protocols that every topo style reuses.
	demSource: null,
	elevationChart: null,
	currentSession: null,
	currentPostSession: null,
	wakeLockSentinel: null,
	currentScreen: "home",
	countdownRunToken: 0,
	selectedActivityType: "bike",
	selectedKeepScreenOn: false,
	modalResolver: null,
	modalTimer: null,
	modalCountdownTimer: null,
	handlingPopstate: false,
	navGuardActive: false,
	swRegistration: null,
	swUpdatePromptOpen: false,
	// Sensor fusion for GPS outage bridging
	motionSensorActive: false,
	lastGPSTimestamp: 0,
	gpsOutageDetected: false,
	gpsOutageTimeout: null,
	travelHeadingDegrees: null,
	compassHeadingDegrees: null,
	estimatedPointsDuringGap: [],
	velocityEstimate: 0,
	// Elevation chart interaction
	chartPointsCache: [],
	highlightedPointIndex: -1,
	chartHighlightMarker: null,
	isChartDragging: false,
	lastCheckpointAt: 0,
};

const el = {
	installBanner: document.getElementById("installBanner"),
	installMessage: document.getElementById("installMessage"),
	installBtn: document.getElementById("installBtn"),
	dismissInstallBtn: document.getElementById("dismissInstallBtn"),
	screens: {
		home: document.getElementById("homeScreen"),
		countdown: document.getElementById("countdownScreen"),
		activitySelect: document.getElementById("activitySelectScreen"),
		active: document.getElementById("activeScreen"),
		post: document.getElementById("postScreen"),
		settings: document.getElementById("settingsScreen"),
	},
	unitToggle: document.getElementById("unitToggle"),
	themeToggle: document.getElementById("themeToggle"),
	mapTypeToggle: document.getElementById("mapTypeToggle"),
	compareToggle: document.getElementById("compareToggle"),
	statsSideToggle: document.getElementById("statsSideToggle"),
	calendarColorToggle: document.getElementById("calendarColorToggle"),
	calendarColorNote: document.getElementById("calendarColorNote"),
	monthDistance: document.getElementById("monthDistance"),
	monthDistanceUnit: document.getElementById("monthDistanceUnit"),
	monthCount: document.getElementById("monthCount"),
	monthCountLabel: document.getElementById("monthCountLabel"),
	monthAvgSpeed: document.getElementById("monthAvgSpeed"),
	monthSpeedUnit: document.getElementById("monthSpeedUnit"),
	weekTime: document.getElementById("weekTime"),
	weekDistance: document.getElementById("weekDistance"),
	weekDistanceUnit: document.getElementById("weekDistanceUnit"),
	pastRidesLabel: document.getElementById("pastRidesLabel"),
	sessionsList: document.getElementById("sessionsList"),
	sessionsEmpty: document.getElementById("sessionsEmpty"),
	ridesViewToggle: document.getElementById("ridesViewToggle"),
	ridesCalendar: document.getElementById("ridesCalendar"),
	calPrevBtn: document.getElementById("calPrevBtn"),
	calNextBtn: document.getElementById("calNextBtn"),
	calMonthLabel: document.getElementById("calMonthLabel"),
	calWeekdayRow: document.getElementById("calWeekdayRow"),
	calBody: document.getElementById("calBody"),
	startRideBtn: document.getElementById("startRideBtn"),
	openSettingsBtn: document.getElementById("openSettingsBtn"),
	settingsBackBtn: document.getElementById("settingsBackBtn"),
	saveSettingsBtn: document.getElementById("saveSettingsBtn"),
	stadiaKeyInput: document.getElementById("stadiaKeyInput"),
	guideContrastSelect: document.getElementById("guideContrastSelect"),
	markerSizeSelect: document.getElementById("markerSizeSelect"),
	statsActivitySelect: document.getElementById("statsActivitySelect"),
	exportDataBtn: document.getElementById("exportDataBtn"),
	importDataBtn: document.getElementById("importDataBtn"),
	importFileInput: document.getElementById("importFileInput"),
	deleteAllRidesBtn: document.getElementById("deleteAllRidesBtn"),
	keepScreenOnToggle: document.getElementById("keepScreenOnToggle"),
	cancelActivityBtn: document.getElementById("cancelActivityBtn"),
	startActivityBtn: document.getElementById("startActivityBtn"),
	countdownNumber: document.getElementById("countdownNumber"),
	countdownStatus: document.getElementById("countdownStatus"),
	retryCountdownBtn: document.getElementById("retryCountdownBtn"),
	cancelCountdownBtn: document.getElementById("cancelCountdownBtn"),
	rideStrip: document.getElementById("rideStrip"),
	speedLabel: document.getElementById("speedLabel"),
	currentSpeed: document.getElementById("currentSpeed"),
	currentSpeedUnit: document.getElementById("currentSpeedUnit"),
	distanceValue: document.getElementById("distanceValue"),
	distanceUnit: document.getElementById("distanceUnit"),
	avgSpeed: document.getElementById("avgSpeed"),
	elapsedTime: document.getElementById("elapsedTime"),
	pauseBtn: document.getElementById("pauseBtn"),
	stopBtn: document.getElementById("stopBtn"),
	recenterBtn: document.getElementById("recenterBtn"),
	postBackBtn: document.getElementById("postBackBtn"),
	postDate: document.getElementById("postDate"),
	postTitle: document.getElementById("postTitle"),
	postDistance: document.getElementById("postDistance"),
	postDistanceUnit: document.getElementById("postDistanceUnit"),
	postTime: document.getElementById("postTime"),
	postMaxSpeed: document.getElementById("postMaxSpeed"),
	postSpeedUnit: document.getElementById("postSpeedUnit"),
	postAvgSpeed: document.getElementById("postAvgSpeed"),
	postGain: document.getElementById("postGain"),
	postGainUnit: document.getElementById("postGainUnit"),
	postDrop: document.getElementById("postDrop"),
	postDropUnit: document.getElementById("postDropUnit"),
	elevationChart: document.getElementById("elevationChart"),
	chartStartLabel: document.getElementById("chartStartLabel"),
	chartEndLabel: document.getElementById("chartEndLabel"),
	segmentsBody: document.getElementById("segmentsBody"),
	segmentsSpeedHeader: document.getElementById("segmentsSpeedHeader"),
	exportGpxBtn: document.getElementById("exportGpxBtn"),
	deleteRideBtn: document.getElementById("deleteRideBtn"),
	backHomeBtn: document.getElementById("backHomeBtn"),
	modalBackdrop: document.getElementById("modalBackdrop"),
	modalTitle: document.getElementById("modalTitle"),
	modalMessage: document.getElementById("modalMessage"),
	modalList: document.getElementById("modalList"),
	modalCountdown: document.getElementById("modalCountdown"),
	modalCancelBtn: document.getElementById("modalCancelBtn"),
	modalConfirmBtn: document.getElementById("modalConfirmBtn"),
};

init().catch((error) => {
	console.error(error);
	showMessage("Initialization Failed", "App initialization failed. Please refresh.");
});

async function init() {
	await loadPrefs();
	applyTheme();
	applyRideLayout();
	syncToggles();
	wireEvents();
	history.replaceState({ screen: "home" }, "");
	await renderPastRides();
	await maybeRecoverSession();
	registerServiceWorker();
	maybeShowInstallBanner();
}

function wireEvents() {
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

	el.themeToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-theme]");
		if (!btn) return;
		state.prefs.theme = btn.dataset.theme;
		await setPref("theme", state.prefs.theme);
		applyTheme();
		syncToggles();
		rebuildMapStyles();
		// The chart reads its colours from the theme when it draws.
		if (state.currentPostSession) renderElevationChart(state.currentPostSession);
	});

	el.mapTypeToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-map-type]");
		if (!btn) return;
		state.prefs.mapType = btn.dataset.mapType;
		await setPref("mapType", state.prefs.mapType);
		syncToggles();
		rebuildMapStyles();
	});

	// Takes effect from the next ride, which is when the past rides are indexed.
	el.compareToggle.addEventListener("click", async (event) => {
		const btn = event.target.closest("button[data-compare]");
		if (!btn) return;
		state.prefs.comparePastRides = btn.dataset.compare === "on";
		await setPref("comparePastRides", state.prefs.comparePastRides);
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
	// Retry re-runs the countdown with the activity already chosen. Routing it back
	// through startCountdownFlow reset the selection to Bike on every failed lock.
	el.retryCountdownBtn.addEventListener("click", () => startActivityCountdown({ retry: true }));
	el.cancelCountdownBtn.addEventListener("click", cancelCountdownAndReturnHome);

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

	el.cancelActivityBtn.addEventListener("click", cancelActivityAndReturnHome);
	el.startActivityBtn.addEventListener("click", startActivityCountdown);

	el.exportDataBtn.addEventListener("click", exportAllData);
	el.importDataBtn.addEventListener("click", () => el.importFileInput.click());
	el.importFileInput.addEventListener("change", importAllData);
	el.deleteAllRidesBtn.addEventListener("click", deleteAllRides);

	el.openSettingsBtn.addEventListener("click", () => {
		fillSettingsForm();
		navigateToScreen("settings");
	});

	el.guideContrastSelect.addEventListener("change", previewSettingsMapVisuals);
	el.markerSizeSelect.addEventListener("change", previewSettingsMapVisuals);

	// Back leaves the unsaved fields behind. The history entry it returns to puts
	// the map visuals back to the saved values, undoing any preview.
	el.settingsBackBtn.addEventListener("click", () => history.back());

	el.saveSettingsBtn.addEventListener("click", async () => {
		state.prefs.stadiaKey = el.stadiaKeyInput.value.trim();
		state.prefs.guideContrast = el.guideContrastSelect.value;
		state.prefs.markerSize = el.markerSizeSelect.value;
		state.prefs.statsActivity = el.statsActivitySelect.value;
		await setPref("stadiaKey", state.prefs.stadiaKey);
		await setPref("guideContrast", state.prefs.guideContrast);
		await setPref("markerSize", state.prefs.markerSize);
		await setPref("statsActivity", state.prefs.statsActivity);
		navigateToScreen("home");
		rebuildMapStyles();
		applyMapVisualPrefs();
		await renderPastRides();
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

function syncToggles() {
	const unitButtons = el.unitToggle.querySelectorAll("button");
	unitButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.unit === state.prefs.unit));

	const themeButtons = el.themeToggle.querySelectorAll("button");
	themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === state.prefs.theme));

	const mapTypeButtons = el.mapTypeToggle.querySelectorAll("button");
	mapTypeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mapType === state.prefs.mapType));

	const compareButtons = el.compareToggle.querySelectorAll("button");
	compareButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.compare === "on") === state.prefs.comparePastRides));

	const sideButtons = el.statsSideToggle.querySelectorAll("button");
	sideButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.statsSide === state.prefs.rideStatsSide));

	const colorButtons = el.calendarColorToggle.querySelectorAll("button");
	colorButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.calendarColor === state.prefs.calendarColor));
	el.calendarColorNote.textContent = CALENDAR_COLOR_NOTES[state.prefs.calendarColor];

	const viewButtons = el.ridesViewToggle.querySelectorAll("button");
	viewButtons.forEach((btn) => {
		const on = btn.dataset.ridesView === state.prefs.ridesView;
		btn.classList.toggle("active", on);
		btn.setAttribute("aria-pressed", String(on));
	});
}

// Only the landscape layout reads this; in portrait the stats sit above the map.
function applyRideLayout() {
	el.screens.active.classList.toggle("stats-right", state.prefs.rideStatsSide === "right");
}

function applyTheme() {
	const dark = state.prefs.theme === "dark";
	document.documentElement.classList.toggle("dark", dark);
	// The browser chrome matches the screen background.
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111413" : "#fcfcfa");
}

function fillSettingsForm() {
	el.stadiaKeyInput.value = state.prefs.stadiaKey;
	el.guideContrastSelect.value = state.prefs.guideContrast;
	el.markerSizeSelect.value = state.prefs.markerSize;
	el.statsActivitySelect.value = state.prefs.statsActivity;
}

async function leavePostSession() {
	clearChartHighlight();
	state.currentPostSession = null;
	navigateToScreen("home");
	await renderPastRides();
}

function showScreen(name) {
	Object.entries(el.screens).forEach(([key, screen]) => {
		screen.classList.toggle("hidden", key !== name);
		screen.classList.toggle("active", key === name);
	});
	state.currentScreen = name;
}

function navigateToScreen(name, mode = "push") {
	showScreen(name);
	const navState = { screen: name };
	if (mode === "replace") {
		history.replaceState(navState, "");
	} else if (mode === "push") {
		history.pushState(navState, "");
	}
}

async function applyHistoryState(targetState, mode = "none", savedSession = null) {
	state.handlingPopstate = true;
	try {
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

		if (targetState.screen === "countdown") {
			applyMapVisualPrefs();
			navigateToScreen("home", mode);
			return;
		}

		if (targetState.screen === "active") {
			applyMapVisualPrefs();
			if (state.currentSession) {
				navigateToScreen("active", mode);
			} else {
				navigateToScreen("home", mode);
			}
			return;
		}

		applyMapVisualPrefs();
		navigateToScreen("home", mode);
	} finally {
		state.handlingPopstate = false;
	}
}

async function renderPastRides() {
	const sessions = await getAllSessions();
	sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

	const showCalendar = state.prefs.ridesView === "calendar";

	renderHomeTotals(sessions);
	el.pastRidesLabel.textContent = "Past rides";

	if (!sessions.length) {
		el.sessionsList.innerHTML = "";
		el.sessionsList.classList.add("hidden");
		el.ridesCalendar.classList.add("hidden");
		el.sessionsEmpty.classList.remove("hidden");
		return;
	}

	el.sessionsEmpty.classList.add("hidden");
	el.sessionsList.classList.toggle("hidden", showCalendar);
	el.ridesCalendar.classList.toggle("hidden", !showCalendar);

	// Only the visible view is built; the other stays as it was until it is shown.
	if (showCalendar) {
		renderRidesCalendar(sessions);
	} else {
		renderRidesList(sessions);
	}
}

// Month-to-date and trailing-week figures for the header, over the activity
// chosen in settings. Average speed is distance over moving time, the same
// definition every other average in the app uses.
function renderHomeTotals(sessions) {
	const unit = state.prefs.unit;
	const activity = state.prefs.statsActivity;
	const counted =
		activity === "all" ? sessions : sessions.filter((session) => (session.activityType || "bike") === activity);

	const now = new Date();
	const monthStart = startOfMonth(now).getTime();
	// Today and the six days before it, from local midnight.
	const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();

	const month = { distance: 0, time: 0, count: 0 };
	const week = { distance: 0, time: 0 };

	for (const session of counted) {
		const time = new Date(session.date).getTime();
		if (!Number.isFinite(time)) continue;
		const distance = session.totalDistance || 0;
		const moving = session.movingTime || 0;

		if (time >= monthStart) {
			month.distance += distance;
			month.time += moving;
			month.count += 1;
		}
		if (time >= weekStart) {
			week.distance += distance;
			week.time += moving;
		}
	}

	const perUnit = getSegmentLengthMeters(unit);
	el.monthDistance.textContent = (month.distance / perUnit).toFixed(1);
	el.monthDistanceUnit.textContent = distanceUnitLabel(unit);
	el.monthCount.textContent = String(month.count);
	el.monthCountLabel.textContent = ACTIVITIES[activity]?.plural || "Rides";
	el.monthAvgSpeed.textContent = formatSpeed(month.time > 0 ? month.distance / (month.time / 1000) : 0, unit);
	el.monthSpeedUnit.textContent = speedUnitLabel(unit);

	el.weekTime.textContent = week.time > 0 ? formatDurationMinutes(week.time) : "0m";
	el.weekDistance.textContent = formatDistance(week.distance, unit);
	el.weekDistanceUnit.textContent = distanceUnitLabel(unit);
}

function renderRidesList(sessions) {
	el.sessionsList.innerHTML = "";

	// Sorted newest first, so the year changes at most once per group. The first
	// year rides in the section label; each older one gets a divider row.
	let currentYear;

	for (const [index, session] of sessions.entries()) {
		const date = new Date(session.date);
		const year = Number.isNaN(date.getTime()) ? null : date.getFullYear();
		const yearText = year == null ? "Undated" : String(year);

		if (index === 0) {
			el.pastRidesLabel.textContent = `Past rides · ${yearText}`;
		} else if (year !== currentYear) {
			const divider = document.createElement("li");
			divider.className = "sessions-year-label label";
			divider.textContent = yearText;
			el.sessionsList.appendChild(divider);
		}
		currentYear = year;

		const li = document.createElement("li");
		li.appendChild(buildSessionRow(session, date));
		el.sessionsList.appendChild(li);
	}
}

// Weeks run Sunday-first. The column labels themselves come from the locale.
const WEEK_START_DAY = 0;

function startOfMonth(date) {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

async function shiftCalendarMonth(delta) {
	const month = state.calendarMonth;
	if (!month) return;
	// renderRidesCalendar clamps, so an out-of-range step cannot get through even if
	// the buttons have not caught up with a change to the stored rides.
	state.calendarMonth = new Date(month.getFullYear(), month.getMonth() + delta, 1);
	await renderPastRides();
}

// Paging runs from the earliest recorded ride to the current month. The current
// month is always inside the range so today stays reachable, and a ride somehow
// dated ahead of the clock extends the top rather than being made unreachable.
function calendarMonthBounds(sessions) {
	const thisMonth = startOfMonth(new Date()).getTime();
	let earliest = thisMonth;
	let latest = thisMonth;

	for (const session of sessions) {
		const date = new Date(session.date);
		if (Number.isNaN(date.getTime())) continue;
		const time = startOfMonth(date).getTime();
		if (time < earliest) earliest = time;
		if (time > latest) latest = time;
	}

	return { min: earliest, max: latest };
}

// Open on the month of the most recent ride so a calendar is not blank after a
// break from riding. Falls back to the current month when there is nothing newer.
function defaultCalendarMonth(sessions) {
	let latest = null;

	for (const session of sessions) {
		const date = new Date(session.date);
		if (Number.isNaN(date.getTime())) continue;
		const month = startOfMonth(date);
		if (!latest || month.getTime() > latest.getTime()) latest = month;
	}

	return latest || startOfMonth(new Date());
}

function clampCalendarMonth(month, bounds) {
	const time = month.getTime();
	if (time < bounds.min) return new Date(bounds.min);
	if (time > bounds.max) return new Date(bounds.max);
	return month;
}

function dayKey(date) {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function renderRidesCalendar(sessions) {
	const bounds = calendarMonthBounds(sessions);
	if (!state.calendarMonth) state.calendarMonth = defaultCalendarMonth(sessions);
	// Re-clamp every render: a delete or an import can move the ends of the range.
	state.calendarMonth = clampCalendarMonth(state.calendarMonth, bounds);

	const month = state.calendarMonth;
	const year = month.getFullYear();
	const monthIndex = month.getMonth();

	el.calMonthLabel.textContent = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
	el.calPrevBtn.disabled = month.getTime() <= bounds.min;
	el.calNextBtn.disabled = month.getTime() >= bounds.max;

	renderCalendarWeekdays();

	// Not filtered to the displayed month: the grid spills into the neighbouring
	// months, and those days show their rides too.
	const byDay = new Map();
	for (const session of sessions) {
		const date = new Date(session.date);
		if (Number.isNaN(date.getTime())) continue;
		const key = dayKey(date);
		if (!byDay.has(key)) byDay.set(key, []);
		byDay.get(key).push(session);
	}

	const dayScale = calendarDayScale(byDay, sessions);

	const leadingDays = (new Date(year, monthIndex, 1).getDay() - WEEK_START_DAY + 7) % 7;
	const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
	const weeks = Math.ceil((leadingDays + daysInMonth) / 7);
	const todayKey = dayKey(new Date());

	el.calBody.innerHTML = "";

	for (let week = 0; week < weeks; week += 1) {
		const tr = document.createElement("tr");

		for (let column = 0; column < 7; column += 1) {
			// Day-of-month arithmetic rolls into the adjacent months on its own, so a
			// day number outside 1..daysInMonth resolves to the right neighbouring date.
			const cellDate = new Date(year, monthIndex, week * 7 + column - leadingDays + 1);
			const key = dayKey(cellDate);
			const rides = byDay.get(key) || [];

			const td = document.createElement("td");
			td.className = "calendar-day";
			if (cellDate.getMonth() !== monthIndex) td.classList.add("is-outside");
			if (rides.length) td.classList.add("has-ride");
			if (key === todayKey) td.classList.add("is-today");

			if (rides.length) {
				// Oldest first within a day, so a picker lists them in the order they happened.
				td.appendChild(buildCalendarCell([...rides].reverse(), cellDate, dayScale));
			} else {
				const number = document.createElement("span");
				number.className = "calendar-day-number";
				number.textContent = String(cellDate.getDate());
				td.appendChild(number);
			}

			tr.appendChild(td);
		}

		el.calBody.appendChild(tr);
	}
}

function renderCalendarWeekdays() {
	el.calWeekdayRow.innerHTML = "";

	// 2024-09-01 was a Sunday, so it anchors the week without hard-coding names.
	for (let index = 0; index < 7; index += 1) {
		const sample = new Date(2024, 8, 1 + ((WEEK_START_DAY + index) % 7));
		const th = document.createElement("th");
		th.scope = "col";
		th.textContent = sample.toLocaleDateString(undefined, { weekday: "narrow" });
		th.setAttribute("aria-label", sample.toLocaleDateString(undefined, { weekday: "long" }));
		el.calWeekdayRow.appendChild(th);
	}
}

// One button per day however many rides it holds: the day's moving time and
// distance added up, the top rule coloured by dayScale. A single ride opens
// straight away; several open a picker.
function buildCalendarCell(rides, cellDate, dayScale) {
	const unit = state.prefs.unit;
	let time = 0;
	let distance = 0;

	for (const session of rides) {
		time += session.movingTime || 0;
		distance += session.totalDistance || 0;
	}

	const durationText = formatDurationMinutes(time);
	const distanceText = formatDistance(distance, unit);
	const dayText = cellDate.toLocaleDateString(undefined, { month: "long", day: "numeric" });

	const button = document.createElement("button");
	button.type = "button";
	button.className = "calendar-cell";
	button.style.setProperty("--day-color", paceColor(dayScale(rides)));
	// The cell shows bare figures in a small type size, so spell it all out for
	// anyone reading it aloud.
	button.setAttribute(
		"aria-label",
		rides.length === 1
			? `${rideTitle(rides[0])} on ${dayText}, ${durationText}, ${distanceText} ${distanceUnitLabel(unit)}`
			: `${rides.length} activities on ${dayText}, ${durationText}, ${distanceText} ${distanceUnitLabel(unit)} in total`,
	);

	const number = document.createElement("span");
	number.className = "calendar-day-number";
	number.textContent = String(cellDate.getDate());

	const duration = document.createElement("span");
	duration.className = "calendar-ride-time";
	duration.textContent = durationText;

	const distanceEl = document.createElement("span");
	distanceEl.className = "calendar-ride-distance";
	distanceEl.textContent = distanceText;

	button.append(number, duration, distanceEl);
	button.addEventListener("click", () => {
		if (rides.length === 1) {
			openPostSession(rides[0].id, null, "push");
		} else {
			pickRideFromDay(rides, cellDate);
		}
	});
	return button;
}

// Each row opens its ride itself, as it does in the list.
function pickRideFromDay(rides, cellDate) {
	showModal({
		title: cellDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
		message: "",
		listItems: rides.map((session) => buildSessionRow(session, new Date(session.date), { withTime: true })),
		hideConfirm: true,
		cancelText: "Close",
	});
}

// Returns a function placing a day's rides on the red (0) to green (1) scale,
// by the measure chosen in settings. Every saved day is in the comparison, not
// just the month on screen, so a day keeps its colour as the calendar is paged.
// With nothing to compare against - one day, or every day alike - a day sits in
// the middle.
function calendarDayScale(byDay, sessions) {
	if (state.prefs.calendarColor === "pace") {
		const ranges = ridePaceRanges(sessions);
		return (rides) => {
			// Weighted by distance so a short spin does not recolour a long ride's day.
			let weighted = 0;
			let weight = 0;
			for (const session of rides) {
				const rideWeight = Math.max(session.totalDistance || 0, 1);
				weighted += ridePaceFraction(session, ranges) * rideWeight;
				weight += rideWeight;
			}
			return weighted / weight;
		};
	}

	// Distance, or moving time: the day's total against the smallest and largest.
	const measure =
		state.prefs.calendarColor === "time" ? (session) => session.movingTime || 0 : (session) => session.totalDistance || 0;
	const dayTotal = (rides) => rides.reduce((sum, session) => sum + measure(session), 0);

	let min = Infinity;
	let max = -Infinity;
	for (const rides of byDay.values()) {
		const total = dayTotal(rides);
		min = Math.min(min, total);
		max = Math.max(max, total);
	}
	return (rides) => (max > min ? (dayTotal(rides) - min) / (max - min) : 0.5);
}

// Each activity's slowest and fastest average speed across every saved ride, so
// a ride's pace is judged against its own kind: a brisk walk is not red just
// because bike rides are quicker.
function ridePaceRanges(sessions) {
	const ranges = new Map();
	for (const session of sessions) {
		const speed = rideAvgSpeed(session);
		if (speed <= 0) continue;
		const type = session.activityType || "bike";
		const range = ranges.get(type);
		if (!range) {
			ranges.set(type, { min: speed, max: speed });
		} else {
			range.min = Math.min(range.min, speed);
			range.max = Math.max(range.max, speed);
		}
	}
	return ranges;
}

// 0 for the slowest ride of that activity, 1 for the fastest.
function ridePaceFraction(session, ranges) {
	const range = ranges.get(session.activityType || "bike");
	const speed = rideAvgSpeed(session);
	if (!range || speed <= 0) return 0.5;
	if (range.max - range.min < 0.05) return 0.5;
	return (speed - range.min) / (range.max - range.min);
}

// Distance over moving time. Stored on every saved ride, but worked out again
// for any imported one that lacks it.
function rideAvgSpeed(session) {
	if (Number.isFinite(session.avgSpeed)) return session.avgSpeed;
	const moving = session.movingTime || 0;
	return moving > 0 ? (session.totalDistance || 0) / (moving / 1000) : 0;
}

// withTime puts the start time in place of the part of day, for the day picker
// where every row shares the date.
function buildSessionRow(session, date, { withTime = false } = {}) {
	const unit = state.prefs.unit;
	const button = document.createElement("button");
	button.className = "session-row";
	button.type = "button";

	const main = document.createElement("span");
	main.className = "session-main";

	const when = document.createElement("span");
	when.className = "session-when";
	when.textContent = withTime ? sessionTimeTitle(session, date) : sessionRowTitle(session, date);

	const sub = document.createElement("span");
	sub.className = "session-sub";
	sub.textContent = `${formatDurationMinutes(session.movingTime || 0)} · ${formatSpeed(session.avgSpeed || 0, unit)} ${speedUnitLabel(unit)}`;
	main.append(when, sub);

	const distance = document.createElement("span");
	distance.className = "session-distance";
	distance.innerHTML = `${formatDistance(session.totalDistance || 0, unit)} <span class="unit">${distanceUnitLabel(unit)}</span>`;

	const chevron = document.createElement("span");
	chevron.className = "chevron";
	chevron.setAttribute("aria-hidden", "true");
	chevron.textContent = "›";

	button.append(main, distance, chevron);
	button.addEventListener("click", () => openPostSession(session.id, null, "push"));
	return button;
}

// "Aug 26 · Morning" for a bike ride, the app's default; other activities name
// themselves: "Aug 26 · Morning walk".
function sessionRowTitle(session, date) {
	const dayPart = sessionDayPart(session, date);
	const type = session.activityType || "bike";
	const part = type === "bike" ? dayPart : [dayPartWord(dayPart), ACTIVITIES[type]?.noun].filter(Boolean).join(" ");
	return `${formatSessionDay(date)}${part ? ` · ${part}` : ""}`;
}

// "Morning walk · 8:04 AM" - the ride summary's title.
function sessionTimeTitle(session, date) {
	if (Number.isNaN(date.getTime())) return rideTitle(session);
	return `${rideTitle(session)} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

// "Morning ride", "All-day hike", or just "Ride" with no usable date.
function rideTitle(session) {
	const date = new Date(session.date);
	const noun = ACTIVITIES[session.activityType || "bike"]?.noun || "ride";
	const part = dayPartWord(sessionDayPart(session, date));
	if (!part) return noun.charAt(0).toUpperCase() + noun.slice(1);
	return `${part} ${noun}`;
}

function dayPartWord(dayPart) {
	return dayPart === "All day" ? "All-day" : dayPart;
}

function formatSessionDay(date) {
	if (Number.isNaN(date.getTime())) return "Unknown date";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Half of the day the ride sat in, or "All day" when it ran across noon or past
// midnight. The clock time itself is on the summary screen if it is wanted.
function sessionDayPart(session, date) {
	if (Number.isNaN(date.getTime())) return "";

	const end = sessionEndDate(session, date);
	const crossedDay = end.toDateString() !== date.toDateString();
	const crossedNoon = date.getHours() < 12 && end.getHours() >= 12;
	if (crossedDay || crossedNoon) return "All day";

	if (date.getHours() < 12) return "Morning";
	if (date.getHours() < 17) return "Afternoon";
	return "Evening";
}

function sessionEndDate(session, startDate) {
	// The last fix is the real end. movingTime excludes stops, so it only stands in
	// when a ride recorded no points at all.
	const points = session.points;
	const lastTimestamp = Array.isArray(points) && points.length ? points[points.length - 1].timestamp : null;
	if (Number.isFinite(lastTimestamp)) return new Date(lastTimestamp);
	return new Date(startDate.getTime() + (session.movingTime || 0));
}

async function startCountdownFlow() {
	if (!navigator.geolocation) {
		await showMessage("Geolocation Unavailable", "Geolocation is not available in this browser.");
		return;
	}

	state.selectedActivityType = "bike";
	state.selectedKeepScreenOn = true;
	el.keepScreenOnToggle.checked = true;
	document.querySelectorAll(".activity-btn").forEach((b) => b.classList.remove("active"));
	document.querySelector('[data-activity="bike"]').classList.add("active");
	navigateToScreen("activitySelect");
}

function cancelActivityAndReturnHome() {
	navigateToScreen("home");
}

async function startActivityCountdown({ retry = false } = {}) {
	if (state.selectedActivityType === "bike") requestOrientationPermission();

	const runToken = Date.now();
	state.countdownRunToken = runToken;
	// A retry is already sitting on the countdown entry, so replace it rather than
	// stacking another one behind the back button.
	navigateToScreen("countdown", retry ? "replace" : "push");
	el.retryCountdownBtn.classList.add("hidden");
	el.countdownStatus.textContent = "Getting GPS lock...";

	let countdown = COUNTDOWN_SECONDS;
	el.countdownNumber.textContent = String(countdown);

	// Acquire the fix while the countdown runs, not before it. Awaiting the fix
	// first froze the display on the starting number for the whole timeout and
	// only then began counting, so the rider waited twice over.
	const lockRequest = Promise.race([
		getCurrentPosition(COUNTDOWN_SECONDS * 1000),
		new Promise((resolve) => setTimeout(() => resolve(null), COUNTDOWN_SECONDS * 1000)),
	]).catch(() => null);

	lockRequest.then((position) => {
		if (state.countdownRunToken !== runToken || !position) return;
		el.countdownStatus.textContent = "GPS lock acquired.";
	});

	const intervalId = setInterval(async () => {
		if (state.countdownRunToken !== runToken) {
			clearInterval(intervalId);
			return;
		}

		countdown -= 1;
		el.countdownNumber.textContent = String(Math.max(0, countdown));

		if (countdown > 0) return;

		clearInterval(intervalId);

		const lockPosition = await lockRequest;
		// The rider can cancel while that last await settles.
		if (state.countdownRunToken !== runToken) return;

		if (!lockPosition) {
			el.countdownStatus.textContent = "GPS lock failed. Move to open sky and try again.";
			el.retryCountdownBtn.classList.remove("hidden");
			return;
		}

		await startSession(lockPosition);
	}, 1000);
}

function cancelCountdownAndReturnHome() {
	state.countdownRunToken = 0;
	navigateToScreen("home");
}

async function startSession(initialPosition) {
	const now = Date.now();
	state.currentSession = {
		date: new Date(now).toISOString(),
		unit: state.prefs.unit,
		activityType: state.selectedActivityType,
		keepScreenOn: state.selectedKeepScreenOn,
		points: [],
		totalDistance: 0,
		movingTime: 0,
		maxSpeed: 0,
		avgSpeed: 0,
		elevationGain: 0,
		elevationDrop: 0,
		segments: [],
		segmentMarkers: [],
		paused: false,
		// Point timestamps run on the wall clock, so the stretches the ride spent
		// stopped have to be recorded to be subtracted back out afterwards.
		pauses: [],
		pauseStartedAt: null,
		watchId: null,
		lastPoint: null,
		elapsedIntervalId: null,
		deadReckoningIntervalId: null,
		resumeTimestamp: now,
		altitudeSamples: [],
		smoothAltitudePrev: null,
		nextSegmentDistance: getSegmentLengthMeters(state.prefs.unit),
		segmentStartElapsed: 0,
		shouldRecenter: true,
		currentHeading: 0,
	};

	await requestWakeLock();

	navigateToScreen("active");
	initLiveMap(initialPosition.coords.latitude, initialPosition.coords.longitude);
	loadPaceIndex(state.currentSession);

	// Initialize sensor fusion for GPS outage bridging
	state.gpsOutageDetected = false;
	state.estimatedPointsDuringGap = [];
	state.lastGPSTimestamp = Date.now();
	state.velocityEstimate = 0;
	state.travelHeadingDegrees = null;
	state.compassHeadingDegrees = null;
	state.lastCheckpointAt = Date.now();

	processPosition(initialPosition, true);
	startWatch();
	initMotionSensors();
	state.currentSession.elapsedIntervalId = setInterval(updateLiveStats, 500);
	updateLiveStats();
}

function startWatch() {
	if (!state.currentSession) return;
	state.currentSession.watchId = navigator.geolocation.watchPosition(
		(position) => processPosition(position, false),
		(error) => {
			console.warn("GPS watch error", error);
		},
		{
			enableHighAccuracy: true,
			maximumAge: 0,
			timeout: 10000,
		},
	);
}

function stopWatch() {
	const session = state.currentSession;
	if (session && session.watchId !== null) {
		navigator.geolocation.clearWatch(session.watchId);
		session.watchId = null;
	}
	stopMotionSensors();
}

function initMotionSensors() {
	// Dead reckoning only bridges bike rides; at walking or paddling speeds a
	// dropped fix costs so little distance that inventing points is a net loss.
	if (state.currentSession?.activityType !== "bike") return;
	if (state.motionSensorActive) return;

	state.motionSensorActive = true;
	window.addEventListener("deviceorientationabsolute", handleOrientationUpdate);
	window.addEventListener("deviceorientation", handleOrientationUpdate);

	if (!state.currentSession.deadReckoningIntervalId) {
		state.currentSession.deadReckoningIntervalId = setInterval(() => {
			const session = state.currentSession;
			if (!state.gpsOutageDetected || !session || session.paused || !session.lastPoint) return;

			const heading = getDeadReckoningHeading();
			if (heading == null) return;

			// Chain each step off the previous estimate. Measuring every step from
			// the last real fix instead would stack them all in one spot.
			const origin = state.estimatedPointsDuringGap.length
				? state.estimatedPointsDuringGap[state.estimatedPointsDuringGap.length - 1]
				: session.lastPoint;

			state.estimatedPointsDuringGap.push(
				estimatePositionDuringOutage(origin, heading, state.velocityEstimate, DEAD_RECKONING_STEP_MS / 1000),
			);
		}, DEAD_RECKONING_STEP_MS);
	}
}

function stopMotionSensors() {
	if (state.motionSensorActive) {
		window.removeEventListener("deviceorientationabsolute", handleOrientationUpdate);
		window.removeEventListener("deviceorientation", handleOrientationUpdate);
		state.motionSensorActive = false;
	}
	if (state.gpsOutageTimeout) {
		clearTimeout(state.gpsOutageTimeout);
		state.gpsOutageTimeout = null;
	}
	if (state.currentSession?.deadReckoningIntervalId) {
		clearInterval(state.currentSession.deadReckoningIntervalId);
		state.currentSession.deadReckoningIntervalId = null;
	}
	state.gpsOutageDetected = false;
	state.estimatedPointsDuringGap = [];
}

function requestOrientationPermission() {
	// iOS gates orientation events behind a grant that must originate in a user
	// gesture, so this runs straight off the Start button and is not awaited.
	const OrientationEvent = window.DeviceOrientationEvent;
	if (typeof OrientationEvent?.requestPermission !== "function") return;
	OrientationEvent.requestPermission().catch((error) => {
		console.warn("Orientation permission unavailable", error);
	});
}

function handleOrientationUpdate(event) {
	if (!state.currentSession || state.currentSession.paused) return;

	// Only a north-referenced heading is usable. Safari exposes a true compass
	// bearing directly; elsewhere alpha runs counter-clockwise from north and has
	// to be inverted to become a clockwise bearing. A relative alpha is discarded.
	if (Number.isFinite(event.webkitCompassHeading)) {
		state.compassHeadingDegrees = ((event.webkitCompassHeading % 360) + 360) % 360;
		return;
	}

	if (event.absolute === true && typeof event.alpha === "number") {
		state.compassHeadingDegrees = ((360 - event.alpha) % 360 + 360) % 360;
	}
}

function getDeadReckoningHeading() {
	// Travel bearing between the last two fixes is the better estimator: it
	// measures where the rider is going, not where the handset is pointing.
	if (state.travelHeadingDegrees != null) return state.travelHeadingDegrees;
	return state.compassHeadingDegrees;
}

function updateTravelHeading(session) {
	const points = session.points;
	if (points.length < 2) return;
	const a = points[points.length - 2];
	const b = points[points.length - 1];
	if (haversineMeters(a.lat, a.lng, b.lat, b.lng) < 2) return;
	state.travelHeadingDegrees = bearingDegrees(a.lat, a.lng, b.lat, b.lng);
}

function updateGPSOutageDetection(timestamp) {
	const session = state.currentSession;
	if (!session || !state.motionSensorActive) return;

	if (state.gpsOutageTimeout) {
		clearTimeout(state.gpsOutageTimeout);
	}

	state.lastGPSTimestamp = timestamp;

	state.gpsOutageTimeout = setTimeout(() => {
		if (!state.gpsOutageDetected && state.currentSession && !state.currentSession.paused) {
			state.gpsOutageDetected = true;
			state.estimatedPointsDuringGap = [];
			beginDeadReckoning();
		}
	}, GPS_OUTAGE_THRESHOLD_MS);
}

function beginDeadReckoning() {
	const session = state.currentSession;
	if (!session || !session.lastPoint) return;

	// Carry the last known GPS speed through the gap.
	state.velocityEstimate = session.lastPoint.speed || 0;
}

function estimatePositionDuringOutage(origin, headingDegrees, velocity, timeDeltaSeconds) {
	const metersThisStep = velocity * timeDeltaSeconds;
	const headingRad = (headingDegrees * Math.PI) / 180;

	const { lat, lng } = origin;

	const metersPerDegreeLat = 111320;
	const metersPerDegreeLng = 111320 * Math.cos((lat * Math.PI) / 180);

	const deltaLat = (metersThisStep * Math.cos(headingRad)) / metersPerDegreeLat;
	const deltaLng = metersPerDegreeLng > 1 ? (metersThisStep * Math.sin(headingRad)) / metersPerDegreeLng : 0;

	return {
		lat: lat + deltaLat,
		lng: lng + deltaLng,
		timestamp: Date.now(),
	};
}

function validateAndSpliceGapPoints(resumedGPSPoint) {
	const session = state.currentSession;
	const estimated = state.estimatedPointsDuringGap;

	state.gpsOutageDetected = false;
	state.estimatedPointsDuringGap = [];

	if (!session || !session.lastPoint || !estimated.length) return;

	// Compare the end of the dead-reckoned path against the fix that ended the
	// outage: that is the drift the bridging actually introduced. Measuring from
	// the last real fix instead only measures ordinary travel, so it always passed.
	const lastEstimated = estimated[estimated.length - 1];
	const drift = haversineMeters(lastEstimated.lat, lastEstimated.lng, resumedGPSPoint.lat, resumedGPSPoint.lng);
	if (drift > MAX_DEAD_RECKONING_DRIFT_METERS) return;

	let previous = session.lastPoint;
	for (const pt of estimated) {
		const point = {
			lat: pt.lat,
			lng: pt.lng,
			altitude: previous.altitude ?? null,
			speed: state.velocityEstimate,
			accuracy: null,
			timestamp: pt.timestamp,
			estimated: true,
		};
		session.totalDistance += haversineMeters(previous.lat, previous.lng, point.lat, point.lng);
		session.points.push(point);
		previous = point;
	}

	// Advance lastPoint to the end of the bridged path so processPosition measures
	// only the remaining leg. Leaving it behind counted the gap twice.
	session.lastPoint = previous;
}

function processPosition(position, forceAdd = false) {
	const session = state.currentSession;
	if (!session || session.paused) return;

	const { latitude, longitude, altitude, speed, accuracy, heading } = position.coords;
	const pointTime = position.timestamp || Date.now();

	if (!forceAdd && (accuracy == null || accuracy > 20)) {
		return;
	}

	const safeSpeed = Number.isFinite(speed) && speed >= 0 ? speed : 0;

	const point = {
		lat: latitude,
		lng: longitude,
		altitude: Number.isFinite(altitude) ? altitude : null,
		speed: safeSpeed,
		accuracy: Number.isFinite(accuracy) ? accuracy : null,
		timestamp: pointTime,
	};

	// GPS has resumed after an outage - validate and splice the estimated points
	if (state.gpsOutageDetected) {
		validateAndSpliceGapPoints(point);
	}

	// Update GPS outage monitoring
	updateGPSOutageDetection(pointTime);

	// Update velocity estimate for dead reckoning
	state.velocityEstimate = safeSpeed;

	if (session.lastPoint) {
		session.totalDistance += haversineMeters(session.lastPoint.lat, session.lastPoint.lng, point.lat, point.lng);
	}

	session.points.push(point);
	session.lastPoint = point;
	updateTravelHeading(session);

	session.maxSpeed = Math.max(session.maxSpeed, safeSpeed);

	updateElevationTotals(point.altitude);
	updateSegments(point);
	updateLiveMap(point, heading, safeSpeed);
	updateLiveStats();

	if (Date.now() - state.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
		state.lastCheckpointAt = Date.now();
		saveActiveSessionCheckpoint();
	}
}

function updateElevationTotals(rawAltitude) {
	const session = state.currentSession;
	if (!session || !Number.isFinite(rawAltitude)) return;

	session.altitudeSamples.push(rawAltitude);
	if (session.altitudeSamples.length > 5) session.altitudeSamples.shift();

	const smooth = session.altitudeSamples.reduce((sum, v) => sum + v, 0) / session.altitudeSamples.length;

	if (session.smoothAltitudePrev != null) {
		const delta = smooth - session.smoothAltitudePrev;
		if (delta > 0) session.elevationGain += delta;
		if (delta < 0) session.elevationDrop += Math.abs(delta);
	}

	session.smoothAltitudePrev = smooth;
}

function updateSegments(point) {
	const session = state.currentSession;
	if (!session) return;

	const stepDistance = getSegmentLengthMeters(state.prefs.unit);
	while (session.totalDistance >= session.nextSegmentDistance) {
		const elapsed = getElapsedMs();
		const segmentNumber = session.segments.length + 1;
		const duration = Math.max(0, elapsed - session.segmentStartElapsed);
		const segAvgSpeed = duration > 0 ? stepDistance / (duration / 1000) : 0;

		session.segments.push({
			segmentNumber,
			duration,
			avgSpeed: segAvgSpeed,
		});

		const markerLabel = segmentDistanceLabel(segmentNumber, state.prefs.unit);
		session.segmentMarkers.push({
			lat: point.lat,
			lng: point.lng,
			segmentNumber,
			elapsed,
		});

		if (state.markerLayer) {
			addSegmentMarkerToLayer(state.markerLayer, point.lat, point.lng, markerLabel);
		}

		session.segmentStartElapsed = elapsed;
		session.nextSegmentDistance += stepDistance;
	}
}

function updateLiveMap(point, heading, speedMps) {
	if (!state.liveMap) return;

	state.liveRouteCoords.push([point.lng, point.lat]);
	setLiveLineData(LIVE_ROUTE_SOURCE, state.liveRouteCoords);
	state.riderMarker?.setLngLat([point.lng, point.lat]);

	if (state.currentSession?.points?.length) {
		const startPoint = state.currentSession.points[0];
		state.liveGuideCoords = [
			[startPoint.lng, startPoint.lat],
			[point.lng, point.lat],
		];
		setLiveLineData(LIVE_GUIDE_SOURCE, state.liveGuideCoords);
		updateGuideLabel();
	}

	const session = state.currentSession;
	const threshold = state.prefs.unit === "imperial" ? 3 / MPS_TO_MPH : 5 / MPS_TO_KPH;

	// Below the threshold the last known heading is held. Resetting to north
	// whipped the map round at every traffic light and back again on moving off.
	let nextHeading = session?.currentHeading ?? 0;

	if (speedMps >= threshold) {
		if (Number.isFinite(heading)) {
			nextHeading = heading;
		} else if (session && session.points.length >= 2) {
			const a = session.points[session.points.length - 2];
			const b = session.points[session.points.length - 1];
			nextHeading = bearingDegrees(a.lat, a.lng, b.lat, b.lng);
		}
	}

	if (session) session.currentHeading = nextHeading;
	followLiveMap(point, nextHeading);
	updateBestPace(point, nextHeading);
}

// Heading-up follow camera. MapLibre rotates the map itself, so road names are
// re-laid out upright at every bearing instead of turning with the tiles.
function followLiveMap(point, heading) {
	const map = state.liveMap;

	// Easing the camera cancels any gesture in progress, so a fix that lands
	// mid-pan or mid-zoom is skipped rather than yanking the map from the finger.
	if (map.isZooming() || map.dragPan.isActive() || map.touchZoomRotate.isActive()) return;

	const camera = { bearing: heading, duration: LIVE_CAMERA_EASE_MS, easing: (t) => t };
	if (state.currentSession?.shouldRecenter) camera.center = [point.lng, point.lat];
	map.easeTo(camera);
}

function recenterLiveMap() {
	const session = state.currentSession;
	if (!session || !session.lastPoint || !state.liveMap) return;
	session.shouldRecenter = true;
	setLiveZoomAnchor(state.liveMap, true);
	// Back to the rider's picked riding zoom as well as the rider, dropping any
	// zoom from looking around.
	state.liveMap.easeTo({
		center: [session.lastPoint.lng, session.lastPoint.lat],
		zoom: state.prefs.liveMapZoom,
		bearing: session.currentHeading ?? 0,
	});
}

function updateLiveStats() {
	const session = state.currentSession;
	if (!session) return;

	const elapsed = getElapsedMs();
	const currentSpeed = session.lastPoint ? session.lastPoint.speed : 0;

	// Distance over moving time - the same definition the saved ride summary uses.
	// An unweighted mean of instantaneous fixes disagreed with the post-ride figure.
	session.avgSpeed = elapsed > 0 ? session.totalDistance / (elapsed / 1000) : 0;

	const unit = state.prefs.unit;
	el.currentSpeed.textContent = formatSpeed(currentSpeed, unit);
	el.currentSpeedUnit.textContent = speedUnitLabel(unit);
	el.distanceValue.textContent = formatDistance(session.totalDistance, unit);
	el.distanceUnit.textContent = distanceUnitLabel(unit);
	el.avgSpeed.textContent = formatSpeed(session.avgSpeed, unit);
	el.elapsedTime.textContent = formatDuration(elapsed);
}

function setPauseButton(paused) {
	el.pauseBtn.classList.toggle("is-paused", paused);
	el.pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
	el.rideStrip.classList.toggle("is-paused", paused);
	el.speedLabel.textContent = paused ? "Paused" : "Speed";
}

function getElapsedMs() {
	const session = state.currentSession;
	if (!session) return 0;
	if (session.paused) return session.movingTime;
	return session.movingTime + (Date.now() - session.resumeTimestamp);
}

async function togglePauseSession() {
	const session = state.currentSession;
	if (!session) return;

	if (!session.paused) {
		session.movingTime = getElapsedMs();
		session.paused = true;
		session.pauseStartedAt = Date.now();
		stopWatch();
		setPauseButton(true);
		hideBestPace();
		await releaseWakeLock();
		await saveActiveSessionCheckpoint();
		updateLiveStats();
		return;
	}

	session.paused = false;
	closeOpenPause(session);
	session.resumeTimestamp = Date.now();
	startWatch();
	initMotionSensors();
	setPauseButton(false);
	await requestWakeLock();
}

// Seals the pause that is currently open, if there is one. Called on resume and
// again at finalize, so a ride ended while paused still stores a closed interval.
function closeOpenPause(session, endedAt = Date.now()) {
	if (!session || session.pauseStartedAt == null) return;
	if (!Array.isArray(session.pauses)) session.pauses = [];
	if (endedAt > session.pauseStartedAt) {
		session.pauses.push({ start: session.pauseStartedAt, end: endedAt });
	}
	session.pauseStartedAt = null;
}

async function endSessionWithConfirm() {
	const session = state.currentSession;
	if (!session) return;

	const ok = await confirmWithModal({
		title: "End This Ride?",
		message: "Your current ride will be saved and the summary will open.",
		confirmText: "End Ride",
		cancelText: "Keep Riding",
	});
	if (!ok) return;

	const saved = await finalizeSession();
	await openPostSession(saved.id, saved, "push");
}

async function finalizeSession() {
	const session = state.currentSession;
	if (!session) return null;

	session.movingTime = getElapsedMs();
	session.paused = true;
	closeOpenPause(session);

	stopWatch();
	clearInterval(session.elapsedIntervalId);
	await releaseWakeLock();
	state.paceIndex = null;

	const saved = {
		date: session.date,
		unit: session.unit,
		activityType: session.activityType || "bike",
		keepScreenOn: Boolean(session.keepScreenOn),
		points: session.points,
		totalDistance: session.totalDistance,
		movingTime: session.movingTime,
		maxSpeed: session.maxSpeed,
		avgSpeed: session.movingTime > 0 ? session.totalDistance / (session.movingTime / 1000) : 0,
		elevationGain: session.elevationGain,
		elevationDrop: session.elevationDrop,
		segments: session.segments,
		segmentMarkers: session.segmentMarkers,
		pauses: Array.isArray(session.pauses) ? session.pauses : [],
	};

	const id = await addSession(saved);
	saved.id = id;
	await clearActiveSessionCheckpoint();
	state.currentSession = null;
	setPauseButton(false);
	return saved;
}

async function saveActiveSessionCheckpoint() {
	const session = state.currentSession;
	if (!session) return;

	try {
		await setPref(ACTIVE_SESSION_KEY, {
			date: session.date,
			unit: session.unit,
			activityType: session.activityType,
			keepScreenOn: Boolean(session.keepScreenOn),
			points: session.points,
			totalDistance: session.totalDistance,
			movingTime: getElapsedMs(),
			maxSpeed: session.maxSpeed,
			avgSpeed: session.avgSpeed,
			elevationGain: session.elevationGain,
			elevationDrop: session.elevationDrop,
			segments: session.segments,
			segmentMarkers: session.segmentMarkers,
			pauses: Array.isArray(session.pauses) ? session.pauses : [],
			pauseStartedAt: session.pauseStartedAt ?? null,
			altitudeSamples: session.altitudeSamples,
			smoothAltitudePrev: session.smoothAltitudePrev,
			nextSegmentDistance: session.nextSegmentDistance,
			segmentStartElapsed: session.segmentStartElapsed,
			checkpointedAt: Date.now(),
		});
	} catch (error) {
		console.warn("Ride checkpoint failed", error);
	}
}

async function clearActiveSessionCheckpoint() {
	try {
		await setPref(ACTIVE_SESSION_KEY, null);
	} catch (error) {
		console.warn("Clearing ride checkpoint failed", error);
	}
}

function restoreSessionFromCheckpoint(checkpoint) {
	const points = Array.isArray(checkpoint.points) ? checkpoint.points : [];
	const pauses = Array.isArray(checkpoint.pauses) ? checkpoint.pauses.slice() : [];

	// resumeTimestamp below restarts the clock, so the interrupted stretch is
	// already excluded from moving time. Record it as a pause as well, or the
	// segment table would charge the whole interruption to one segment. A ride
	// interrupted while paused counts from the pause, not from the last fix.
	const gapStart = checkpoint.pauseStartedAt ?? (points.length ? points[points.length - 1].timestamp : null);
	if (Number.isFinite(gapStart) && Date.now() > gapStart) {
		pauses.push({ start: gapStart, end: Date.now() });
	}

	return {
		date: checkpoint.date,
		unit: checkpoint.unit || state.prefs.unit,
		activityType: checkpoint.activityType || "bike",
		keepScreenOn: Boolean(checkpoint.keepScreenOn),
		points,
		totalDistance: checkpoint.totalDistance || 0,
		movingTime: checkpoint.movingTime || 0,
		maxSpeed: checkpoint.maxSpeed || 0,
		avgSpeed: checkpoint.avgSpeed || 0,
		elevationGain: checkpoint.elevationGain || 0,
		elevationDrop: checkpoint.elevationDrop || 0,
		segments: checkpoint.segments || [],
		segmentMarkers: checkpoint.segmentMarkers || [],
		paused: false,
		pauses,
		pauseStartedAt: null,
		watchId: null,
		lastPoint: points.length ? points[points.length - 1] : null,
		elapsedIntervalId: null,
		deadReckoningIntervalId: null,
		// The interrupted stretch is not moving time, so the clock restarts from now.
		resumeTimestamp: Date.now(),
		altitudeSamples: checkpoint.altitudeSamples || [],
		smoothAltitudePrev: checkpoint.smoothAltitudePrev ?? null,
		nextSegmentDistance: checkpoint.nextSegmentDistance || getSegmentLengthMeters(state.prefs.unit),
		segmentStartElapsed: checkpoint.segmentStartElapsed || 0,
		shouldRecenter: true,
		currentHeading: 0,
	};
}

async function maybeRecoverSession() {
	let checkpoint = null;
	try {
		checkpoint = await getPref(ACTIVE_SESSION_KEY, null);
	} catch (error) {
		console.warn("Reading ride checkpoint failed", error);
		return;
	}

	if (!checkpoint || !Array.isArray(checkpoint.points) || checkpoint.points.length < 2) {
		if (checkpoint) await clearActiveSessionCheckpoint();
		return;
	}

	const restored = restoreSessionFromCheckpoint(checkpoint);
	const unitLabel = distanceUnitLabel(state.prefs.unit);
	const distanceText = `${formatDistance(restored.totalDistance, state.prefs.unit)} ${unitLabel}`;
	const resume = await confirmWithModal({
		title: "Unfinished Ride Found",
		message: `A ride from ${new Date(restored.date).toLocaleString()} was interrupted with ${distanceText} recorded. Resume it, or save it and open the summary?`,
		confirmText: "Resume",
		cancelText: "Save & Finish",
	});

	if (resume) {
		await resumeCheckpointedSession(restored);
		return;
	}

	state.currentSession = restored;
	const saved = await finalizeSession();
	await renderPastRides();
	if (saved) await openPostSession(saved.id, saved, "replace");
}

async function resumeCheckpointedSession(restored) {
	state.currentSession = restored;
	state.gpsOutageDetected = false;
	state.estimatedPointsDuringGap = [];
	state.velocityEstimate = 0;
	state.travelHeadingDegrees = null;
	state.compassHeadingDegrees = null;
	state.lastGPSTimestamp = Date.now();
	state.lastCheckpointAt = Date.now();

	navigateToScreen("active", "replace");
	initLiveMap(restored.lastPoint.lat, restored.lastPoint.lng);
	loadPaceIndex(restored);

	state.liveRouteCoords = restored.points.map((point) => [point.lng, point.lat]);
	setLiveLineData(LIVE_ROUTE_SOURCE, state.liveRouteCoords);
	if (state.markerLayer) {
		renderSegmentMarkers(state.markerLayer, restored.segmentMarkers || []);
	}

	await requestWakeLock();
	startWatch();
	initMotionSensors();
	restored.elapsedIntervalId = setInterval(updateLiveStats, 500);
	updateLiveStats();
}

function initLiveMap(lat, lng) {
	if (state.liveMap) {
		state.liveMap.remove();
		state.liveMap = null;
	}

	state.liveRouteCoords = [];
	state.liveGuideCoords = [];

	const map = createVectorMap(
		{
			container: "liveMap",
			center: [lng, lat],
			zoom: state.prefs.liveMapZoom,
			bearing: state.currentSession?.currentHeading ?? 0,
			pitch: LIVE_MAP_PITCH,
		},
		addLiveOverlayLayers,
	);
	state.liveMap = map;
	state.markerLayer = createMarkerLayer(map);
	state.guideLabelMarker = createGuideLabelMarker(map);
	state.riderMarker = createPointMarker(map, "rider-dot", [lng, lat]);
	state.bestPaceChip = createBestPaceChip(map, [lng, lat]);
	state.bestPaceBand = null;
	// Its offset is in pixels, so its ground position depends on the zoom.
	map.on("zoom", updateGuideLabel);

	// The rider sits two-thirds of the way down, leaving the larger share of the
	// tilted map for the road ahead. Padding moves the camera's centre, so the
	// follow camera, rotation, Re-center and rider-anchored zooms all aim there.
	const placeRider = () => map.setPadding({ top: map.getContainer().clientHeight / 3, bottom: 0, left: 0, right: 0 });
	placeRider();
	map.on("resize", placeRider);
	setLiveZoomAnchor(map, true);

	// A one-finger or mouse drag means the rider wants to look around, so the
	// camera stops following. Zooming, a two-finger pinch included, keeps it
	// following at the new zoom. Only gestures carry an originalEvent; the follow
	// camera's own moves do not.
	map.on("dragstart", (event) => {
		const gesture = event.originalEvent;
		if (!gesture || !state.currentSession) return;
		if (gesture.touches && gesture.touches.length > 1) return;
		state.currentSession.shouldRecenter = false;
		setLiveZoomAnchor(map, false);
	});

	// A zoom made while following is the rider picking their riding zoom, so it
	// is kept for this and future rides. A zoom after panning away is just a look
	// around, and Re-center undoes it.
	let pickingZoom = false;
	map.on("zoomstart", (event) => {
		pickingZoom = Boolean(event.originalEvent && state.currentSession?.shouldRecenter);
	});
	map.on("zoomend", () => {
		if (!pickingZoom) return;
		pickingZoom = false;
		saveLiveMapZoom(map.getZoom());
	});
}

async function saveLiveMapZoom(zoom) {
	state.prefs.liveMapZoom = zoom;
	await setPref("liveMapZoom", zoom);
}

// While following, zooms pivot on the rider so they stay put under the camera.
// Once the map has been panned away, zooms pivot on the finger or cursor.
function setLiveZoomAnchor(map, aroundRider) {
	const options = aroundRider ? { around: "center" } : undefined;
	map.touchZoomRotate.enable(options);
	// The scroll handler ignores enable() while it is already enabled.
	map.scrollZoom.disable();
	map.scrollZoom.enable(options);
}

// Shared by the live and post-ride maps: provider and theme choice, the topo
// layers, the Stadia fallback, and re-adding the map's own overlays whenever
// its style is swapped.
function createVectorMap(options, addOverlays) {
	const usesStadia = Boolean(state.prefs.stadiaKey);
	const map = new maplibregl.Map({
		...options,
		style: mapStyleUrl(usesStadia),
		// Heading owns the live map's bearing and the ride summary stays north-up,
		// so rotate and tilt gestures have no job on either map.
		dragRotate: false,
		pitchWithRotate: false,
		touchPitch: false,
		attributionControl: { compact: true },
	});
	// No zoom buttons: both maps are pinch-to-zoom, and the stats strip sits
	// where the buttons would go.
	map.touchZoomRotate.disableRotation();
	state.mapStatus.set(map, { usesStadia, styleReady: false });

	// Fires for the first style and again after every setStyle, which discards
	// the overlays along with the old style.
	map.on("style.load", () => {
		state.mapStatus.get(map).styleReady = true;
		addTopoLayers(map);
		addOverlays(map);
	});
	map.on("error", (event) => handleMapError(map, event));
	return map;
}

function isMapStyleReady(map) {
	return Boolean(map && state.mapStatus.get(map)?.styleReady);
}

// Vector styles only: raster tiles bake their labels in, and those would turn
// upside down as the live map rotates. Both providers use the OpenMapTiles
// schema, so the topo layers below slot into either.
function mapStyleUrl(useStadia) {
	const dark = state.prefs.theme === "dark";
	const topo = state.prefs.mapType === "topo";

	if (useStadia) {
		const styleName = dark ? "alidade_smooth_dark" : topo ? "outdoors" : "alidade_smooth";
		return `https://tiles.stadiamaps.com/styles/${styleName}.json?api_key=${encodeURIComponent(state.prefs.stadiaKey)}`;
	}

	const styleName = dark ? "dark" : topo ? "liberty" : "positron";
	return `https://tiles.openfreemap.org/styles/${styleName}`;
}

function setMapStyle(map, useStadia) {
	const status = state.mapStatus.get(map);
	status.usesStadia = useStadia;
	status.styleReady = false;
	// A diffed swap keeps the old style object and never fires style.load, which
	// would silently drop the overlays and topo layers.
	map.setStyle(mapStyleUrl(useStadia), { diff: false });
}

function rebuildMapStyles() {
	for (const map of [state.liveMap, state.postMap]) {
		if (map) setMapStyle(map, Boolean(state.prefs.stadiaKey));
	}
}

function handleMapError(map, event) {
	console.warn("Map error", event.error || event);
	const status = state.mapStatus.get(map);
	if (!status.usesStadia) return;

	// A rejected or mistyped Stadia key would otherwise leave the map blank for
	// the whole ride. Offline tile misses are not a key problem, so they stay put.
	const httpStatus = event.error?.status;
	if (!status.styleReady || httpStatus === 401 || httpStatus === 403) {
		setMapStyle(map, false);
	}
}

function lineData(coords) {
	if (coords.length < 2) return { type: "FeatureCollection", features: [] };
	return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
}

// A no-op until the style is ready; style.load then builds the source from the
// same coordinates.
function setLiveLineData(sourceId, coords) {
	state.liveMap?.getSource(sourceId)?.setData(lineData(coords));
}

function addLiveOverlayLayers(map) {
	const guideStyle = getGuideLineStyle(state.prefs.guideContrast);
	const round = { "line-cap": "round", "line-join": "round" };

	map.addSource(LIVE_ROUTE_SOURCE, { type: "geojson", data: lineData(state.liveRouteCoords) });
	map.addSource(LIVE_GUIDE_SOURCE, { type: "geojson", data: lineData(state.liveGuideCoords) });

	// The best-pace band sits under the road names, like a highlighter on the
	// roads, while the route and guide line stay on top of everything.
	const labelBeforeId = styleLayerAnchors(map).labelBeforeId;
	for (let slot = 0; slot < BEST_PACE_SLOTS; slot++) {
		const id = `${BEST_PACE_LAYER}-${slot}`;
		const path = state.bestPaceBand?.[slot];
		map.addSource(id, { type: "geojson", data: lineData(path?.coords ?? []), lineMetrics: true });
		map.addLayer(
			{
				id,
				type: "line",
				source: id,
				layout: round,
				paint: {
					"line-width": ["interpolate", ["linear"], ["zoom"], 13, 6, 16, 20, 19, 46],
					"line-blur": 1,
					"line-gradient": path?.gradient ?? CLEAR_LINE_GRADIENT,
				},
			},
			labelBeforeId,
		);
	}

	map.addLayer({
		id: "live-route",
		type: "line",
		source: LIVE_ROUTE_SOURCE,
		layout: round,
		paint: { "line-color": "#0b5d3b", "line-width": 5 },
	});
	map.addLayer({
		id: "live-guide-halo",
		type: "line",
		source: LIVE_GUIDE_SOURCE,
		layout: round,
		paint: guideHaloPaint(guideStyle),
	});
	map.addLayer({
		id: "live-guide",
		type: "line",
		source: LIVE_GUIDE_SOURCE,
		layout: round,
		paint: guideLinePaint(guideStyle),
	});
}

function guideHaloPaint(guideStyle) {
	return linePaint(guideStyle.haloColor, guideStyle.haloWeight, guideStyle.haloOpacity, guideStyle.dashArray);
}

function guideLinePaint(guideStyle) {
	return linePaint(guideStyle.lineColor, guideStyle.lineWeight, guideStyle.lineOpacity, guideStyle.dashArray);
}

function linePaint(color, width, opacity, dashArray) {
	return {
		"line-color": color,
		"line-width": width,
		"line-opacity": opacity,
		// The guide styles give dashes in pixels; MapLibre measures them in line widths.
		"line-dasharray": dashArray.split(" ").map((px) => Number(px) / width),
	};
}

function applyLiveGuideStyle(guideStyle) {
	const map = state.liveMap;
	if (!isMapStyleReady(map)) return;
	for (const [layerId, paint] of [
		["live-guide-halo", guideHaloPaint(guideStyle)],
		["live-guide", guideLinePaint(guideStyle)],
	]) {
		if (!map.getLayer(layerId)) continue;
		for (const [property, value] of Object.entries(paint)) map.setPaintProperty(layerId, property, value);
	}
}

// Contours are computed in a worker from the elevation tiles, so topo needs no
// tile server of its own. The same cached tiles also feed the hillshade.
function getDemSource() {
	if (!state.demSource && typeof mlcontour !== "undefined") {
		state.demSource = new mlcontour.DemSource({
			url: DEM_TILE_URL,
			encoding: "terrarium",
			maxzoom: DEM_MAX_ZOOM,
			worker: true,
		});
		state.demSource.setupMaplibre(maplibregl);
	}
	return state.demSource;
}

// Where added layers slot into the base style. Relief goes under roads and
// buildings so it shades the land without dimming them. Anything labelled or
// highlighted goes under the road names and place labels, so those stay on top.
// Some styles put water names first, which is why the first symbol layer alone
// is not a safe anchor.
function styleLayerAnchors(map) {
	const layers = map.getStyle().layers;
	const firstSymbolId = layers.find((layer) => layer.type === "symbol")?.id;
	return {
		reliefBeforeId:
			layers.find((layer) => ["transportation", "building", "aeroway"].includes(layer["source-layer"]))?.id ??
			firstSymbolId,
		labelBeforeId:
			layers.find((layer) => ["transportation_name", "place"].includes(layer["source-layer"]))?.id ?? firstSymbolId,
	};
}

function addTopoLayers(map) {
	if (state.prefs.mapType !== "topo") return;
	const demSource = getDemSource();
	if (!demSource) return;

	const dark = state.prefs.theme === "dark";
	const imperial = state.prefs.unit === "imperial";
	const layers = map.getStyle().layers;
	const { reliefBeforeId, labelBeforeId } = styleLayerAnchors(map);

	// Contour labels have to use a font the style's glyph server actually has.
	// Styles often lead with an italic for water names, so a regular face wins.
	const styleFonts = layers
		.map((layer) => layer.layout?.["text-font"])
		.filter((font) => Array.isArray(font) && font.every((name) => typeof name === "string"));
	const textFont = styleFonts.find((font) => /regular/i.test(font[0])) ?? styleFonts[0] ?? ["Noto Sans Regular"];

	const contourColor = dark ? "rgba(214, 196, 160, 0.4)" : "rgba(128, 88, 40, 0.5)";
	const contourTextColor = dark ? "#d6c4a0" : "#6b4a22";

	map.addSource("topo-dem", {
		type: "raster-dem",
		encoding: "terrarium",
		tiles: [demSource.sharedDemProtocolUrl],
		tileSize: 256,
		maxzoom: DEM_MAX_ZOOM,
		attribution: DEM_ATTRIBUTION,
	});
	map.addLayer(
		{
			id: "topo-hillshade",
			type: "hillshade",
			source: "topo-dem",
			paint: dark
				? {
					"hillshade-exaggeration": 0.35,
					"hillshade-shadow-color": "rgba(0, 0, 0, 0.6)",
					"hillshade-highlight-color": "rgba(255, 255, 255, 0.2)",
					"hillshade-accent-color": "rgba(0, 0, 0, 0.3)",
				}
				: {
					"hillshade-exaggeration": 0.4,
					"hillshade-shadow-color": "rgba(71, 59, 36, 0.55)",
					"hillshade-highlight-color": "rgba(255, 255, 255, 0.35)",
					"hillshade-accent-color": "rgba(71, 59, 36, 0.25)",
				},
		},
		reliefBeforeId,
	);

	map.addSource("topo-contours", {
		type: "vector",
		tiles: [
			demSource.contourProtocolUrl({
				multiplier: imperial ? FEET_PER_METER : 1,
				// zoom: [minor, major] interval, in the display unit.
				thresholds: imperial
					? { 11: [200, 1000], 12: [100, 500], 14: [50, 200], 15: [20, 100] }
					: { 11: [50, 250], 12: [25, 100], 14: [10, 50], 15: [5, 25] },
				contourLayer: "contours",
				elevationKey: "ele",
				levelKey: "level",
			}),
		],
		maxzoom: 15,
	});
	map.addLayer(
		{
			id: "topo-contour-lines",
			type: "line",
			source: "topo-contours",
			"source-layer": "contours",
			paint: {
				"line-color": contourColor,
				// level is 1 for major lines and 0 for minor ones.
				"line-width": ["match", ["get", "level"], 1, 1.1, 0.5],
			},
		},
		reliefBeforeId,
	);
	map.addLayer(
		{
			id: "topo-contour-labels",
			type: "symbol",
			source: "topo-contours",
			"source-layer": "contours",
			filter: [">", ["get", "level"], 0],
			layout: {
				"symbol-placement": "line",
				"text-size": 10,
				"text-field": ["concat", ["number-format", ["get", "ele"], {}], imperial ? " ft" : " m"],
				"text-font": textFont,
			},
			paint: {
				"text-color": contourTextColor,
				"text-halo-color": dark ? "rgba(0, 0, 0, 0.75)" : "rgba(255, 255, 255, 0.85)",
				"text-halo-width": 1,
			},
		},
		labelBeforeId,
	);
}

// Contour intervals and labels are in the display unit, so a unit change
// rebuilds them in place rather than reloading the whole style.
function refreshTopoLayers() {
	for (const map of [state.liveMap, state.postMap]) {
		if (!isMapStyleReady(map)) continue;
		for (const layerId of TOPO_LAYER_IDS) {
			if (map.getLayer(layerId)) map.removeLayer(layerId);
		}
		for (const sourceId of TOPO_SOURCE_IDS) {
			if (map.getSource(sourceId)) map.removeSource(sourceId);
		}
		// Topo layers go under everything else, so re-adding them after the
		// overlays still leaves the route on top.
		addTopoLayers(map);
	}
}

// Distance flags. MapLibre markers sit in screen space, so they stay upright as
// the live map rotates underneath them.
function createMarkerLayer(map) {
	let markers = [];
	return {
		add(lat, lng, element) {
			markers.push(new maplibregl.Marker({ element }).setLngLat([lng, lat]).addTo(map));
		},
		clearLayers() {
			for (const marker of markers) marker.remove();
			markers = [];
		},
	};
}

// A styled dot pinned to one spot: the rider, or a route's start and finish.
function createPointMarker(map, className, lngLat) {
	const element = document.createElement("div");
	element.className = className;
	return new maplibregl.Marker({ element }).setLngLat(lngLat).addTo(map);
}

// The distance back to the start, as a chip on the guide line. It takes the
// guide line's colours so the two read as one, and the distance markers' size.
function createGuideLabelMarker(map) {
	const element = document.createElement("div");
	element.className = "guide-distance-label";
	element.append(document.createElement("span"));
	element.style.visibility = "hidden";
	styleGuideLabel(element, state.prefs.guideContrast, state.prefs.markerSize);
	return new maplibregl.Marker({ element }).setLngLat([0, 0]).addTo(map);
}

function styleGuideLabel(element, guideContrast, markerSize) {
	const guideStyle = getGuideLineStyle(guideContrast);
	element.style.setProperty("--guide-label-bg", guideStyle.haloColor);
	element.style.setProperty("--guide-label-fg", guideStyle.lineColor);
	// classList, not className: MapLibre keeps its own marker classes on it.
	element.classList.remove("small", "medium", "large");
	element.classList.add(getMarkerSizeConfig(markerSize).className);
}

// Placed a fixed distance from the rider rather than at the line's midpoint,
// which is off the map on a long ride. It is worked out along the line in
// Mercator space, where the guide line is drawn straight, because a start far
// behind the tilted camera cannot be projected to the screen reliably.
function updateGuideLabel() {
	const map = state.liveMap;
	const marker = state.guideLabelMarker;
	if (!map || !marker) return;
	const element = marker.getElement();

	if (state.liveGuideCoords.length < 2) {
		element.style.visibility = "hidden";
		return;
	}

	const [origin, rider] = state.liveGuideCoords;
	const from = maplibregl.MercatorCoordinate.fromLngLat(rider);
	const to = maplibregl.MercatorCoordinate.fromLngLat(origin);
	const linePixels = Math.hypot(to.x - from.x, to.y - from.y) * WORLD_SIZE_AT_ZOOM_0 * 2 ** map.getZoom();

	// Too short to hold the chip without covering the rider and the start.
	if (linePixels < GUIDE_LABEL_MIN_LINE_PX) {
		element.style.visibility = "hidden";
		return;
	}

	const fraction = Math.min(GUIDE_LABEL_OFFSET_PX / linePixels, 0.5);
	const at = new maplibregl.MercatorCoordinate(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction);
	marker.setLngLat(at.toLngLat());

	const meters = haversineMeters(rider[1], rider[0], origin[1], origin[0]);
	element.firstChild.textContent = `${formatDistance(meters, state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)} to start`;
	element.style.visibility = "visible";
}

// ---- Best past pace ----

// Indexes the saved rides of the same activity when a ride starts. It is ready
// a moment later; until then the readout and band stay hidden.
async function loadPaceIndex(session) {
	state.paceIndex = null;
	if (!state.prefs.comparePastRides) return;
	const activity = session.activityType || "bike";
	try {
		const sessions = (await getAllSessions()).filter((saved) => (saved.activityType || "bike") === activity);
		const index = await buildPaceIndex(sessions);
		// The ride may have ended, or another begun, while the index was building.
		if (state.currentSession === session) state.paceIndex = index;
	} catch (error) {
		console.warn("Indexing past rides failed", error);
	}
}

function updateBestPace(point, heading) {
	const session = state.currentSession;
	const index = state.paceIndex;
	state.bestPaceChip?.setLngLat([point.lng, point.lat]);

	if (!state.prefs.comparePastRides || !index || !session || session.paused) {
		hideBestPace();
		return;
	}

	// The band shows every known path ahead even where this spot has no history,
	// such as a new street leading onto roads ridden before.
	setBestPaceBand(pathsAhead(index, point, heading, BEST_PACE_BAND_M));

	const here = bestPaceAt(index, point.lat, point.lng, heading);
	if (!Number.isFinite(here.best)) {
		renderBestPaceChip({ empty: true });
		return;
	}
	renderBestPaceChip({ best: here.best, current: trailingPace(session.points), grade: here.grade });
}

function hideBestPace() {
	renderBestPaceChip(null);
	setBestPaceBand(null);
}

const GRADE_ICON =
	'<svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true"><path d="M5 9.6V1.8M1.6 5.1 5 1.6l3.4 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The readout rides beside the rider dot, off the road ahead. It is a marker
// anchored on its left edge, so it follows the rider in screen space.
function createBestPaceChip(map, lngLat) {
	const element = document.createElement("div");
	element.className = "best-pace-chip";
	element.hidden = true;
	element.innerHTML = `
		<div class="best-pace-top"><span class="label">Best here</span><span class="best-pace-value"></span></div>
		<div class="best-pace-delta"><span class="best-pace-delta-value"></span><span class="best-pace-unit"></span></div>
		<div class="best-pace-grade" hidden>${GRADE_ICON}<span></span></div>
		<div class="best-pace-empty" hidden>No past rides this way</div>`;
	return new maplibregl.Marker({ element, anchor: "left", offset: [22, 0] }).setLngLat(lngLat).addTo(map);
}

// view: null hides it; {empty: true} for no past rides this way; otherwise the
// best past pace, the rider's own pace over the same stretch, and the grade.
function renderBestPaceChip(view) {
	const element = state.bestPaceChip?.getElement();
	if (!element) return;
	element.hidden = !view;
	if (!view) return;

	const part = (selector) => element.querySelector(selector);
	element.classList.toggle("is-empty", Boolean(view.empty));
	part(".best-pace-top").hidden = Boolean(view.empty);
	part(".best-pace-delta").hidden = Boolean(view.empty);
	part(".best-pace-empty").hidden = !view.empty;
	if (view.empty) {
		part(".best-pace-grade").hidden = true;
		element.classList.remove("is-ahead", "is-pending");
		return;
	}

	const unit = state.prefs.unit;
	const best = formatSpeed(view.best, unit);
	part(".best-pace-value").textContent = best;
	part(".best-pace-unit").textContent = speedUnitLabel(unit);

	// The delta is taken between the rounded figures so it always matches what
	// the two numbers on screen say.
	if (Number.isFinite(view.current)) {
		const delta = Number(formatSpeed(view.current, unit)) - Number(best);
		const ahead = delta >= 0;
		part(".best-pace-delta-value").textContent = `${ahead ? "+" : "−"}${Math.abs(delta).toFixed(1)}`;
		element.classList.toggle("is-ahead", ahead);
		element.classList.remove("is-pending");
	} else {
		part(".best-pace-delta-value").textContent = "–";
		element.classList.remove("is-ahead");
		element.classList.add("is-pending");
	}

	const climbing = view.grade >= BEST_PACE_CLIMB_GRADE;
	part(".best-pace-grade").hidden = !climbing;
	if (climbing) part(".best-pace-grade span").textContent = `${Math.round(view.grade * 100)}% climb`;
}

// Colours the paths ahead by the best past pace along them, on the rider's own
// slow-to-fast range, fading out with distance from the rider. Each path is one
// line with a gradient along it, so colour and fade change smoothly and nothing
// overlaps itself.
function setBestPaceBand(lines) {
	const index = state.paceIndex;
	const paths = [];
	if (lines && index) {
		const range = index.fast - index.slow;
		const measured = lines.map((line) => {
			const along = [0];
			for (let k = 1; k < line.coords.length; k++) {
				const [lngA, latA] = line.coords[k - 1];
				const [lngB, latB] = line.coords[k];
				along.push(along[k - 1] + haversineMeters(latA, lngA, latB, lngB));
			}
			return { line, along };
		});
		measured.sort((a, b) => b.along[b.along.length - 1] - a.along[a.along.length - 1]);

		for (const { line, along } of measured.slice(0, BEST_PACE_SLOTS)) {
			const total = along[along.length - 1];
			const stops = [];
			let lastProgress = -1;
			for (let k = 0; k < line.coords.length; k++) {
				const progress = along[k] / total;
				// line-gradient needs strictly rising stops.
				if (!(progress > lastProgress)) continue;
				lastProgress = progress;
				const t = range > 0 && Number.isFinite(line.paces[k]) ? (line.paces[k] - index.slow) / range : 0.5;
				const alpha = BEST_PACE_BAND_OPACITY * Math.max(0, 1 - (line.distances[k] / BEST_PACE_BAND_M) ** 1.4);
				stops.push(progress, paceColor(t).replace("rgb(", "rgba(").replace(")", `, ${alpha.toFixed(3)})`));
			}
			if (stops.length >= 4) {
				paths.push({ coords: line.coords, gradient: ["interpolate", ["linear"], ["line-progress"], ...stops] });
			}
		}
	}

	// Slots that were empty before and still are need no update.
	const slotsInUse = Math.max(state.bestPaceBand?.length ?? 0, paths.length);
	state.bestPaceBand = paths;

	const map = state.liveMap;
	if (!isMapStyleReady(map)) return;
	for (let slot = 0; slot < slotsInUse; slot++) {
		const id = `${BEST_PACE_LAYER}-${slot}`;
		if (!map.getLayer(id)) continue;
		map.getSource(id).setData(lineData(paths[slot]?.coords ?? []));
		map.setPaintProperty(id, "line-gradient", paths[slot]?.gradient ?? CLEAR_LINE_GRADIENT);
	}
}

function initPostMap(session) {
	if (state.postMap) {
		state.postMap.remove();
		state.postMap = null;
	}

	// The highlight marker went with the map it was on.
	state.chartHighlightMarker = null;
	state.highlightedPointIndex = -1;

	const routeData = buildSpeedBandRoute(session.points);
	const bounds = routeBounds(session.points);
	const view = bounds
		? { bounds, fitBoundsOptions: { maxZoom: 17 } }
		: { center: [0, 0], zoom: 2 };

	state.postMap = createVectorMap({ container: "postMap", ...view }, (map) => addPostRouteLayer(map, routeData));
	state.postMarkerLayer = createMarkerLayer(state.postMap);

	const points = session.points || [];
	if (points.length) {
		const first = points[0];
		const last = points[points.length - 1];
		// Finish first, so the start draws on top where a loop ends where it began.
		createPointMarker(state.postMap, "route-finish", [last.lng, last.lat]);
		createPointMarker(state.postMap, "route-start", [first.lng, first.lat]);
	}

	// Recalculate segment markers based on current unit settings
	const segmentMarkers = recalculateSegmentMarkers(session);
	renderSegmentMarkers(state.postMarkerLayer, segmentMarkers);
}

// One feature per speed band, not one per point pair. A two-hour ride is
// thousands of pairs; each band renders as a single multi-line, so no detail is
// lost.
function buildSpeedBandRoute(points) {
	const features = [];
	if (points.length < 2) return { type: "FeatureCollection", features };

	const maxSpeed = Math.max(maxOf(points, (p) => p.speed || 0), 0.0001);
	const bands = new Map();
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		const midSpeed = ((prev.speed || 0) + (curr.speed || 0)) / 2;
		const band = speedBand(midSpeed, maxSpeed);

		let runs = bands.get(band);
		if (!runs) {
			runs = [];
			bands.set(band, runs);
		}

		// Extend the previous run when this pair continues it, so a steady
		// stretch becomes one subpath rather than many.
		const lastRun = runs.length ? runs[runs.length - 1] : null;
		if (lastRun && lastRun.endIndex === i - 1) {
			lastRun.coords.push([curr.lng, curr.lat]);
			lastRun.endIndex = i;
		} else {
			runs.push({
				coords: [
					[prev.lng, prev.lat],
					[curr.lng, curr.lat],
				],
				endIndex: i,
			});
		}
	}

	for (const [band, runs] of bands) {
		features.push({
			type: "Feature",
			properties: { band, color: speedBandColor(band) },
			geometry: { type: "MultiLineString", coordinates: runs.map((run) => run.coords) },
		});
	}
	return { type: "FeatureCollection", features };
}

function addPostRouteLayer(map, routeData) {
	map.addSource("post-route", { type: "geojson", data: routeData });
	// A casing under the coloured line lifts it off busy tiles.
	const dark = state.prefs.theme === "dark";
	map.addLayer({
		id: "post-route-casing",
		type: "line",
		source: "post-route",
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": dark ? "#000000" : "#ffffff",
			"line-opacity": dark ? 0.45 : 0.85,
			"line-width": 10,
		},
	});
	map.addLayer({
		id: "post-route",
		type: "line",
		source: "post-route",
		layout: {
			"line-cap": "round",
			"line-join": "round",
			// Slower bands draw first so the faster stretches stay visible where a
			// route crosses itself.
			"line-sort-key": ["get", "band"],
		},
		paint: { "line-color": ["get", "color"], "line-width": 5 },
	});
}

// The route's extent plus 12% on every side, so it never touches the map edge.
function routeBounds(points) {
	if (!points.length) return null;
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const point of points) {
		west = Math.min(west, point.lng);
		east = Math.max(east, point.lng);
		south = Math.min(south, point.lat);
		north = Math.max(north, point.lat);
	}
	const padLng = (east - west) * 0.12;
	const padLat = (north - south) * 0.12;
	return [
		[west - padLng, south - padLat],
		[east + padLng, north + padLat],
	];
}

function recalculateSegmentMarkers(session) {
	if (!session.points || !session.points.length) return [];

	const segmentMarkers = [];
	const stepDistance = getSegmentLengthMeters(state.prefs.unit);
	
	// Calculate cumulative distance for each point
	let cumulativeDistance = 0;
	const pointDistances = session.points.map((point, index) => {
		if (index > 0) {
			const prev = session.points[index - 1];
			cumulativeDistance += haversineMeters(prev.lat, prev.lng, point.lat, point.lng);
		}
		return cumulativeDistance;
	});

	// Find segment boundaries and nearest points
	let nextSegmentDistance = stepDistance;
	let segmentNumber = 1;

	for (let i = 1; i < pointDistances.length; i++) {
		const distance = pointDistances[i];
		
		while (distance >= nextSegmentDistance) {
			// Find the closest point to this segment boundary
			let closestIndex = i - 1;
			let closestDelta = Math.abs(pointDistances[i - 1] - nextSegmentDistance);

			for (let j = Math.max(0, i - 5); j < i; j++) {
				const delta = Math.abs(pointDistances[j] - nextSegmentDistance);
				if (delta < closestDelta) {
					closestDelta = delta;
					closestIndex = j;
				}
			}

			const point = session.points[closestIndex];
			segmentMarkers.push({
				lat: point.lat,
				lng: point.lng,
				segmentNumber,
			});

			segmentNumber++;
			nextSegmentDistance += stepDistance;
		}
	}

	return segmentMarkers;
}

// Wall-clock span between two point timestamps with any paused portion removed.
// getElapsedMs() already defines the headline moving time this way, so segment
// durations have to be measured the same way or the table will not sum to it.
function movingMsBetween(startMs, endMs, pauses) {
	let pausedMs = 0;
	for (const pause of pauses) {
		const overlapStart = Math.max(startMs, pause.start);
		const overlapEnd = Math.min(endMs, pause.end ?? endMs);
		if (overlapEnd > overlapStart) pausedMs += overlapEnd - overlapStart;
	}
	return Math.max(0, endMs - startMs - pausedMs);
}

function recalculateSegments(session) {
	if (!session.points || !session.points.length) return [];

	const segments = [];
	const stepDistance = getSegmentLengthMeters(state.prefs.unit);
	const pauses = Array.isArray(session.pauses) ? session.pauses : [];

	// Calculate cumulative distance and time for each point
	let cumulativeDistance = 0;
	let cumulativeTime = 0;
	const pointData = session.points.map((point, index) => {
		if (index > 0) {
			const prev = session.points[index - 1];
			cumulativeDistance += haversineMeters(prev.lat, prev.lng, point.lat, point.lng);
			cumulativeTime += movingMsBetween(prev.timestamp, point.timestamp, pauses);
		}
		return {
			distance: cumulativeDistance,
			time: cumulativeTime,
		};
	});

	// Find segment boundaries
	let nextSegmentDistance = stepDistance;
	let segmentNumber = 1;
	let segmentStartTime = 0;

	for (let i = 1; i < pointData.length; i++) {
		const data = pointData[i];
		
		while (data.distance >= nextSegmentDistance) {
			// Calculate time and average speed for this segment
			const segmentTime = data.time - segmentStartTime;
			const segmentAvgSpeed = segmentTime > 0 ? stepDistance / (segmentTime / 1000) : 0; // m/s

			segments.push({
				segmentNumber,
				duration: segmentTime,
				avgSpeed: segmentAvgSpeed,
			});

			segmentNumber++;
			segmentStartTime = data.time;
			nextSegmentDistance += stepDistance;
		}
	}

	// A ride almost never ends on a boundary. Without this row the table silently
	// drops the last stretch and never adds up to the headline moving time.
	const last = pointData[pointData.length - 1];
	const partialDistance = last.distance - (nextSegmentDistance - stepDistance);
	if (partialDistance > 1) {
		const segmentTime = last.time - segmentStartTime;
		segments.push({
			segmentNumber,
			duration: segmentTime,
			avgSpeed: segmentTime > 0 ? partialDistance / (segmentTime / 1000) : 0,
			partial: true,
			distance: partialDistance,
		});
	}

	return segments;
}

async function openPostSession(sessionId, sessionData = null, mode = "push") {
	const session = sessionData || (await getSessionById(sessionId));
	if (!session) return;

	state.currentPostSession = session;
	renderPostSummary(session);
	showScreen("post");
	if (mode === "replace") {
		history.replaceState({ screen: "post", sessionId: session.id }, "");
	} else if (mode === "push") {
		history.pushState({ screen: "post", sessionId: session.id }, "");
	}
	initPostMap(session);
	renderElevationChart(session);
}

function renderPostSummary(session) {
	const unit = state.prefs.unit;
	const date = new Date(session.date);

	el.postDate.textContent = Number.isNaN(date.getTime())
		? "Unknown date"
		: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
	el.postTitle.textContent = sessionTimeTitle(session, date);

	el.postDistance.textContent = formatDistance(session.totalDistance || 0, unit);
	el.postDistanceUnit.textContent = distanceUnitLabel(unit);
	el.postAvgSpeed.textContent = formatSpeed(rideAvgSpeed(session), unit);
	el.postTime.textContent = formatDuration(session.movingTime || 0);
	el.postMaxSpeed.textContent = formatSpeed(session.maxSpeed || 0, unit);
	el.postSpeedUnit.textContent = speedUnitLabel(unit);

	const elevationUnit = unit === "imperial" ? "ft" : "m";
	el.postGain.textContent = formatElevationValue(session.elevationGain || 0, unit);
	el.postDrop.textContent = formatElevationValue(session.elevationDrop || 0, unit);
	el.postGainUnit.textContent = elevationUnit;
	el.postDropUnit.textContent = elevationUnit;

	el.chartStartLabel.textContent = `0 ${distanceUnitLabel(unit)}`;
	el.chartEndLabel.textContent = `${formatDistance(session.totalDistance || 0, unit)} ${distanceUnitLabel(unit)}`;

	renderSegmentRows(recalculateSegments(session));
}

// Bar length is the segment's speed against the fastest one; its colour places
// it between the ride's slowest and fastest segments.
function renderSegmentRows(segments) {
	const unit = state.prefs.unit;
	el.segmentsSpeedHeader.textContent = speedUnitLabel(unit);
	el.segmentsBody.innerHTML = "";

	const speeds = segments.map((seg) => seg.avgSpeed);
	const fastest = Math.max(...speeds, 0.0001);
	const slowest = Math.min(...speeds);

	for (const seg of segments) {
		const tr = document.createElement("tr");

		const name = document.createElement("td");
		name.className = seg.partial ? "seg-name partial" : "seg-name";
		name.textContent = seg.partial
			? `${formatDistance(seg.distance, unit)} ${distanceUnitLabel(unit)}`
			: segmentLabel(seg.segmentNumber, unit);

		const pace = document.createElement("td");
		const track = document.createElement("div");
		track.className = "pace-track";
		const fill = document.createElement("div");
		fill.className = "pace-fill";
		fill.style.width = `${Math.max(2, (seg.avgSpeed / fastest) * 100).toFixed(1)}%`;
		fill.style.background = paceColor(fastest - slowest > 0.01 ? (seg.avgSpeed - slowest) / (fastest - slowest) : 1);
		track.appendChild(fill);
		pace.appendChild(track);

		const time = document.createElement("td");
		time.className = "num seg-time";
		time.textContent = formatDuration(seg.duration);

		const speed = document.createElement("td");
		speed.className = "num seg-speed";
		speed.textContent = formatSpeed(seg.avgSpeed, unit);

		tr.append(name, pace, time, speed);
		el.segmentsBody.appendChild(tr);
	}
}

function renderElevationChart(session) {
	const canvas = el.elevationChart;
	if (!canvas) return;

	// Clear any existing highlight when rendering new chart
	clearChartHighlight();

	const points = buildChartPoints(session);
	if (!points.length) {
		drawEmptyChart(canvas, "No elevation data available");
		return;
	}

	// Cache points for interaction handling
	state.chartPointsCache = points;
	state.highlightedPointIndex = -1;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	const width = Math.max(1, Math.floor(rect.width * dpr));
	const height = Math.max(1, Math.floor(rect.height * dpr));

	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.scale(dpr, dpr);

	const cssWidth = rect.width;
	const cssHeight = rect.height;
	// Full bleed: the elevation labels sit on the grid lines and the distance
	// labels are HTML under the canvas.
	const padding = { top: 4, right: 0, bottom: 4, left: 0 };
	const chartWidth = cssWidth - padding.left - padding.right;
	const chartHeight = cssHeight - padding.top - padding.bottom;
	const displayUnit = state.prefs.unit;
	const totalDistance = Math.max(points[points.length - 1].distance, 1);

	const minElevation = minOf(points, (point) => point.elevation);
	const maxElevation = maxOf(points, (point) => point.elevation);
	const maxSpeed = Math.max(maxOf(points, (point) => point.speed), 0.0001);

	const xFor = (distance) => padding.left + (distance / totalDistance) * chartWidth;
	const yFor = (elevation) => {
		if (maxElevation === minElevation) return padding.top + chartHeight / 2;
		return padding.top + chartHeight - ((elevation - minElevation) / (maxElevation - minElevation)) * chartHeight;
	};

	drawChartBackground(ctx, cssWidth, cssHeight, padding);

	// A soft fill under the line, fading to nothing at the floor.
	const floor = cssHeight - padding.bottom;
	const fill = ctx.createLinearGradient(0, padding.top, 0, floor);
	fill.addColorStop(0, "rgba(143, 201, 58, 0.22)");
	fill.addColorStop(1, "rgba(143, 201, 58, 0)");
	ctx.beginPath();
	ctx.moveTo(xFor(points[0].distance), floor);
	for (const point of points) ctx.lineTo(xFor(point.distance), yFor(point.elevation));
	ctx.lineTo(xFor(points[points.length - 1].distance), floor);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();

	ctx.lineWidth = 2.5;
	ctx.lineCap = "round";
	// Batched paths have joins where per-segment paths had none, and the canvas
	// default of "miter" throws long spikes wherever noisy elevation data doubles
	// back on itself. Round joins match how the per-segment version looked.
	ctx.lineJoin = "round";

	// Stroke one path per contiguous run of the same speed band instead of one
	// path per point pair.
	let currentBand = -1;
	for (let index = 1; index < points.length; index += 1) {
		const previous = points[index - 1];
		const current = points[index];
		const midSpeed = (previous.speed + current.speed) / 2;
		const band = speedBand(midSpeed, maxSpeed);

		if (band !== currentBand) {
			if (currentBand !== -1) ctx.stroke();
			ctx.beginPath();
			ctx.strokeStyle = speedBandColor(band);
			ctx.moveTo(xFor(previous.distance), yFor(previous.elevation));
			currentBand = band;
		}

		ctx.lineTo(xFor(current.distance), yFor(current.elevation));
	}
	if (currentBand !== -1) ctx.stroke();

	drawElevationLabels(ctx, cssHeight, padding, minElevation, maxElevation, displayUnit);

	// Add event listeners for chart interaction
	setupChartInteraction(canvas, session, points, padding, cssWidth, cssHeight, minElevation, maxElevation, totalDistance, xFor, yFor);
}

function setupChartInteraction(canvas, session, points, padding, cssWidth, cssHeight, minElevation, maxElevation, totalDistance, xFor, yFor) {
	// Remove old listeners if any
	canvas.removeEventListener("mousemove", handleChartMouseMove);
	canvas.removeEventListener("mouseleave", handleChartMouseLeave);
	canvas.removeEventListener("mousedown", handleChartMouseDown);
	canvas.removeEventListener("mouseup", handleChartMouseUp);
	canvas.removeEventListener("touchstart", handleChartTouchStart);
	canvas.removeEventListener("touchmove", handleChartTouchMove);
	canvas.removeEventListener("touchend", handleChartTouchEnd);

	// Store context for event handlers
	canvas.chartContext = { session, points, padding, cssWidth, cssHeight, minElevation, maxElevation, totalDistance };

	canvas.addEventListener("mousemove", handleChartMouseMove);
	canvas.addEventListener("mouseleave", handleChartMouseLeave);
	canvas.addEventListener("mousedown", handleChartMouseDown);
	canvas.addEventListener("mouseup", handleChartMouseUp);
	canvas.addEventListener("touchstart", handleChartTouchStart);
	canvas.addEventListener("touchmove", handleChartTouchMove);
	canvas.addEventListener("touchend", handleChartTouchEnd);
}

function handleChartMouseDown(event) {
	state.isChartDragging = true;
	updateChartHighlight(event, this);
}

function handleChartMouseMove(event) {
	if (!state.isChartDragging && event.buttons === 0) return;
	updateChartHighlight(event, this);
}

function handleChartMouseUp() {
	state.isChartDragging = false;
}

function handleChartMouseLeave() {
	if (!state.isChartDragging) {
		clearChartHighlight();
	}
}

function handleChartTouchStart(event) {
	state.isChartDragging = true;
	updateChartHighlight(event.touches[0], this);
}

function handleChartTouchMove(event) {
	if (!state.isChartDragging) return;
	updateChartHighlight(event.touches[0], this);
}

function handleChartTouchEnd() {
	state.isChartDragging = false;
	clearChartHighlight();
}

function updateChartHighlight(event, canvas) {
	const context = canvas?.chartContext;
	if (!context || !state.postMap) return;

	const rect = canvas.getBoundingClientRect();
	const x = event.clientX - rect.left;

	// Calculate which point in the chart
	const padding = context.padding;
	const chartWidth = context.cssWidth - padding.left - padding.right;
	const totalDistance = context.totalDistance;
	const points = context.points;

	if (x < padding.left || x > context.cssWidth - padding.right) {
		clearChartHighlight();
		return;
	}

	// Map X position to distance
	const relativeX = x - padding.left;
	const distanceRatio = relativeX / chartWidth;
	const targetDistance = distanceRatio * totalDistance;

	// Find the closest point with distance <= targetDistance
	let closestIndex = 0;
	let closestDelta = Math.abs(points[0].distance - targetDistance);

	for (let i = 1; i < points.length; i++) {
		const delta = Math.abs(points[i].distance - targetDistance);
		if (delta < closestDelta) {
			closestDelta = delta;
			closestIndex = i;
		}
	}

	if (closestIndex !== state.highlightedPointIndex) {
		state.highlightedPointIndex = closestIndex;
		highlightPointOnMap(context.session, closestIndex);
	}
}

function highlightPointOnMap(session, pointIndex) {
	if (!state.postMap || !session.points || !session.points[pointIndex]) return;

	const point = session.points[pointIndex];

	// One marker, moved as the finger slides along the chart.
	if (!state.chartHighlightMarker) {
		const element = document.createElement("div");
		element.className = "chart-highlight-marker";
		state.chartHighlightMarker = new maplibregl.Marker({ element }).setLngLat([point.lng, point.lat]).addTo(state.postMap);
	} else {
		state.chartHighlightMarker.setLngLat([point.lng, point.lat]);
	}
}

function clearChartHighlight() {
	if (state.chartHighlightMarker) {
		state.chartHighlightMarker.remove();
		state.chartHighlightMarker = null;
	}
	state.highlightedPointIndex = -1;
}

function buildChartPoints(session) {
	const points = session.points || [];
	if (!points.length) return [];

	let distance = 0;
	const chartPoints = [];
	let previousPoint = null;

	for (const point of points) {
		if (previousPoint) {
			distance += haversineMeters(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
		}

		const elevation = Number.isFinite(point.altitude)
			? point.altitude
			: chartPoints.length
				? chartPoints[chartPoints.length - 1].elevation
				: 0;

		chartPoints.push({
			distance,
			elevation,
			speed: Number.isFinite(point.speed) ? point.speed : 0,
		});

		previousPoint = point;
	}

	return chartPoints;
}

function drawEmptyChart(canvas, message) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.floor(rect.width * dpr));
	canvas.height = Math.max(1, Math.floor(rect.height * dpr));
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.scale(dpr, dpr);
	ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted") || "#666";
	ctx.font = "14px sans-serif";
	ctx.textAlign = "center";
	ctx.fillText(message, rect.width / 2, rect.height / 2);
}

function themeColor(name, fallback) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Hairlines at the top and floor, fainter ones at the thirds.
function drawChartBackground(ctx, width, height, padding) {
	const rule = themeColor("--rule", "rgba(20, 24, 26, 0.1)");
	const hairline = themeColor("--hairline", "rgba(20, 24, 26, 0.07)");
	const top = padding.top;
	const span = height - padding.top - padding.bottom;

	ctx.save();
	ctx.lineWidth = 1;
	for (const [fraction, color] of [
		[0, rule],
		[1 / 3, hairline],
		[2 / 3, hairline],
		[1, rule],
	]) {
		// Half-pixel offset keeps a 1px line crisp.
		const y = Math.round(top + fraction * span) + 0.5;
		ctx.strokeStyle = color;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}
	ctx.restore();
}

// Highest and lowest elevation, sat on the top and floor lines over a patch of
// page background so the route line does not run through them.
function drawElevationLabels(ctx, height, padding, minElevation, maxElevation, unit) {
	const background = themeColor("--bg", "#fcfcfa");
	const muted = themeColor("--muted", "#6b7472");

	ctx.save();
	ctx.font = `600 10px ${themeColor("--font", "sans-serif")}`;
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	for (const [text, y] of [
		[formatElevation(maxElevation, unit), padding.top],
		[formatElevation(minElevation, unit), height - padding.bottom],
	]) {
		const width = ctx.measureText(text).width + 6;
		ctx.fillStyle = background;
		ctx.fillRect(0, y - 7, width, 14);
		ctx.fillStyle = muted;
		ctx.fillText(text, 0, y);
	}
	ctx.restore();
}

// t runs 0 (slow) to 1 (fast) along PACE_STOPS, blended between neighbours.
function paceColor(t) {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
	const scaled = clamped * (PACE_STOPS.length - 1);
	const index = Math.min(PACE_STOPS.length - 2, Math.floor(scaled));
	const mix = scaled - index;
	const from = hexToRgb(PACE_STOPS[index]);
	const to = hexToRgb(PACE_STOPS[index + 1]);
	const channel = (a, b) => Math.round(a + (b - a) * mix);
	// Comma syntax: MapLibre's colour parser does not take the space-separated form.
	return `rgb(${channel(from[0], to[0])}, ${channel(from[1], to[1])}, ${channel(from[2], to[2])})`;
}

function hexToRgb(hex) {
	const value = parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function speedBand(speed, maxSpeed) {
	const clamped = Math.max(0, Math.min(1, speed / maxSpeed));
	return Math.min(SPEED_BANDS - 1, Math.floor(clamped * SPEED_BANDS));
}

function speedBandColor(band) {
	// Sample the ramp mid-band so the bands stay evenly spaced across it.
	return paceColor((band + 0.5) / SPEED_BANDS);
}

function maxOf(items, pick) {
	// Spreading a long ride's points into Math.max risks a call-stack overflow.
	let max = -Infinity;
	for (const item of items) {
		const value = pick(item);
		if (value > max) max = value;
	}
	return max;
}

function minOf(items, pick) {
	let min = Infinity;
	for (const item of items) {
		const value = pick(item);
		if (value < min) min = value;
	}
	return min;
}

async function deleteCurrentRide() {
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
async function deleteAllRides() {
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

function showMessage(title, message) {
	return showModal({
		title,
		message,
		confirmText: "OK",
		hideCancel: true,
	}).then(() => undefined);
}

function confirmWithModal({ title, message, confirmText, cancelText, timeoutMs, timeoutLabel, danger }) {
	return showModal({
		title,
		message,
		confirmText,
		cancelText,
		timeoutMs,
		timeoutLabel,
		danger,
	}).then((result) => result === "confirm");
}

function showModal({
	title,
	message,
	confirmText = "OK",
	cancelText = "Cancel",
	hideCancel = false,
	hideConfirm = false,
	// Colours the confirm button red, for actions that destroy data.
	danger = false,
	// Buttons to pick from. Choosing one closes the modal, settling it with the
	// item's index as a string, and then runs the item's own click handler.
	listItems = [],
	timeoutMs,
	timeoutLabel = "Auto cancel",
}) {
	// Settle any modal this one supersedes instead of dropping its resolver on the
	// floor - an unsettled promise left callers (the nav guard) awaiting forever.
	closeModal("cancel");

	el.modalTitle.textContent = title;
	el.modalMessage.textContent = message;
	el.modalConfirmBtn.textContent = confirmText;
	el.modalCancelBtn.textContent = cancelText;
	el.modalCancelBtn.classList.toggle("hidden", hideCancel);
	el.modalConfirmBtn.classList.toggle("hidden", hideConfirm);
	el.modalConfirmBtn.classList.toggle("danger", danger);

	el.modalList.innerHTML = "";
	el.modalList.classList.toggle("hidden", !listItems.length);
	listItems.forEach((item, index) => {
		item.addEventListener("click", () => closeModal(String(index)));
		const li = document.createElement("li");
		li.appendChild(item);
		el.modalList.appendChild(li);
	});
	el.modalCountdown.classList.add("hidden");
	el.modalBackdrop.classList.remove("hidden");
	el.modalBackdrop.setAttribute("aria-hidden", "false");

	return new Promise((resolve) => {
		state.modalResolver = resolve;

		if (timeoutMs) {
			const endAt = Date.now() + timeoutMs;
			const tick = () => {
				const seconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
				el.modalCountdown.textContent = `${timeoutLabel} in ${seconds}s`;
				el.modalCountdown.classList.remove("hidden");
				if (seconds === 0) return;
				state.modalCountdownTimer = setTimeout(tick, 250);
			};

			tick();
			state.modalTimer = setTimeout(() => closeModal("timeout"), timeoutMs);
		}
	});
}

function closeModal(result = "cancel") {
	if (state.modalTimer) {
		clearTimeout(state.modalTimer);
		state.modalTimer = null;
	}
	if (state.modalCountdownTimer) {
		clearTimeout(state.modalCountdownTimer);
		state.modalCountdownTimer = null;
	}

	el.modalBackdrop.classList.add("hidden");
	el.modalBackdrop.setAttribute("aria-hidden", "true");
	el.modalCountdown.classList.add("hidden");

	// Clear the resolver before settling so a continuation that opens another modal
	// cannot see this one still pending.
	const resolver = state.modalResolver;
	state.modalResolver = null;
	if (resolver) resolver(result);
}

function exportCurrentGpx() {
	const session = state.currentPostSession;
	if (!session || !session.points?.length) return;

	const gpx = buildGpx(session);
	const blob = new Blob([gpx], { type: "application/gpx+xml" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");

	a.href = url;
	a.download = `bike-ride-${new Date(session.date).toISOString().replace(/[:.]/g, "-")}.gpx`;
	a.click();

	URL.revokeObjectURL(url);
}

function buildGpx(session) {
	const trkpts = session.points
		.map((p) => {
			const ele = Number.isFinite(p.altitude) ? `<ele>${p.altitude.toFixed(1)}</ele>` : "";
			return `<trkpt lat="${p.lat}" lon="${p.lng}">${ele}<time>${new Date(p.timestamp).toISOString()}</time></trkpt>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Tracker" xmlns="http://www.topografix.com/GPX/1/1">
	<trk>
		<name>Bike Ride ${new Date(session.date).toLocaleString()}</name>
		<trkseg>
			${trkpts}
		</trkseg>
	</trk>
</gpx>`;
}

function maybeShowInstallBanner() {
	if (state.prefs.installDismissed) {
		el.installBanner.classList.add("hidden");
		return;
	}

	el.installBanner.classList.remove("hidden");
	if (state.deferredInstallPrompt) {
		el.installMessage.textContent = "Add Bike Tracker to your home screen for quick, full-screen access.";
		el.installBtn.disabled = false;
	} else {
		el.installMessage.textContent = "Install is available from your browser menu if the button is disabled.";
		el.installBtn.disabled = true;
	}
}

async function requestWakeLock() {
	if (!("wakeLock" in navigator)) return;
	// Single gate for every caller: the ride's own preference decides, so resuming
	// from pause or returning to the foreground can never re-arm a lock the user declined.
	if (!state.currentSession?.keepScreenOn) return;
	try {
		if (state.wakeLockSentinel && !state.wakeLockSentinel.released) return;
		state.wakeLockSentinel = await navigator.wakeLock.request("screen");
		state.wakeLockSentinel.addEventListener("release", () => {
			state.wakeLockSentinel = null;
			if (state.currentSession?.paused === false && !document.hidden) {
				requestWakeLock();
			}
		});
	} catch (error) {
		console.warn("Wake lock unavailable", error);
	}
}

async function releaseWakeLock() {
	try {
		if (state.wakeLockSentinel && !state.wakeLockSentinel.released) {
			await state.wakeLockSentinel.release();
			state.wakeLockSentinel = null;
		}
	} catch {
		// Ignore release failures.
	}
}

function registerServiceWorker() {
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker
			.register("sw.js", { updateViaCache: "none" })
			.then((registration) => {
				state.swRegistration = registration;
				setupServiceWorkerUpdateChecks(registration);
			})
			.catch((error) => {
				console.warn("Service worker registration failed", error);
			});
	}
}

function setupServiceWorkerUpdateChecks(registration) {
	const promptRefresh = async (message) => {
		// Never interrupt a ride in progress: reloading would drop the live session.
		if (state.currentSession) return;
		if (state.swUpdatePromptOpen) return;
		state.swUpdatePromptOpen = true;
		const shouldUpdate = await confirmWithModal({
			title: "Update Ready",
			message,
			confirmText: "Reload",
			cancelText: "Later",
		});
		state.swUpdatePromptOpen = false;

		if (!shouldUpdate) return;

		if (registration.waiting) {
			registration.waiting.postMessage({ type: "SKIP_WAITING" });
			return;
		}

		window.location.reload();
	};

	const maybePrompt = async () => {
		if (!registration.waiting) return;
		await promptRefresh("A new version of Bike Tracker is available. Reload now to apply updates?");
	};

	if (registration.waiting) {
		maybePrompt();
	}

	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "APP_SHELL_UPDATE_AVAILABLE") {
			promptRefresh("Newer app files were found on the server. Reload now to get the latest version?");
		}
	});

	registration.addEventListener("updatefound", () => {
		const installingWorker = registration.installing;
		if (!installingWorker) return;

		installingWorker.addEventListener("statechange", () => {
			if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
				maybePrompt();
			}
		});
	});

	let hasRefreshed = false;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (hasRefreshed) return;
		// A mid-ride reload here would discard the active session; the new worker
		// simply takes effect on the next natural load instead.
		if (state.currentSession) return;
		hasRefreshed = true;
		window.location.reload();
	});

	const triggerUpdateCheck = () => {
		if (state.currentSession) return;
		registration.update().catch((error) => {
			console.warn("Service worker update check failed", error);
		});
	};

	triggerUpdateCheck();
	setInterval(triggerUpdateCheck, 5 * 60 * 1000);
	window.addEventListener("focus", triggerUpdateCheck);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") triggerUpdateCheck();
	});
}

function getCurrentPosition(timeoutMs) {
	return new Promise((resolve, reject) => {
		navigator.geolocation.getCurrentPosition(resolve, reject, {
			enableHighAccuracy: true,
			timeout: timeoutMs,
			maximumAge: 0,
		});
	});
}

function getSegmentLengthMeters(unit) {
	return unit === "imperial" ? METERS_PER_MILE : METERS_PER_KM;
}

function distanceUnitLabel(unit) {
	return unit === "imperial" ? "mi" : "km";
}

function speedUnitLabel(unit) {
	return unit === "imperial" ? "mph" : "km/h";
}

function segmentLabel(number, unit) {
	return unit === "imperial" ? `Mile ${number}` : `Km ${number}`;
}

function segmentDistanceLabel(number, unit) {
	return unit === "imperial" ? `${number} mi` : `${number} km`;
}

// MapLibre markers anchor on their element's centre, so the flag sits centred
// on the point where the segment ended.
function createSegmentMarkerElement(label, markerSizeValue = state.prefs.markerSize) {
	const markerSize = getMarkerSizeConfig(markerSizeValue);
	const wrapper = document.createElement("div");
	wrapper.className = "segment-flag-wrapper";
	wrapper.style.width = `${markerSize.iconSize[0]}px`;
	wrapper.style.height = `${markerSize.iconSize[1]}px`;
	wrapper.innerHTML = `<div class="segment-flag-marker ${markerSize.className}"><span>${escapeHtml(label)}</span></div>`;
	return wrapper;
}

function getMarkerSizeConfig(size) {
	if (size === "small") {
		return {
			className: "small",
			iconSize: [56, 28],
		};
	}

	if (size === "large") {
		return {
			className: "large",
			iconSize: [88, 40],
		};
	}

	return {
		className: "medium",
		iconSize: [72, 34],
	};
}

function getGuideLineStyle(contrast) {
	if (contrast === "low") {
		return {
			lineColor: "#ffffff",
			lineWeight: 2,
			lineOpacity: 0.85,
			haloColor: "#1f2d23",
			haloWeight: 5,
			haloOpacity: 0.55,
			dashArray: "8 10",
		};
	}

	if (contrast === "medium") {
		return {
			lineColor: "#fff48a",
			lineWeight: 3,
			lineOpacity: 0.95,
			haloColor: "#16231a",
			haloWeight: 6,
			haloOpacity: 0.72,
			dashArray: "9 11",
		};
	}

	return {
		lineColor: "#f6ff61",
		lineWeight: 3,
		lineOpacity: 1,
		haloColor: "#132017",
		haloWeight: 7,
		haloOpacity: 0.85,
		dashArray: "10 12",
	};
}

function addSegmentMarkerToLayer(layer, lat, lng, label, markerSizeValue = state.prefs.markerSize) {
	layer.add(lat, lng, createSegmentMarkerElement(label, markerSizeValue));
}

function renderSegmentMarkers(layer, markers, markerSizeValue = state.prefs.markerSize) {
	for (const marker of markers) {
		// Support both old format (with label) and new format (with segmentNumber)
		let label;
		if (marker.label) {
			// Old format - use stored label for backward compatibility
			label = marker.label;
		} else if (marker.segmentNumber) {
			// New format - compute label on-the-fly based on current units
			label = segmentDistanceLabel(marker.segmentNumber, state.prefs.unit);
		} else {
			// Fallback - try to infer segment number from array position
			const segmentNumber = markers.indexOf(marker) + 1;
			label = segmentDistanceLabel(segmentNumber, state.prefs.unit);
		}
		addSegmentMarkerToLayer(layer, marker.lat, marker.lng, label, markerSizeValue);
	}
}

function applyMapVisualPrefs(preview = null) {
	const guideContrast = preview?.guideContrast ?? state.prefs.guideContrast;
	const markerSize = preview?.markerSize ?? state.prefs.markerSize;
	applyLiveGuideStyle(getGuideLineStyle(guideContrast));

	if (state.guideLabelMarker) {
		styleGuideLabel(state.guideLabelMarker.getElement(), guideContrast, markerSize);
		// Re-rendered for the text too, which follows the units.
		updateGuideLabel();
	}

	if (state.markerLayer) {
		state.markerLayer.clearLayers();
		renderSegmentMarkers(state.markerLayer, state.currentSession?.segmentMarkers || [], markerSize);
	}

	if (state.postMarkerLayer) {
		state.postMarkerLayer.clearLayers();
		if (state.currentPostSession) {
			const segmentMarkers = recalculateSegmentMarkers(state.currentPostSession);
			renderSegmentMarkers(state.postMarkerLayer, segmentMarkers, markerSize);
		}
	}
}

function previewSettingsMapVisuals() {
	if (state.currentScreen !== "settings") return;
	applyMapVisualPrefs({
		guideContrast: el.guideContrastSelect.value,
		markerSize: el.markerSizeSelect.value,
	});
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function formatDistance(meters, unit) {
	if (unit === "imperial") return `${(meters / METERS_PER_MILE).toFixed(2)}`;
	return `${(meters / METERS_PER_KM).toFixed(2)}`;
}

function formatSpeed(mps, unit) {
	if (unit === "imperial") return `${(mps * MPS_TO_MPH).toFixed(1)}`;
	return `${(mps * MPS_TO_KPH).toFixed(1)}`;
}

function formatElevationValue(meters, unit) {
	return (unit === "imperial" ? meters * FEET_PER_METER : meters).toFixed(0);
}

function formatElevation(meters, unit) {
	return `${formatElevationValue(meters, unit)} ${unit === "imperial" ? "ft" : "m"}`;
}

// Ride length rounded to the nearest minute, for the at-a-glance list. The
// summary screen and the segment table still carry seconds, where they matter.
function formatDurationMinutes(ms) {
	const totalMinutes = Math.round((ms || 0) / 60000);
	if (totalMinutes < 1) return "<1m";

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (!hours) return `${minutes}m`;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) {
		return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	}
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
	const toRad = (v) => (v * Math.PI) / 180;
	const R = 6371000;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
	const toRad = (v) => (v * Math.PI) / 180;
	const toDeg = (v) => (v * 180) / Math.PI;

	const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
	const x =
		Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
		Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));

	return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

async function exportAllData() {
	try {
		const sessions = await getAllSessions();
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

async function importAllData(event) {
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
			message: `This will import ${data.sessions.length} session(s) and overwrite your preferences. Continue?`,
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

// One connection is shared by every store operation. Opening a fresh one per call
// leaked a live IDBDatabase each time and would block any future version upgrade.
function openDB() {
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

async function withStore(storeName, mode, fn) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, mode);
		const store = tx.objectStore(storeName);
		const result = fn(store);

		tx.oncomplete = () => resolve(result?.result ?? result);
		tx.onerror = () => reject(tx.error);
	});
}

async function setPref(key, value) {
	await withStore(PREF_STORE, "readwrite", (store) => store.put({ key, value }));
}

async function getPref(key, fallback) {
	const result = await withStore(PREF_STORE, "readonly", (store) => store.get(key));
	return result?.value ?? fallback;
}

async function loadPrefs() {
	state.prefs.unit = await getPref("unit", "imperial");
	state.prefs.theme = await getPref("theme", "light");
	state.prefs.stadiaKey = await getPref("stadiaKey", "");
	state.prefs.mapType = await getPref("mapType", "road");
	// Checked because an imported backup could carry anything, and a bad zoom
	// would leave the live map unable to draw.
	const liveMapZoom = await getPref("liveMapZoom", LIVE_MAP_ZOOM);
	state.prefs.liveMapZoom = Number.isFinite(liveMapZoom) ? liveMapZoom : LIVE_MAP_ZOOM;
	state.prefs.comparePastRides = (await getPref("comparePastRides", true)) !== false;
	state.prefs.rideStatsSide = (await getPref("rideStatsSide", "left")) === "right" ? "right" : "left";
	state.prefs.guideContrast = await getPref("guideContrast", "high");
	state.prefs.markerSize = await getPref("markerSize", "medium");
	state.prefs.ridesView = await getPref("ridesView", "list");
	const statsActivity = await getPref("statsActivity", "all");
	state.prefs.statsActivity = statsActivity === "all" || ACTIVITIES[statsActivity] ? statsActivity : "all";
	const calendarColor = await getPref("calendarColor", "distance");
	state.prefs.calendarColor = CALENDAR_COLOR_NOTES[calendarColor] ? calendarColor : "distance";
	state.prefs.installDismissed = await getPref("installDismissed", false);
}

async function addSession(session) {
	const req = await withStore(SESSION_STORE, "readwrite", (store) => store.add(session));
	return req;
}

async function getAllSessions() {
	const req = await withStore(SESSION_STORE, "readonly", (store) => store.getAll());
	return req || [];
}

async function getSessionById(id) {
	return withStore(SESSION_STORE, "readonly", (store) => store.get(id));
}

async function deleteSessionById(id) {
	await withStore(SESSION_STORE, "readwrite", (store) => store.delete(id));
}

async function clearAllSessions() {
	await withStore(SESSION_STORE, "readwrite", (store) => store.clear());
}
