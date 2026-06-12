const DB_NAME = "bike-tracker-db";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const PREF_STORE = "preferences";

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;
const MPS_TO_MPH = 2.236936;
const MPS_TO_KPH = 3.6;

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
		installDismissed: false,
	},
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
	lastAcceleration: { x: 0, y: 0, z: 0 },
	currentHeadingDegrees: 0,
	estimatedPointsDuringGap: [],
	velocityEstimate: 0,
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
	await renderSessionsList();
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
		await renderSessionsList();
		updateLiveStats();
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

	el.startRideBtn.addEventListener("click", startCountdownFlow);
	el.retryCountdownBtn.addEventListener("click", startCountdownFlow);
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
		state.currentPostSession = null;
		navigateToScreen("home");
		await renderSessionsList();
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
		if (state.liveMap) state.liveMap.invalidateSize();
		if (state.postMap) state.postMap.invalidateSize();
		if (state.currentPostSession) renderElevationChart(state.currentPostSession);
	});

	document.addEventListener("visibilitychange", async () => {
		const session = state.currentSession;
		if (!session) return;
		if (document.hidden) {
			await releaseWakeLock();
		} else if (!session.paused) {
			await requestWakeLock();
		}
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

async function renderSessionsList() {
	const sessions = await getAllSessions();
	sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

	el.sessionsList.innerHTML = "";

	if (!sessions.length) {
		el.sessionsEmpty.classList.remove("hidden");
		return;
	}

	el.sessionsEmpty.classList.add("hidden");

	for (const session of sessions) {
		const li = document.createElement("li");
		const button = document.createElement("button");
		button.className = "btn";
		button.type = "button";

		const date = new Date(session.date);
		const dateText = date.toLocaleString();
		const distText = formatDistance(session.totalDistance || 0, state.prefs.unit);
		const timeText = formatDuration(session.movingTime || 0);
		const activityType = session.activityType || "bike";
		const activityIcon = ACTIVITIES[activityType]?.icon || "🚴";

		button.innerHTML = `<span>${activityIcon} ${dateText}</span><span>${distText} • ${timeText}</span>`;
		button.addEventListener("click", () => openPostSession(session.id, null, "push"));
		li.appendChild(button);
		el.sessionsList.appendChild(li);
	}
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

async function startActivityCountdown() {
	const runToken = Date.now();
	state.countdownRunToken = runToken;
	navigateToScreen("countdown");
	el.retryCountdownBtn.classList.add("hidden");
	el.countdownStatus.textContent = "Getting GPS lock...";

	let countdown = 5;
	el.countdownNumber.textContent = String(countdown);

	let lockPosition = null;
	try {
		lockPosition = await Promise.race([
			getCurrentPosition(4500),
			new Promise((resolve) => setTimeout(() => resolve(null), 4500)),
		]);
	} catch {
		lockPosition = null;
	}

	const intervalId = setInterval(async () => {
		if (state.countdownRunToken !== runToken) {
			clearInterval(intervalId);
			return;
		}

		countdown -= 1;
		el.countdownNumber.textContent = String(Math.max(0, countdown));

		if (countdown > 0) return;

		clearInterval(intervalId);

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
		watchId: null,
		lastPoint: null,
		elapsedIntervalId: null,
		deadReckoningIntervalId: null,
		resumeTimestamp: now,
		speedSum: 0,
		speedSamples: 0,
		altitudeSamples: [],
		smoothAltitudePrev: null,
		nextSegmentDistance: getSegmentLengthMeters(state.prefs.unit),
		segmentStartElapsed: 0,
		shouldRecenter: true,
		currentHeading: 0,
	};

	if (state.selectedKeepScreenOn && "wakeLock" in navigator) {
		await requestWakeLock();
	}

	navigateToScreen("active");
	initLiveMap(initialPosition.coords.latitude, initialPosition.coords.longitude);

	// Initialize sensor fusion for GPS outage bridging
	state.gpsOutageDetected = false;
	state.estimatedPointsDuringGap = [];
	state.lastGPSTimestamp = Date.now();
	state.velocityEstimate = 0;

	processPosition(initialPosition, true);
	startWatch();
	initMotionSensors();
	state.currentSession.elapsedIntervalId = setInterval(updateLiveStats, 500);
	updateLiveStats();
	if (!state.selectedKeepScreenOn) {
		await requestWakeLock();
	}
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
	if (session?.watchId !== null) {
		navigator.geolocation.clearWatch(session.watchId);
		session.watchId = null;
	}
	stopMotionSensors();
}

function initMotionSensors() {
	// Only enable for bike activity
	if (state.selectedActivityType !== "bike") return;

	try {
		state.motionSensorActive = true;
		window.addEventListener("devicemotion", handleMotionUpdate);
		window.addEventListener("deviceorientation", handleOrientationUpdate);

		// Start dead reckoning loop during GPS outages
		if (!state.currentSession?.deadReckoningIntervalId) {
			state.currentSession.deadReckoningIntervalId = setInterval(() => {
				if (state.gpsOutageDetected && state.currentSession && !state.currentSession.paused && state.currentSession.lastPoint) {
					const estimatedPt = estimatePositionDuringOutage(
						state.currentSession.lastPoint,
						state.currentHeadingDegrees,
						state.velocityEstimate,
					);
					state.estimatedPointsDuringGap.push(estimatedPt);
				}
			}, 100);
		}
	} catch (error) {
		console.warn("Motion sensors unavailable", error);
		state.motionSensorActive = false;
	}
}

function stopMotionSensors() {
	if (state.motionSensorActive) {
		window.removeEventListener("devicemotion", handleMotionUpdate);
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
}

function handleMotionUpdate(event) {
	if (!state.currentSession || state.currentSession.paused) return;

	const accel = event.acceleration;
	if (!accel) return;

	state.lastAcceleration = {
		x: accel.x || 0,
		y: accel.y || 0,
		z: accel.z || 0,
	};
}

function handleOrientationUpdate(event) {
	if (!state.currentSession || state.currentSession.paused) return;

	// Alpha: rotation around Z axis (0-360), Beta: X axis (-180 to 180), Gamma: Y axis (-90 to 90)
	// For compass heading, we primarily use alpha
	if (typeof event.alpha === "number") {
		state.currentHeadingDegrees = event.alpha;
	}
}

function updateGPSOutageDetection(timestamp) {
	const session = state.currentSession;
	if (!session || !state.motionSensorActive) return;

	// Clear existing timeout if any
	if (state.gpsOutageTimeout) {
		clearTimeout(state.gpsOutageTimeout);
	}

	state.lastGPSTimestamp = timestamp;

	// Set timeout to detect outage if GPS doesn't update within 800ms
	state.gpsOutageTimeout = setTimeout(() => {
		if (!state.gpsOutageDetected && state.currentSession && !state.currentSession.paused) {
			state.gpsOutageDetected = true;
			state.estimatedPointsDuringGap = [];
			beginDeadReckoning();
		}
	}, 800);
}

function beginDeadReckoning() {
	const session = state.currentSession;
	if (!session || !session.lastPoint) return;

	// Initialize velocity estimate from last GPS point
	state.velocityEstimate = session.lastPoint.speed || 0;
}

function estimatePositionDuringOutage(lastGPSPoint, headingDegrees, velocity) {
	// Simple dead reckoning: estimate movement based on heading and velocity
	// Updates every 100ms with sensor data
	
	const timeDelta = 0.1; // 100ms
	const metersPerSecond = velocity;
	const metersThisStep = metersPerSecond * timeDelta;

	// Convert heading to radians, accounting for magnetic declination
	const headingRad = (headingDegrees * Math.PI) / 180;

	// Simple mercator projection for local estimates
	const lat = lastGPSPoint.lat;
	const lng = lastGPSPoint.lng;

	// Approximate meters per degree at this latitude
	const metersPerDegreeLat = 111320;
	const metersPerDegreeLng = 111320 * Math.cos((lat * Math.PI) / 180);

	// Calculate new position
	const deltaLat = (metersThisStep * Math.cos(headingRad)) / metersPerDegreeLat;
	const deltaLng = (metersThisStep * Math.sin(headingRad)) / metersPerDegreeLng;

	return {
		lat: lat + deltaLat,
		lng: lng + deltaLng,
		timestamp: Date.now(),
	};
}

function validateAndSpliceGapPoints(resumedGPSPoint, lastEstimatedPoint) {
	const session = state.currentSession;
	if (!session || state.estimatedPointsDuringGap.length === 0) {
		state.gpsOutageDetected = false;
		state.estimatedPointsDuringGap = [];
		return;
	}

	// Calculate distance between last estimated point and resumed GPS point
	const gapDistance = haversineMeters(
		lastEstimatedPoint.lat,
		lastEstimatedPoint.lng,
		resumedGPSPoint.lat,
		resumedGPSPoint.lng,
	);

	// If gap is reasonable (less than ~50 meters for a ~1 second gap at typical bike speed)
	// then splice in the estimated points; otherwise discard them
	const maxReasonableGapDistance = 50;

	if (gapDistance < maxReasonableGapDistance && state.estimatedPointsDuringGap.length > 0) {
		// Splice estimated points into history
		const estimatedWithMetadata = state.estimatedPointsDuringGap.map((pt) => ({
			lat: pt.lat,
			lng: pt.lng,
			altitude: lastEstimatedPoint.altitude || null,
			speed: state.velocityEstimate,
			accuracy: 15, // Estimated accuracy
			timestamp: pt.timestamp,
			estimated: true,
		}));

		// Insert estimated points before the resumed GPS point
		session.points.push(...estimatedWithMetadata);

		// Update distance and stats with estimated points
		for (let i = 0; i < estimatedWithMetadata.length; i++) {
			const pt = estimatedWithMetadata[i];
			if (i === 0) {
				session.totalDistance += haversineMeters(
					lastEstimatedPoint.lat,
					lastEstimatedPoint.lng,
					pt.lat,
					pt.lng,
				);
			} else {
				const prevPt = estimatedWithMetadata[i - 1];
				session.totalDistance += haversineMeters(prevPt.lat, prevPt.lng, pt.lat, pt.lng);
			}
		}

		console.log(`Bridged GPS gap with ${estimatedWithMetadata.length} estimated points`);
	}

	state.gpsOutageDetected = false;
	state.estimatedPointsDuringGap = [];
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

	// Handle GPS outage detection and bridging
	if (state.gpsOutageDetected && session.lastPoint) {
		// GPS has resumed after outage - validate and splice estimated points
		validateAndSpliceGapPoints(point, session.lastPoint);
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

	session.maxSpeed = Math.max(session.maxSpeed, safeSpeed);
	session.speedSum += safeSpeed;
	session.speedSamples += 1;
	session.avgSpeed = session.speedSamples ? session.speedSum / session.speedSamples : 0;

	updateElevationTotals(point.altitude);
	updateSegments(point);
	updateLiveMap(point, heading, safeSpeed);
	updateLiveStats();
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
			label: markerLabel,
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

	const threshold = state.prefs.unit === "imperial" ? 3 / MPS_TO_MPH : 5 / MPS_TO_KPH;
	let nextHeading = 0;

	if (speedMps >= threshold) {
		if (Number.isFinite(heading)) {
			nextHeading = heading;
		} else {
			const session = state.currentSession;
			if (session && session.points.length >= 2) {
				const a = session.points[session.points.length - 2];
				const b = session.points[session.points.length - 1];
				nextHeading = bearingDegrees(a.lat, a.lng, b.lat, b.lng);
			}
		}
	}

	rotateLiveMap(nextHeading);

	if (state.currentSession?.shouldRecenter) {
		state.liveMap.setView([point.lat, point.lng]);
	}
}

function rotateLiveMap(heading) {
	const mapElement = document.getElementById("liveMap");
	mapElement.style.transformOrigin = "50% 50%";
	mapElement.style.transform = `rotate(${-heading}deg)`;
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
		stopWatch();
		el.pauseBtn.textContent = "Resume";
		await releaseWakeLock();
		updateLiveStats();
		return;
	}

	session.paused = false;
	session.resumeTimestamp = Date.now();
	startWatch();
	el.pauseBtn.textContent = "Pause";
	await requestWakeLock();
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

	stopWatch();
	clearInterval(session.elapsedIntervalId);
	await releaseWakeLock();

	const saved = {
		date: session.date,
		unit: session.unit,
		points: session.points,
		totalDistance: session.totalDistance,
		movingTime: session.movingTime,
		maxSpeed: session.maxSpeed,
		avgSpeed: session.movingTime > 0 ? session.totalDistance / (session.movingTime / 1000) : 0,
		elevationGain: session.elevationGain,
		elevationDrop: session.elevationDrop,
		segments: session.segments,
		segmentMarkers: session.segmentMarkers,
	};

	const id = await addSession(saved);
	saved.id = id;
	state.currentSession = null;
	el.pauseBtn.textContent = "Pause";
	return saved;
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

	setTimeout(() => state.liveMap?.invalidateSize(), 150);
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
		const poly = L.polyline(coords, {
			color: "#0b5d3b",
			weight: 5,
		}).addTo(state.postMap);
		state.postMap.fitBounds(poly.getBounds().pad(0.12));
	} else {
		state.postMap.setView([0, 0], 2);
	}

	if (state.postMarkerLayer) {
		state.postMap.removeLayer(state.postMarkerLayer);
	}
	state.postMarkerLayer = L.layerGroup().addTo(state.postMap);
	renderSegmentMarkers(state.postMarkerLayer, session.segmentMarkers || []);

	setTimeout(() => state.postMap?.invalidateSize(), 150);
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
	for (const seg of session.segments || []) {
		const tr = document.createElement("tr");
		tr.innerHTML = `
			<td>${segmentLabel(seg.segmentNumber, state.prefs.unit)}</td>
			<td>${formatDuration(seg.duration)}</td>
			<td>${formatSpeed(seg.avgSpeed, state.prefs.unit)}</td>
		`;
		el.segmentsBody.appendChild(tr);
	}
}

function renderElevationChart(session) {
	const canvas = el.elevationChart;
	if (!canvas) return;

	const points = buildChartPoints(session);
	if (!points.length) {
		drawEmptyChart(canvas, "No elevation data available");
		return;
	}

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

	const elevations = points.map((point) => point.elevation);
	const speeds = points.map((point) => point.speed);
	const minElevation = Math.min(...elevations);
	const maxElevation = Math.max(...elevations);
	const maxSpeed = Math.max(...speeds, 0.0001);

	const xFor = (distance) => padding.left + (distance / totalDistance) * chartWidth;
	const yFor = (elevation) => {
		if (maxElevation === minElevation) return padding.top + chartHeight / 2;
		return padding.top + chartHeight - ((elevation - minElevation) / (maxElevation - minElevation)) * chartHeight;
	};

	drawChartBackground(ctx, cssWidth, cssHeight, padding, minElevation, maxElevation, session, displayUnit, totalDistance);

	for (let index = 1; index < points.length; index += 1) {
		const previous = points[index - 1];
		const current = points[index];
		const midSpeed = (previous.speed + current.speed) / 2;
		ctx.beginPath();
		ctx.lineWidth = 3;
		ctx.lineCap = "round";
		ctx.strokeStyle = speedToColor(midSpeed, maxSpeed);
		ctx.moveTo(xFor(previous.distance), yFor(previous.elevation));
		ctx.lineTo(xFor(current.distance), yFor(current.elevation));
		ctx.stroke();
	}

	drawChartAxes(ctx, cssWidth, cssHeight, padding, minElevation, maxElevation, session, displayUnit, totalDistance);
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
	await renderSessionsList();
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
	closeModal("cancel", true);

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

function closeModal(result = "cancel", silent = false) {
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

	if (state.modalResolver && !silent) {
		const resolver = state.modalResolver;
		state.modalResolver = null;
		resolver(result);
	} else if (silent) {
		state.modalResolver = null;
	}
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
	try {
		if (state.wakeLockSentinel && !state.wakeLockSentinel.released) return;
		state.wakeLockSentinel = await navigator.wakeLock.request("screen");
		state.wakeLockSentinel.addEventListener("release", () => {
			state.wakeLockSentinel = null;
			if (state.currentSession?.paused === false) {
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
		hasRefreshed = true;
		window.location.reload();
	});

	const triggerUpdateCheck = () => {
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
		addSegmentMarkerToLayer(layer, marker.lat, marker.lng, marker.label, markerSizeValue);
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
		renderSegmentMarkers(state.postMarkerLayer, state.currentPostSession?.segmentMarkers || [], markerSize);
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

		const confirmed = await new Promise((resolve) => {
			state.modalResolver = resolve;
			el.modalTitle.textContent = "Import Confirmation";
			el.modalMessage.textContent = `This will import ${data.sessions.length} session(s) and overwrite your preferences. Continue?`;
			el.modalCountdown.classList.add("hidden");
			el.modalCancelBtn.textContent = "Cancel";
			el.modalConfirmBtn.textContent = "Import";
			el.modalBackdrop.classList.remove("hidden");
		});

		el.importFileInput.value = "";

		if (!confirmed) return;

		for (const session of data.sessions) {
			await addSession(session);
		}

		for (const [key, value] of Object.entries(data.preferences)) {
			await setPref(key, value);
		}

		await loadPrefs();
		await renderSessionsList();
		await showMessage("Import Success", "Your data has been imported successfully.");
	} catch (error) {
		el.importFileInput.value = "";
		await showMessage("Import Error", `Failed to import data: ${error.message}`);
	}
}

function openDB() {
	return new Promise((resolve, reject) => {
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

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
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
