/**
 * The app's single shared mutable-state object and its DOM-reference table.
 * Every module imports `state` and/or `el` from here rather than holding its
 * own copies, so a change in one module (e.g. `state.currentSession`) is
 * immediately visible to every other module reading it.
 */

import { LIVE_MAP_ZOOM, GUIDE_HIDE_DISTANCE_DEFAULT_M, BACK_TO_START_DEFAULT } from "./constants.js";

/**
 * The app's single mutable state object. `prefs` is the subset persisted to
 * IndexedDB (see db.js's `loadPrefs`/`setPref`); everything else is
 * in-memory-only and resets on reload.
 */
export const state = {
	prefs: {
		unit: "imperial",
		theme: "light",
		stadiaKey: "",
		mapType: "road",
		terrain3d: false,
		liveMapZoom: LIVE_MAP_ZOOM,
		comparePastRides: true,
		// Which side of the map the ride stats sit on in landscape: "left" or "right".
		rideStatsSide: "left",
		guideContrast: "high",
		markerSize: "medium",
		// "Hide Near Start": once the rider is this close (meters) to the ride's
		// start, the distance-to-start chip hides outright. See constants.js.
		guideHideDistance: GUIDE_HIDE_DISTANCE_DEFAULT_M,
		// "Back to Start": "none", "direct" or "route". See constants.js.
		backToStart: BACK_TO_START_DEFAULT,
		// Route mode: steer the route home off the roads ridden out on.
		routeAvoidRetrace: false,
		// How a planned route picked in ride setup is followed: "asis" draws it
		// as planned; "points" routes live to each of its points in turn.
		rideRouteMode: "asis",
		ridesView: "list",
		// Which activity the home screen's month and week totals count, or "all".
		statsActivity: "all",
		// What the calendar's top rule colours by: "distance", "time" or "pace".
		calendarColor: "distance",
		installDismissed: false,
		// Debug: colours a ride's summary route by GPS accuracy instead of speed.
		debugGpsAccuracy: false,
		// Debug: also grays out the route's warm-up stretch, before GPS settles.
		debugClipGpsWarmup: false,
		dataSaver: false
	},
	// Which month the calendar view is paged to, as the 1st at local midnight.
	// Null until the first calendar render picks a starting month from the rides.
	calendarMonth: null,
	deferredInstallPrompt: null,
	// Both maps are MapLibre. The live map's sources are rebuilt from these
	// whenever the style is swapped, so they are the record of what it shows.
	liveMap: null,
	liveRouteCoords: [],
	// The guide line home, start first and rider last: two points for the
	// straight line, or a whole route in Route mode.
	liveGuideCoords: [],
	// The guide line's length along the route, in Route mode; null when it's
	// the straight line.
	liveGuideRouteMeters: null,
	markerLayer: null,
	guideLabelMarker: null,
	riderMarker: null,
	// Built from the saved rides when a ride starts; null until it is ready.
	paceIndex: null,
	bestPaceChip: null,
	// What the band shows, kept so a style swap can redraw it.
	bestPaceBand: null,
	postMap: null,
	// The route planner's map, created the first time the planner opens.
	planMap: null,
	// The saved route open in the planner (see route-plan.js for its shape).
	editingRoute: null,
	// The saved route picked for the ride being set up or ridden, drawn on the
	// live map, or null for none.
	rideRoute: null,
	// A route to preselect the next time ride setup opens (the routes list's
	// Ride button), or null.
	nextRideRouteId: null,
	// What the live map draws of the ride's route; see ride-plan.js.
	livePlanCoords: [],
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
	// Where the rider is in the pre-ride -> active hand-off on the active
	// screen: null (not in the flow), "setup", "starting", "countdown",
	// "revealing", or "active". Mirrored onto activeScreen's data-phase.
	rideFlowPhase: null,
	setupWatchId: null,
	setupLocked: false,
	setupPosition: null,
	// Where the rider was when GPS first locked during setup; see
	// ride-setup.js's handleSetupPosition and finishRideSetup.
	setupHeadingAnchor: null,
	countdownIntervalId: null,
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

/**
 * Every DOM element the app reads or writes, looked up once at module-load
 * time (i.e. when this module is first imported). Safe because `app.js` is
 * loaded as `type="module"` at the end of `index.html`'s body, so the whole
 * document has already parsed by then.
 */
export const el = {
	installBanner: document.getElementById("installBanner"),
	installMessage: document.getElementById("installMessage"),
	installBtn: document.getElementById("installBtn"),
	dismissInstallBtn: document.getElementById("dismissInstallBtn"),
	screens: {
		home: document.getElementById("homeScreen"),
		active: document.getElementById("activeScreen"),
		post: document.getElementById("postScreen"),
		settings: document.getElementById("settingsScreen"),
		debug: document.getElementById("debugScreen"),
		plan: document.getElementById("planScreen"),
		routes: document.getElementById("routesScreen"),
	},
	unitToggle: document.getElementById("unitToggle"),
	themeToggle: document.getElementById("themeToggle"),
	mapTypeSelect: document.getElementById("mapTypeSelect"),
	terrain3dToggle: document.getElementById("terrain3dToggle"),
	compareToggle: document.getElementById("compareToggle"),
	statsSideToggle: document.getElementById("statsSideToggle"),
	calendarColorToggle: document.getElementById("calendarColorToggle"),
	calendarColorNote: document.getElementById("calendarColorNote"),
	debugAccuracyToggle: document.getElementById("debugAccuracyToggle"),
	debugClipWarmupToggle: document.getElementById("debugClipWarmupToggle"),
	// Debug screen's own copies of a few frequently-tweaked settings, kept in
	// sync with the settings screen's originals — see navigation.js.
	debugThemeToggle: document.getElementById("debugThemeToggle"),
	debugMapTypeSelect: document.getElementById("debugMapTypeSelect"),
	debugTerrain3dToggle: document.getElementById("debugTerrain3dToggle"),
	debugGuideContrastToggle: document.getElementById("debugGuideContrastToggle"),
	debugMarkerSizeToggle: document.getElementById("debugMarkerSizeToggle"),
	debugGuideHideDistanceSelect: document.getElementById("debugGuideHideDistanceSelect"),
	debugBackToStartToggle: document.getElementById("debugBackToStartToggle"),
	debugAvoidRetraceRow: document.getElementById("debugAvoidRetraceRow"),
	debugAvoidRetraceToggle: document.getElementById("debugAvoidRetraceToggle"),
	debugCompareToggle: document.getElementById("debugCompareToggle"),
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
	openRoutesBtn: document.getElementById("openRoutesBtn"),
	routesBackBtn: document.getElementById("routesBackBtn"),
	routesList: document.getElementById("routesList"),
	routesEmpty: document.getElementById("routesEmpty"),
	newRouteBtn: document.getElementById("newRouteBtn"),
	planTopBar: document.getElementById("planTopBar"),
	planBackBtn: document.getElementById("planBackBtn"),
	planDeleteBtn: document.getElementById("planDeleteBtn"),
	planNameInput: document.getElementById("planNameInput"),
	planProfile: document.getElementById("planProfile"),
	planDistance: document.getElementById("planDistance"),
	planClimb: document.getElementById("planClimb"),
	planDescent: document.getElementById("planDescent"),
	planChart: document.getElementById("planChart"),
	planChartReadout: document.getElementById("planChartReadout"),
	planBottomPanel: document.getElementById("planBottomPanel"),
	planStatus: document.getElementById("planStatus"),
	planUndoBtn: document.getElementById("planUndoBtn"),
	planRedoBtn: document.getElementById("planRedoBtn"),
	planImportBtn: document.getElementById("planImportBtn"),
	planExportBtn: document.getElementById("planExportBtn"),
	planGpxInput: document.getElementById("planGpxInput"),
	planDoneBtn: document.getElementById("planDoneBtn"),
	setupRouteSelect: document.getElementById("setupRouteSelect"),
	setupRouteModeRow: document.getElementById("setupRouteModeRow"),
	setupRouteModeToggle: document.getElementById("setupRouteModeToggle"),
	openSettingsBtn: document.getElementById("openSettingsBtn"),
	settingsBackBtn: document.getElementById("settingsBackBtn"),
	debugFab: document.getElementById("debugFab"),
	debugMenuBtn: document.getElementById("debugMenuBtn"),
	debugBackBtn: document.getElementById("debugBackBtn"),
	stadiaKeyInput: document.getElementById("stadiaKeyInput"),
	saveStadiaKeyBtn: document.getElementById("saveStadiaKeyBtn"),
	guideContrastToggle: document.getElementById("guideContrastToggle"),
	markerSizeToggle: document.getElementById("markerSizeToggle"),
	guideHideDistanceSelect: document.getElementById("guideHideDistanceSelect"),
	backToStartToggle: document.getElementById("backToStartToggle"),
	avoidRetraceRow: document.getElementById("avoidRetraceRow"),
	avoidRetraceToggle: document.getElementById("avoidRetraceToggle"),
	statsActivitySelect: document.getElementById("statsActivitySelect"),
	exportDataBtn: document.getElementById("exportDataBtn"),
	importDataBtn: document.getElementById("importDataBtn"),
	importFileInput: document.getElementById("importFileInput"),
	importGpxBtn: document.getElementById("importGpxBtn"),
	importGpxFileInput: document.getElementById("importGpxFileInput"),
	deleteAllRidesBtn: document.getElementById("deleteAllRidesBtn"),
	dataSaverToggle: document.getElementById("dataSaverToggle"),
	keepScreenOnToggle: document.getElementById("keepScreenOnToggle"),
	setupTopBar: document.getElementById("setupTopBar"),
	setupBottomPanel: document.getElementById("setupBottomPanel"),
	setupBackBtn: document.getElementById("setupBackBtn"),
	setupLocatingLabel: document.getElementById("setupLocatingLabel"),
	setupLocatingMessage: document.getElementById("setupLocatingMessage"),
	setupStatusDot: document.getElementById("setupStatusDot"),
	startActivityBtn: document.getElementById("startActivityBtn"),
	startGpsHint: document.getElementById("startGpsHint"),
	countdownNumber: document.getElementById("countdownNumber"),
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
	postAvgSpeedUnit: document.getElementById("postAvgSpeedUnit"),
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
