/**
 * The pre-ride flow: from tapping "Start New Ride" through GPS lock, the
 * countdown, and the hand-off into `startSession` in live-session.js. The
 * active screen doubles as the pre-ride setup screen throughout — see
 * `beginRideSetup` for why — moving through `rideFlowPhase` values
 * ("setup" → "starting" → "countdown" → "revealing" → "active") that
 * app.css keys its layout off via the screen's `data-phase` attribute.
 */

import { COUNTDOWN_SECONDS, LIVE_MAP_PITCH, HEADING_GPS_MIN_SPEED_MPS, HEADING_MIN_MOVE_M } from "./constants.js";
import { state, el } from "./state.js";
import { showMessage } from "./modal.js";
import { haversineMeters, bearingDegrees } from "./format.js";
import { initLiveMap, animateMarkerTo, ridePadding } from "./live-map.js";
import { navigateToScreen } from "./navigation.js";
import { startSession, requestOrientationPermission } from "./live-session.js";
import { resetRouteHome } from "./route-home.js";
import { populateSetupRoutes } from "./route-plan.js";
import { resetRidePlan } from "./ride-plan.js";
import { hideDirections } from "./directions.js";

/**
 * The "Start New Ride" button's handler: resets the activity picker to the
 * bike default and enters the setup flow. Bails with a message if the
 * browser has no geolocation support at all.
 *
 * @returns {Promise<void>}
 */
export async function startCountdownFlow() {
	if (!navigator.geolocation) {
		await showMessage("Geolocation Unavailable", "Geolocation is not available in this browser.");
		return;
	}

	state.selectedActivityType = "bike";
	state.selectedKeepScreenOn = true;
	el.keepScreenOnToggle.checked = true;
	document.querySelectorAll(".activity-btn").forEach((b) => b.classList.remove("active"));
	document.querySelector('[data-activity="bike"]').classList.add("active");
	beginRideSetup();
}

// The active screen doubles as the pre-ride setup screen: the map is already
// live and centred on the rider before Start Ride is even tappable, so the
// countdown and the ride that follows never have to swap screens or reload
// the map. See the data-phase rules in app.css for how each phase looks.
/**
 * Enters the "setup" phase: clears any map left over from a previous ride
 * (setup only creates a fresh one lazily, in `handleSetupPosition`, so a
 * stale one has to be torn down explicitly here), switches to the active
 * screen, and starts watching position for a GPS lock.
 */
export function beginRideSetup() {
	state.rideFlowPhase = "setup";
	state.setupLocked = false;
	state.setupPosition = null;
	// Where the rider was when GPS first locked; see handleSetupPosition and
	// finishRideSetup for how this seeds the ride-start heading.
	state.setupHeadingAnchor = null;

	// A map left over from a previous ride (finished or abandoned) would
	// otherwise be reused as-is: handleSetupPosition only creates a fresh one
	// when state.liveMap is empty, so its route/markers need clearing here.
	if (state.liveMap) {
		state.liveMap.remove();
		state.liveMap = null;
		state.liveRouteCoords = [];
		state.liveGuideCoords = [];
		state.liveGuideRouteMeters = null;
		state.markerLayer = null;
		state.guideLabelMarker = null;
		state.riderMarker = null;
		state.bestPaceChip = null;
		state.bestPaceBand = null;
	}

	// The last ride's routing, if its workers are somehow still around.
	resetRouteHome();
	resetRidePlan();
	hideDirections();

	el.screens.active.dataset.phase = "setup";
	setSetupLocating(true);
	// None unless the Routes screen's Ride button picked one.
	state.rideRoute = null;
	populateSetupRoutes();

	navigateToScreen("active");
	startSetupWatch();
}

/**
 * Toggles the setup UI between "Finding you" (still waiting for a GPS lock)
 * and "Location ready" (Start is now tappable).
 * @param {boolean} isLocating
 */
function setSetupLocating(isLocating) {
	el.setupLocatingLabel.textContent = isLocating ? "Finding you" : "Location ready";
	el.setupLocatingMessage.textContent = isLocating
		? "Getting your GPS lock — this can take a few seconds."
		: "Your location is set. Ready when you are.";
	el.setupStatusDot.classList.toggle("is-locating", isLocating);
	el.startActivityBtn.disabled = isLocating;
	el.startGpsHint.classList.toggle("hidden", !isLocating);
}

/** Starts (restarting if one is already running) the pre-ride GPS watch. */
function startSetupWatch() {
	stopSetupWatch();
	state.setupWatchId = navigator.geolocation.watchPosition(handleSetupPosition, handleSetupPositionError, {
		enableHighAccuracy: true,
		maximumAge: 0,
		timeout: 10000,
	});
}

/** Stops the pre-ride GPS watch, if one is running. */
function stopSetupWatch() {
	if (state.setupWatchId != null) {
		navigator.geolocation.clearWatch(state.setupWatchId);
		state.setupWatchId = null;
	}
}

/**
 * The pre-ride GPS watch's success callback: creates the live map on the
 * first fix (or just re-centers/moves the rider dot on later ones), and
 * marks the location as locked once the first fix lands. Keeps tracking
 * through every pre-ride phase (not just "setup"), so the map — and the
 * position `finishRideSetup` eventually hands to `startSession` — stay
 * current even while the rider moves during the countdown.
 *
 * @param {GeolocationPosition} position
 */
function handleSetupPosition(position) {
	// Keeps tracking through starting/countdown/revealing too, not just setup,
	// so the map (and the position finishRideSetup hands to startSession) stay
	// current even while the rider is moving during the countdown.
	if (!state.rideFlowPhase || state.rideFlowPhase === "active") return;
	state.setupPosition = position;

	const { latitude, longitude } = position.coords;
	if (!state.liveMap) {
		initLiveMap(latitude, longitude, { overhead: true });
	} else {
		animateMarkerTo(state.riderMarker, [longitude, latitude]);
		const map = state.liveMap;
		if (!map.isZooming() && !map.dragPan.isActive() && !map.touchZoomRotate.isActive()) {
			map.easeTo({ center: [longitude, latitude], duration: 450 });
		}
	}

	if (!state.setupLocked) {
		state.setupLocked = true;
		state.setupHeadingAnchor = { lat: latitude, lng: longitude };
		setSetupLocating(false);
	}
}

/**
 * The pre-ride GPS watch's error callback. Only a permission denial is
 * treated as fatal (aborts setup and sends the rider home with a message);
 * a timeout or transient "position unavailable" just leaves the rider on
 * the "Finding you" state, since `watchPosition` keeps retrying on its own.
 *
 * @param {GeolocationPositionError} error
 */
function handleSetupPositionError(error) {
	if (state.rideFlowPhase !== "setup") return;
	if (error.code === error.PERMISSION_DENIED) {
		abortRideSetup();
		navigateToScreen("home");
		showMessage("Location Needed", "Turn on location access to start a ride.");
	}
	// Any other error (timeout, position unavailable) just leaves the rider on
	// the "Finding you" state; watchPosition keeps retrying on its own.
}

// Stops the setup watch/countdown and drops the screen back to its ordinary,
// already-riding look. Used both by the explicit back button and by the
// popstate handler when the rider backs out mid-flow.
/**
 * Stops the setup GPS watch and any running countdown, and clears
 * `rideFlowPhase`/the screen's `data-phase`. Used both by the explicit back
 * button (`cancelSetupAndReturnHome`) and by the popstate handler in
 * navigation.js when the rider backs out of the flow via browser/gesture back.
 */
export function abortRideSetup() {
	stopSetupWatch();
	if (state.countdownIntervalId) {
		clearInterval(state.countdownIntervalId);
		state.countdownIntervalId = null;
	}
	state.rideFlowPhase = null;
	delete el.screens.active.dataset.phase;
}

/** The setup screen's back-button handler: aborts setup and returns home. */
export function cancelSetupAndReturnHome() {
	abortRideSetup();
	navigateToScreen("home");
}

/**
 * The "Start Activity" button's handler: requests device-orientation
 * permission up front for bike rides (iOS requires that request to
 * originate directly in a user gesture, which this is), then, after letting
 * the setup chrome slide away, begins the countdown.
 */
export function handleStartRideClick() {
	if (!state.setupLocked || state.rideFlowPhase !== "setup") return;

	if (state.selectedActivityType === "bike") requestOrientationPermission();

	state.rideFlowPhase = "starting";
	el.screens.active.dataset.phase = "starting";

	// Gives the setup bar and panel time to slide away before the bare
	// countdown number appears over the now-uncovered map.
	setTimeout(() => {
		if (state.rideFlowPhase !== "starting") return;
		beginCountdown();
	}, 480);
}

/**
 * Runs the on-screen countdown from `COUNTDOWN_SECONDS` to 0, switching to
 * the "revealing" phase (sliding the ride stats/controls into place) just
 * before the last tick, then hands off to `finishRideSetup`.
 */
function beginCountdown() {
	state.rideFlowPhase = "countdown";
	el.screens.active.dataset.phase = "countdown";

	let countdown = COUNTDOWN_SECONDS;
	el.countdownNumber.textContent = String(countdown);

	state.countdownIntervalId = setInterval(() => {
		countdown -= 1;

		if (countdown <= 0) {
			clearInterval(state.countdownIntervalId);
			state.countdownIntervalId = null;
			finishRideSetup();
			return;
		}

		el.countdownNumber.textContent = String(countdown);
		// The active screen's stats and controls slide into position while the
		// last couple of numbers keep counting down on top of them.
		if (countdown === 0) {
			state.rideFlowPhase = "revealing";
			el.screens.active.dataset.phase = "revealing";
		}
	}, 1000);
}

/**
 * Ends the countdown: stops the setup watch, tilts the map from the flat
 * pre-ride preview into the riding camera (rotating to the rider's heading
 * in the same motion, if one is already trustworthy — see below), and
 * starts the real ride using whatever position `handleSetupPosition` most
 * recently captured. Sends the rider home with a message if no position
 * ever came through.
 *
 * @returns {Promise<void>}
 */
async function finishRideSetup() {
	stopSetupWatch();
	const position = state.setupPosition;
	state.rideFlowPhase = "active";
	delete el.screens.active.dataset.phase;

	if (!position) {
		await showMessage("Location Lost", "We lost your location just before starting. Try again.");
		navigateToScreen("home");
		return;
	}

	// The pre-ride preview stays flat, north-up, and centred on whatever the
	// setup bar and panel left uncovered; now it tilts and reframes into the
	// riding camera, rotating to the rider's heading in the same motion
	// (rather than leaving that for a later, separate easeTo once a live fix
	// happens to cross the heading threshold — see followLiveMap) whenever
	// one can already be worked out: either straight from a trustworthy GPS
	// heading, or, since the phone rarely reports one this early, from how
	// far the rider has drifted from where GPS first locked during setup.
	const initialHeading = computeInitialHeading(position);

	if (state.liveMap) {
		const camera = { pitch: LIVE_MAP_PITCH, padding: ridePadding(state.liveMap), duration: 900 };
		if (initialHeading != null) camera.bearing = initialHeading;
		state.liveMap.easeTo(camera);
	}

	await startSession(position, initialHeading);
}

/**
 * Works out the best available heading at the exact moment the countdown
 * ends, so `finishRideSetup` can rotate the camera in the same motion as
 * its tilt instead of waiting on a later fix. Prefers the phone's own GPS
 * heading once it's moving fast enough to trust (mirrors the threshold
 * `updateLiveMap` uses); otherwise falls back to the bearing from where GPS
 * first locked during setup to now, if the rider has drifted far enough for
 * that to be meaningful rather than GPS jitter.
 *
 * @param {GeolocationPosition} position
 * @returns {number|null} Degrees, or `null` if neither source is trustworthy yet.
 */
function computeInitialHeading(position) {
	const { heading, speed, latitude, longitude } = position.coords;
	if (Number.isFinite(heading) && speed >= HEADING_GPS_MIN_SPEED_MPS) return heading;

	const anchor = state.setupHeadingAnchor;
	if (!anchor) return null;
	if (haversineMeters(anchor.lat, anchor.lng, latitude, longitude) < HEADING_MIN_MOVE_M) return null;
	return bearingDegrees(anchor.lat, anchor.lng, latitude, longitude);
}
