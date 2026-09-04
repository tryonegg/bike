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

const ACTIVITIES = {
	bike: { label: "Bike", icon: "🚴" },
	walk: { label: "Walk", icon: "🚶" },
	hike: { label: "Hike", icon: "🥾" },
	kayak: { label: "Kayak", icon: "🛶" },
};

const state = {
	prefs: {
		unit: "imperial",
		theme: "light",
		stadiaKey: "",
		guideContrast: "high",
		markerSize: "medium",
		ridesView: "list",
		installDismissed: false,
	},
	// Which month the calendar view is paged to, as the 1st at local midnight.
	// Null until the first calendar render picks a starting month from the rides.
	calendarMonth: null,
	deferredInstallPrompt: null,
	liveMap: null,
	liveTileLayer: null,
	routeLine: null,
	guideLineHalo: null,
	guideLine: null,
	markerLayer: null,
	postMap: null,
	postTileLayer: null,
	postMarkerLayer: null,
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
	// closeSettingsBtn: document.getElementById("closeSettingsBtn"),
	saveSettingsBtn: document.getElementById("saveSettingsBtn"),
	stadiaKeyInput: document.getElementById("stadiaKeyInput"),
	guideContrastSelect: document.getElementById("guideContrastSelect"),
	markerSizeSelect: document.getElementById("markerSizeSelect"),
	exportDataBtn: document.getElementById("exportDataBtn"),
	importDataBtn: document.getElementById("importDataBtn"),
	importFileInput: document.getElementById("importFileInput"),
	keepScreenOnToggle: document.getElementById("keepScreenOnToggle"),
	cancelActivityBtn: document.getElementById("cancelActivityBtn"),
	startActivityBtn: document.getElementById("startActivityBtn"),
	countdownNumber: document.getElementById("countdownNumber"),
	countdownStatus: document.getElementById("countdownStatus"),
	retryCountdownBtn: document.getElementById("retryCountdownBtn"),
	cancelCountdownBtn: document.getElementById("cancelCountdownBtn"),
	currentSpeed: document.getElementById("currentSpeed"),
	distanceValue: document.getElementById("distanceValue"),
	avgSpeed: document.getElementById("avgSpeed"),
	elapsedTime: document.getElementById("elapsedTime"),
	pauseBtn: document.getElementById("pauseBtn"),
	stopBtn: document.getElementById("stopBtn"),
	recenterBtn: document.getElementById("recenterBtn"),
	postTitle: document.getElementById("postTitle"),
	postDistance: document.getElementById("postDistance"),
	postTime: document.getElementById("postTime"),
	postMaxSpeed: document.getElementById("postMaxSpeed"),
	postAvgSpeed: document.getElementById("postAvgSpeed"),
	postElevation: document.getElementById("postElevation"),
	elevationChart: document.getElementById("elevationChart"),
	segmentsBody: document.getElementById("segmentsBody"),
	exportGpxBtn: document.getElementById("exportGpxBtn"),
	deleteRideBtn: document.getElementById("deleteRideBtn"),
	backHomeBtn: document.getElementById("backHomeBtn"),
	modalBackdrop: document.getElementById("modalBackdrop"),
	modalTitle: document.getElementById("modalTitle"),
	modalMessage: document.getElementById("modalMessage"),
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
		rebuildMapTiles();
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

	el.openSettingsBtn.addEventListener("click", () => {
		el.stadiaKeyInput.value = state.prefs.stadiaKey;
		el.guideContrastSelect.value = state.prefs.guideContrast;
		el.markerSizeSelect.value = state.prefs.markerSize;
		navigateToScreen("settings");
	});

	el.guideContrastSelect.addEventListener("change", previewSettingsMapVisuals);
	el.markerSizeSelect.addEventListener("change", previewSettingsMapVisuals);

	el.saveSettingsBtn.addEventListener("click", async () => {
		state.prefs.stadiaKey = el.stadiaKeyInput.value.trim();
		state.prefs.guideContrast = el.guideContrastSelect.value;
		state.prefs.markerSize = el.markerSizeSelect.value;
		await setPref("stadiaKey", state.prefs.stadiaKey);
		await setPref("guideContrast", state.prefs.guideContrast);
		await setPref("markerSize", state.prefs.markerSize);
		navigateToScreen("home");
		rebuildMapTiles();
		applyMapVisualPrefs();
	});

	el.pauseBtn.addEventListener("click", togglePauseSession);
	el.stopBtn.addEventListener("click", endSessionWithConfirm);
	el.recenterBtn.addEventListener("click", recenterLiveMap);

	el.exportGpxBtn.addEventListener("click", exportCurrentGpx);
	el.deleteRideBtn.addEventListener("click", deleteCurrentRide);
	el.backHomeBtn.addEventListener("click", async () => {
		clearChartHighlight();
		state.currentPostSession = null;
		navigateToScreen("home");
		await renderPastRides();
	});

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

	window.addEventListener("resize", () => {
		if (state.liveMap) {
			sizeLiveMapForRotation();
			state.liveMap.invalidateSize();
		}
		if (state.postMap) state.postMap.invalidateSize();
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

	const viewButtons = el.ridesViewToggle.querySelectorAll("button");
	viewButtons.forEach((btn) => {
		const on = btn.dataset.ridesView === state.prefs.ridesView;
		btn.classList.toggle("active", on);
		btn.setAttribute("aria-pressed", String(on));
	});
}

function applyTheme() {
	document.documentElement.classList.toggle("dark", state.prefs.theme === "dark");
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
			el.stadiaKeyInput.value = state.prefs.stadiaKey;
			el.guideContrastSelect.value = state.prefs.guideContrast;
			el.markerSizeSelect.value = state.prefs.markerSize;
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

function renderRidesList(sessions) {
	el.sessionsList.innerHTML = "";

	// Sorted newest first, so the year changes at most once per group and can be
	// hoisted into a heading instead of being repeated on every row.
	let currentYear;
	let yearList = null;

	for (const session of sessions) {
		const date = new Date(session.date);
		const year = Number.isNaN(date.getTime()) ? null : date.getFullYear();

		if (year !== currentYear) {
			currentYear = year;
			const group = document.createElement("li");
			group.className = "sessions-year";

			const heading = document.createElement("h3");
			heading.textContent = year == null ? "Undated" : String(year);

			yearList = document.createElement("ul");
			group.append(heading, yearList);
			el.sessionsList.appendChild(group);
		}

		yearList.appendChild(buildSessionRow(session, date));
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

	const byDay = new Map();
	for (const session of sessions) {
		const date = new Date(session.date);
		if (Number.isNaN(date.getTime())) continue;
		if (date.getFullYear() !== year || date.getMonth() !== monthIndex) continue;
		const key = dayKey(date);
		if (!byDay.has(key)) byDay.set(key, []);
		byDay.get(key).push(session);
	}

	// Blanks before the 1st, then the month, padded out to whole weeks.
	const leadingBlanks = (new Date(year, monthIndex, 1).getDay() - WEEK_START_DAY + 7) % 7;
	const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
	const weeks = Math.ceil((leadingBlanks + daysInMonth) / 7);
	const todayKey = dayKey(new Date());

	el.calBody.innerHTML = "";

	for (let week = 0; week < weeks; week += 1) {
		const tr = document.createElement("tr");

		for (let column = 0; column < 7; column += 1) {
			const dayNumber = week * 7 + column - leadingBlanks + 1;
			const td = document.createElement("td");

			if (dayNumber < 1 || dayNumber > daysInMonth) {
				td.className = "calendar-empty";
				tr.appendChild(td);
				continue;
			}

			const cellDate = new Date(year, monthIndex, dayNumber);
			const key = dayKey(cellDate);
			const rides = byDay.get(key) || [];

			td.className = "calendar-day";
			if (rides.length) td.classList.add("has-ride");
			if (key === todayKey) td.classList.add("is-today");

			const number = document.createElement("span");
			number.className = "calendar-day-number";
			number.textContent = String(dayNumber);
			td.appendChild(number);

			// Oldest first within a day, so the entries read in the order they happened.
			for (const session of [...rides].reverse()) {
				td.appendChild(buildCalendarRide(session, cellDate));
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

function buildCalendarRide(session, cellDate) {
	const unit = state.prefs.unit;
	const activityType = session.activityType || "bike";
	const activityIcon = ACTIVITIES[activityType]?.icon || "🚴";

	const durationText = formatDurationMinutes(session.movingTime || 0);
	const distanceText = `${formatDistance(session.totalDistance || 0, unit)} ${distanceUnitLabel(unit)}`;
	const speedText = `${formatSpeed(session.avgSpeed || 0, unit)} ${speedUnitLabel(unit)}`;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "calendar-ride";
	// The cell shows abbreviations in a very small type size, so spell the whole
	// entry out for anyone reading it aloud.
	button.setAttribute(
		"aria-label",
		`${ACTIVITIES[activityType]?.label || "Ride"} on ${cellDate.toLocaleDateString(undefined, { month: "long", day: "numeric" })}, ${durationText}, ${distanceText}, ${speedText} average`,
	);

	// The icon and the two stats are separate elements so the stylesheet can drop
	// the icon and stack the stats once a cell is too narrow to hold them inline.
	const icon = document.createElement("span");
	icon.className = "calendar-ride-icon";
	icon.textContent = activityIcon;
	icon.setAttribute("aria-hidden", "true");

	const duration = document.createElement("span");
	duration.className = "calendar-ride-time";
	duration.append(icon, document.createTextNode(durationText));

	const distance = document.createElement("span");
	distance.className = "calendar-ride-distance";
	distance.textContent = distanceText;

	const speed = document.createElement("span");
	speed.className = "calendar-ride-speed";
	speed.textContent = speedText;

	const stats = document.createElement("span");
	stats.className = "calendar-ride-stats";
	stats.append(distance, speed);

	button.append(duration, stats);
	button.addEventListener("click", () => openPostSession(session.id, null, "push"));
	return button;
}

function buildSessionRow(session, date) {
	const li = document.createElement("li");
	const button = document.createElement("button");
	button.className = "btn session-row";
	button.type = "button";

	const activityIcon = ACTIVITIES[session.activityType || "bike"]?.icon || "🚴";
	const dayPart = sessionDayPart(session, date);

	const when = document.createElement("span");
	when.className = "session-when";
	when.textContent = `${activityIcon} ${formatSessionDay(date)}${dayPart ? ` · ${dayPart}` : ""}`;

	const stats = document.createElement("span");
	stats.className = "session-stats";
	stats.textContent = [
		`${formatDistance(session.totalDistance || 0, state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)}`,
		formatDurationMinutes(session.movingTime || 0),
		`${formatSpeed(session.avgSpeed || 0, state.prefs.unit)} ${speedUnitLabel(state.prefs.unit)}`,
	].join(" • ");

	button.append(when, stats);
	button.addEventListener("click", () => openPostSession(session.id, null, "push"));
	li.appendChild(button);
	return li;
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

	if (state.routeLine) {
		state.routeLine.addLatLng([point.lat, point.lng]);
	}

	if ((state.guideLine || state.guideLineHalo) && state.currentSession?.points?.length) {
		const startPoint = state.currentSession.points[0];
		const line = [
			[startPoint.lat, startPoint.lng],
			[point.lat, point.lng],
		];
		if (state.guideLineHalo) state.guideLineHalo.setLatLngs(line);
		if (state.guideLine) state.guideLine.setLatLngs(line);
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
	rotateLiveMap(nextHeading);

	if (state.currentSession?.shouldRecenter) {
		state.liveMap.setView([point.lat, point.lng]);
	}
}

function rotateLiveMap(heading) {
	const mapElement = document.getElementById("liveMap");
	if (!mapElement) return;
	mapElement.style.transformOrigin = "50% 50%";
	mapElement.style.transform = `rotate(${-heading}deg)`;

	// The control container shares the map's centre, so an equal counter-rotation
	// leaves the zoom buttons and attribution upright and in place.
	const controls = mapElement.querySelector(".leaflet-control-container");
	if (controls) {
		controls.style.transform = `rotate(${heading}deg)`;
	}

	// Counter-rotate all segment markers to keep text upright
	const markers = document.querySelectorAll(".segment-flag-marker");
	markers.forEach((marker) => {
		marker.style.transform = `rotate(${heading}deg)`;
	});
}

function recenterLiveMap() {
	const session = state.currentSession;
	if (!session || !session.lastPoint || !state.liveMap) return;
	session.shouldRecenter = true;
	state.liveMap.setView([session.lastPoint.lat, session.lastPoint.lng], 16);
}

function updateLiveStats() {
	const session = state.currentSession;
	if (!session) return;

	const elapsed = getElapsedMs();
	const currentSpeed = session.lastPoint ? session.lastPoint.speed : 0;

	// Distance over moving time - the same definition the saved ride summary uses.
	// An unweighted mean of instantaneous fixes disagreed with the post-ride figure.
	session.avgSpeed = elapsed > 0 ? session.totalDistance / (elapsed / 1000) : 0;

	el.currentSpeed.innerHTML = formatSpeedMarkup(currentSpeed, state.prefs.unit);
	el.distanceValue.innerHTML = formatDistanceMarkup(session.totalDistance, state.prefs.unit);
	el.avgSpeed.innerHTML = formatSpeedMarkup(session.avgSpeed, state.prefs.unit);
	el.elapsedTime.textContent = formatDuration(elapsed);
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
		el.pauseBtn.textContent = "Resume";
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
	el.pauseBtn.textContent = "Pause";
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
	el.pauseBtn.textContent = "Pause";
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

	if (state.routeLine) {
		state.routeLine.setLatLngs(restored.points.map((point) => [point.lat, point.lng]));
	}
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

	state.liveMap = L.map("liveMap", { zoomControl: true }).setView([lat, lng], 16);
	state.liveTileLayer = createTileLayer((fallbackLayer) => {
		if (!state.liveMap || state.liveTileLayer !== fallbackLayer.from) return;
		state.liveMap.removeLayer(fallbackLayer.from);
		state.liveTileLayer = fallbackLayer.to;
		state.liveTileLayer.addTo(state.liveMap);
	});
	state.liveTileLayer.addTo(state.liveMap);

	state.routeLine = L.polyline([], {
		color: "#0b5d3b",
		weight: 5,
	}).addTo(state.liveMap);

	const guideStyle = getGuideLineStyle(state.prefs.guideContrast);

	state.guideLineHalo = L.polyline([], {
		color: guideStyle.haloColor,
		weight: guideStyle.haloWeight,
		opacity: guideStyle.haloOpacity,
		dashArray: guideStyle.dashArray,
		lineCap: "round",
	}).addTo(state.liveMap);

	state.guideLine = L.polyline([], {
		color: guideStyle.lineColor,
		weight: guideStyle.lineWeight,
		opacity: guideStyle.lineOpacity,
		dashArray: guideStyle.dashArray,
		lineCap: "round",
	}).addTo(state.liveMap);

	state.markerLayer = L.layerGroup().addTo(state.liveMap);

	state.liveMap.on("dragstart zoomstart", () => {
		if (state.currentSession) state.currentSession.shouldRecenter = false;
	});

	sizeLiveMapForRotation();
	setTimeout(() => {
		sizeLiveMapForRotation();
		state.liveMap?.invalidateSize();
	}, 150);
}

// The live map rotates to match heading. Leaflet only renders tiles for the
// element's own box, so rotating an element the size of its panel sweeps empty
// corners into view. Sizing it to a square whose side is the panel's diagonal
// guarantees coverage at every angle, because that square contains the panel's
// circumscribed circle.
function sizeLiveMapForRotation() {
	const mapElement = document.getElementById("liveMap");
	const panel = mapElement?.parentElement;
	if (!mapElement || !panel) return;

	const width = panel.clientWidth;
	const height = panel.clientHeight;
	if (!width || !height) return;

	// Plus a couple of pixels so sub-pixel rounding can never expose a hairline
	// gap at the 45-degree worst case.
	const side = Math.ceil(Math.hypot(width, height)) + 2;
	const offsetX = Math.round((width - side) / 2);
	const offsetY = Math.round((height - side) / 2);

	mapElement.style.position = "absolute";
	mapElement.style.minHeight = "0";
	mapElement.style.width = `${side}px`;
	mapElement.style.height = `${side}px`;
	mapElement.style.left = `${offsetX}px`;
	mapElement.style.top = `${offsetY}px`;

	// Leaflet's controls live inside the map element, so the oversize would push
	// the zoom buttons and the required OSM attribution outside the visible area.
	// Pin their container back over the visible rect; rotateLiveMap keeps it upright.
	const controls = mapElement.querySelector(".leaflet-control-container");
	if (controls) {
		controls.style.position = "absolute";
		controls.style.left = `${-offsetX}px`;
		controls.style.top = `${-offsetY}px`;
		controls.style.width = `${width}px`;
		controls.style.height = `${height}px`;
		controls.style.transformOrigin = "50% 50%";
	}
}

function initPostMap(session) {
	if (state.postMap) {
		state.postMap.remove();
		state.postMap = null;
	}

	state.postMap = L.map("postMap", { zoomControl: true });
	state.postTileLayer = createTileLayer((fallbackLayer) => {
		if (!state.postMap || state.postTileLayer !== fallbackLayer.from) return;
		state.postMap.removeLayer(fallbackLayer.from);
		state.postTileLayer = fallbackLayer.to;
		state.postTileLayer.addTo(state.postMap);
	});
	state.postTileLayer.addTo(state.postMap);

	const coords = session.points.map((p) => [p.lat, p.lng]);
	if (coords.length) {
		const polyGroup = L.layerGroup().addTo(state.postMap);
		const maxSpeed = Math.max(maxOf(session.points, (p) => p.speed || 0), 0.0001);

		// One layer per speed band, not one per point pair. A two-hour ride is
		// thousands of pairs, and a Leaflet layer for each locks up this screen.
		// Each band renders as a single multi-polyline, so no detail is lost.
		const bands = new Map();
		for (let i = 1; i < session.points.length; i++) {
			const prev = session.points[i - 1];
			const curr = session.points[i];
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
				lastRun.latlngs.push([curr.lat, curr.lng]);
				lastRun.endIndex = i;
			} else {
				runs.push({
					latlngs: [
						[prev.lat, prev.lng],
						[curr.lat, curr.lng],
					],
					endIndex: i,
				});
			}
		}

		// Draw slower bands first so the faster stretches stay visible where a route
		// crosses itself.
		for (const [band, runs] of [...bands].sort((a, b) => a[0] - b[0])) {
			L.polyline(runs.map((run) => run.latlngs), {
				color: speedBandColor(band),
				weight: 5,
			}).addTo(polyGroup);
		}

		const bounds = L.latLngBounds(coords);
		state.postMap.fitBounds(bounds.pad(0.12));
	} else {
		state.postMap.setView([0, 0], 2);
	}

	if (state.postMarkerLayer) {
		state.postMap.removeLayer(state.postMarkerLayer);
	}
	state.postMarkerLayer = L.layerGroup().addTo(state.postMap);
	
	// Recalculate segment markers based on current unit settings
	const segmentMarkers = recalculateSegmentMarkers(session);
	renderSegmentMarkers(state.postMarkerLayer, segmentMarkers);

	setTimeout(() => state.postMap?.invalidateSize(), 150);
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

function createTileLayer(onFallback) {
	const hasStadia = Boolean(state.prefs.stadiaKey);

	if (hasStadia) {
		const dark = state.prefs.theme === "dark";
		const styleName = dark ? "alidade_smooth_dark" : "alidade_smooth";
		const styleUrl = `https://tiles.stadiamaps.com/styles/${styleName}.json?api_key=${encodeURIComponent(state.prefs.stadiaKey)}`;
		const useVector = typeof L.maplibreGL === "function";
		const layer = useVector
			? L.maplibreGL({
				style: styleUrl,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://stadiamaps.com/">Stadia Maps</a>',
			})
			: L.tileLayer(
				`https://tiles.stadiamaps.com/tiles/${styleName}/{z}/{x}/{y}{r}.png?api_key=${encodeURIComponent(state.prefs.stadiaKey)}`,
				{
					maxZoom: 20,
					attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://stadiamaps.com/">Stadia Maps</a>',
				},
			);

		let failedOver = false;
		const errorEvent = useVector ? "error" : "tileerror";
		layer.on(errorEvent, () => {
			if (failedOver) return;
			failedOver = true;
			const fallback = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
				maxZoom: 19,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
			});
			if (onFallback) onFallback({ from: layer, to: fallback });
		});

		return layer;
	}

	return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
	});
}

function rebuildMapTiles() {
	if (state.liveMap) {
		if (state.liveTileLayer) state.liveMap.removeLayer(state.liveTileLayer);
		state.liveTileLayer = createTileLayer((fallbackLayer) => {
			if (!state.liveMap || state.liveTileLayer !== fallbackLayer.from) return;
			state.liveMap.removeLayer(fallbackLayer.from);
			state.liveTileLayer = fallbackLayer.to;
			state.liveTileLayer.addTo(state.liveMap);
		});
		state.liveTileLayer.addTo(state.liveMap);
	}

	if (state.postMap) {
		if (state.postTileLayer) state.postMap.removeLayer(state.postTileLayer);
		state.postTileLayer = createTileLayer((fallbackLayer) => {
			if (!state.postMap || state.postTileLayer !== fallbackLayer.from) return;
			state.postMap.removeLayer(fallbackLayer.from);
			state.postTileLayer = fallbackLayer.to;
			state.postTileLayer.addTo(state.postMap);
		});
		state.postTileLayer.addTo(state.postMap);
	}
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
	el.postTitle.textContent = `Ride - ${new Date(session.date).toLocaleString()}`;
	el.postDistance.innerHTML = formatDistanceMarkup(session.totalDistance || 0, state.prefs.unit);
	el.postTime.textContent = formatDuration(session.movingTime || 0);
	el.postMaxSpeed.innerHTML = formatSpeedMarkup(session.maxSpeed || 0, state.prefs.unit);
	el.postAvgSpeed.innerHTML = formatSpeedMarkup(session.avgSpeed || 0, state.prefs.unit);

	const gain = formatElevation(session.elevationGain || 0, state.prefs.unit);
	const drop = formatElevation(session.elevationDrop || 0, state.prefs.unit);
	el.postElevation.textContent = `↑ ${gain} gained / ↓ ${drop} dropped`;

	el.segmentsBody.innerHTML = "";
	// Recalculate segments based on current unit settings
	const segments = recalculateSegments(session);
	const unitLabel = distanceUnitLabel(state.prefs.unit);
	for (const seg of segments) {
		const tr = document.createElement("tr");
		const label = seg.partial
			? `Final ${formatDistance(seg.distance, state.prefs.unit)} ${unitLabel}`
			: segmentLabel(seg.segmentNumber, state.prefs.unit);
		tr.innerHTML = `
			<td>${label}</td>
			<td>${formatDuration(seg.duration)}</td>
			<td>${formatSpeed(seg.avgSpeed, state.prefs.unit)}</td>
		`;
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
	const padding = { top: 16, right: 16, bottom: 26, left: 48 };
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

	drawChartBackground(ctx, cssWidth, cssHeight, padding, minElevation, maxElevation, session, displayUnit, totalDistance);

	ctx.lineWidth = 3;
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

	drawChartAxes(ctx, cssWidth, cssHeight, padding, minElevation, maxElevation, session, displayUnit, totalDistance);

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

	// Remove old marker if exists
	if (state.chartHighlightMarker) {
		state.postMap.removeLayer(state.chartHighlightMarker);
	}

	// Create highlight marker
	state.chartHighlightMarker = L.circleMarker([point.lat, point.lng], {
		radius: 8,
		fillColor: "#ff6b35",
		color: "#fff",
		weight: 3,
		opacity: 1,
		fillOpacity: 0.8,
	}).addTo(state.postMap);
}

function clearChartHighlight() {
	if (state.chartHighlightMarker) {
		state.postMap?.removeLayer(state.chartHighlightMarker);
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

function drawChartBackground(ctx, width, height, padding, minElevation, maxElevation, session, unit, totalDistance) {
	ctx.save();
	ctx.fillStyle = "transparent";
	ctx.fillRect(0, 0, width, height);

	ctx.strokeStyle = "rgba(127,127,127,0.18)";
	ctx.lineWidth = 1;

	const gridLines = 4;
	for (let index = 0; index <= gridLines; index += 1) {
		const y = padding.top + (index / gridLines) * (height - padding.top - padding.bottom);
		ctx.beginPath();
		ctx.moveTo(padding.left, y);
		ctx.lineTo(width - padding.right, y);
		ctx.stroke();
	}

	ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted") || "#666";
	ctx.font = "12px sans-serif";
	ctx.textAlign = "right";
	ctx.textBaseline = "middle";
	ctx.fillText(formatElevation(minElevation, unit), padding.left - 8, height - padding.bottom);
	ctx.fillText(formatElevation(maxElevation, unit), padding.left - 8, padding.top);

	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	const totalDistanceLabel = formatDistance(session.totalDistance || 0, unit);
	ctx.fillText(`0`, padding.left, height - padding.bottom + 6);
	ctx.fillText(totalDistanceLabel, width - padding.right, height - padding.bottom + 6);
	ctx.restore();
}

function drawChartAxes(ctx, width, height, padding, minElevation, maxElevation, session, unit, totalDistance) {
	ctx.save();
	ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border") || "#ccc";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(padding.left, padding.top);
	ctx.lineTo(padding.left, height - padding.bottom);
	ctx.lineTo(width - padding.right, height - padding.bottom);
	ctx.stroke();
	ctx.restore();
}

function speedToColor(speed, maxSpeed) {
	const clamped = Math.max(0, Math.min(1, speed / maxSpeed));
	const hue = 0 + clamped * 120;
	return `hsl(${hue} 75% 48%)`;
}

function speedBand(speed, maxSpeed) {
	const clamped = Math.max(0, Math.min(1, speed / maxSpeed));
	return Math.min(SPEED_BANDS - 1, Math.floor(clamped * SPEED_BANDS));
}

function speedBandColor(band) {
	// Sample the ramp mid-band so the bands stay evenly spaced across it.
	return speedToColor((band + 0.5) / SPEED_BANDS, 1);
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

function showMessage(title, message) {
	return showModal({
		title,
		message,
		confirmText: "OK",
		hideCancel: true,
	}).then(() => undefined);
}

function confirmWithModal({ title, message, confirmText, cancelText, timeoutMs, timeoutLabel }) {
	return showModal({
		title,
		message,
		confirmText,
		cancelText,
		timeoutMs,
		timeoutLabel,
	}).then((result) => result === "confirm");
}

function showModal({
	title,
	message,
	confirmText = "OK",
	cancelText = "Cancel",
	hideCancel = false,
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

function createSegmentMarkerIcon(label, markerSizeValue = state.prefs.markerSize) {
	const safeLabel = escapeHtml(label);
	const markerSize = getMarkerSizeConfig(markerSizeValue);
	return L.divIcon({
		className: "segment-flag-wrapper",
		html: `<div class="segment-flag-marker ${markerSize.className}"><span>${safeLabel}</span></div>`,
		iconSize: markerSize.iconSize,
		iconAnchor: markerSize.iconAnchor,
		rotationAngle: 0,
	});
}

function getMarkerSizeConfig(size) {
	if (size === "small") {
		return {
			className: "small",
			iconSize: [56, 28],
			iconAnchor: [28, 14],
		};
	}

	if (size === "large") {
		return {
			className: "large",
			iconSize: [88, 40],
			iconAnchor: [44, 20],
		};
	}

	return {
		className: "medium",
		iconSize: [72, 34],
		iconAnchor: [36, 17],
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
	L.marker([lat, lng], {
		icon: createSegmentMarkerIcon(label, markerSizeValue),
	}).addTo(layer);
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
	const guideStyle = getGuideLineStyle(guideContrast);

	if (state.guideLineHalo) {
		state.guideLineHalo.setStyle({
			color: guideStyle.haloColor,
			weight: guideStyle.haloWeight,
			opacity: guideStyle.haloOpacity,
			dashArray: guideStyle.dashArray,
		});
	}

	if (state.guideLine) {
		state.guideLine.setStyle({
			color: guideStyle.lineColor,
			weight: guideStyle.lineWeight,
			opacity: guideStyle.lineOpacity,
			dashArray: guideStyle.dashArray,
		});
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

function formatDistanceMarkup(meters, unit) {
	return wrapDecimalParts(formatDistance(meters, unit));
}

function formatSpeed(mps, unit) {
	if (unit === "imperial") return `${(mps * MPS_TO_MPH).toFixed(1)}`;
	return `${(mps * MPS_TO_KPH).toFixed(1)}`;
}

function formatSpeedMarkup(mps, unit) {
	return wrapDecimalParts(formatSpeed(mps, unit));
}

function wrapDecimalParts(value) {
	const text = String(value);
	const match = text.match(/^(\d+)(\.(\d+))(.*)$/);
	if (!match) return text;

	const [, whole, dotAndFraction, fraction, suffix] = match;
	const dot = dotAndFraction.slice(0, 1);
	return `${whole}<span class="decimal-point">${dot}</span><span class="decimal-fraction">${fraction}</span>${suffix}`;
}

function formatElevation(meters, unit) {
	if (unit === "imperial") return `${(meters * 3.28084).toFixed(0)} ft`;
	return `${meters.toFixed(0)} m`;
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
	state.prefs.guideContrast = await getPref("guideContrast", "high");
	state.prefs.markerSize = await getPref("markerSize", "medium");
	state.prefs.ridesView = await getPref("ridesView", "list");
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
