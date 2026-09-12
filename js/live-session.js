/**
 * The in-progress ride: starting/ending a session, the GPS watch and the
 * dead-reckoning bridge that carries it through short GPS outages, the
 * running distance/elevation/segment totals, pause/resume, and the
 * checkpoint save/restore that lets a ride survive a tab eviction or reload.
 */

import {
	GPS_OUTAGE_THRESHOLD_MS,
	DEAD_RECKONING_STEP_MS,
	MAX_DEAD_RECKONING_DRIFT_METERS,
	ACTIVE_SESSION_KEY,
	CHECKPOINT_INTERVAL_MS,
	POINT_REJECTION_THRESHOLD,
	LIVE_ROUTE_SOURCE,
} from "./constants.js";
import { state, el } from "./state.js";
import { haversineMeters, bearingDegrees, formatDistance, formatSpeed, formatDuration } from "./format.js";
import { getSegmentLengthMeters, segmentDistanceLabel, addSegmentMarkerToLayer, renderSegmentMarkers, distanceUnitLabel, speedUnitLabel } from "./map-visuals.js";
import { updateLiveMap, initLiveMap, setLiveLineData } from "./live-map.js";
import { loadPaceIndex, hideBestPace } from "./pace.js";
import { navigateToScreen } from "./navigation.js";
import { requestWakeLock, releaseWakeLock } from "./pwa.js";
import { confirmWithModal } from "./modal.js";
import { openPostSession } from "./post-session.js";
import { addSession, setPref, getPref } from "./db.js";
import { renderPastRides } from "./history-view.js";

/**
 * Starts a new ride: creates `state.currentSession`, requests the wake lock,
 * sets up the live map (unless the pre-ride setup flow already has one
 * live), builds the pace index, resets the GPS-outage/dead-reckoning sensor
 * state, records the first position, and starts the GPS watch, motion
 * sensors, and the stats-refresh interval.
 *
 * @param {GeolocationPosition} initialPosition - The position captured
 *   during pre-ride setup (see ride-setup.js), forced onto the route as the
 *   first point regardless of its accuracy.
 * @param {number|null} [initialHeading] - The heading `finishRideSetup`
 *   already rotated the camera to, if any, so the map doesn't get eased back
 *   to north the moment the first live fix lands — see `updateLiveMap`.
 * @returns {Promise<void>}
 */
export async function startSession(initialPosition, initialHeading = null) {
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
		// Seeded from finishRideSetup's own heading guess, if it had one, so the
		// first live fix's followLiveMap call reasserts the same bearing instead
		// of easing back to north and then rotating again once it's known.
		currentHeading: initialHeading ?? 0,
		// Where the heading was last set from; see HEADING_MIN_MOVE_M.
		headingAnchor: null,
	};

	await requestWakeLock();

	// The pre-ride setup already put us on the active screen with the map live
	// and centred on the rider; only a caller outside that flow needs this screen
	// switch and a fresh map.
	if (!state.liveMap) {
		navigateToScreen("active");
		initLiveMap(initialPosition.coords.latitude, initialPosition.coords.longitude);
	}
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

/** Starts the ride's GPS watch, routing every fix through `processPosition`. */
export function startWatch() {
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

/** Stops the ride's GPS watch and the motion sensors that ride alongside it. */
export function stopWatch() {
	const session = state.currentSession;
	if (session && session.watchId !== null) {
		navigator.geolocation.clearWatch(session.watchId);
		session.watchId = null;
	}
	stopMotionSensors();
}

/**
 * Starts listening for device-orientation events and the dead-reckoning
 * step timer used to bridge GPS outages. Dead reckoning only bridges bike
 * rides — at walking or paddling speeds a dropped fix costs so little
 * distance that inventing points would be a net loss. Idempotent: does
 * nothing if sensors are already active or the activity isn't "bike".
 */
export function initMotionSensors() {
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

/**
 * Tears down everything `initMotionSensors` set up: orientation listeners,
 * the GPS-outage timer, and the dead-reckoning step timer, and resets the
 * outage/estimate state. Called on pause and at the end of a ride.
 */
export function stopMotionSensors() {
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

/**
 * Requests iOS's device-orientation permission. Fire-and-forget by design —
 * iOS gates orientation events behind a grant that must originate directly
 * in a user gesture, so this runs straight off the Start button's click
 * handler rather than being awaited through any async setup.
 */
export function requestOrientationPermission() {
	// iOS gates orientation events behind a grant that must originate in a user
	// gesture, so this runs straight off the Start button and is not awaited.
	const OrientationEvent = window.DeviceOrientationEvent;
	if (typeof OrientationEvent?.requestPermission !== "function") return;
	OrientationEvent.requestPermission().catch((error) => {
		console.warn("Orientation permission unavailable", error);
	});
}

/**
 * `deviceorientation(absolute)` listener: updates `state.compassHeadingDegrees`
 * from whichever north-referenced heading the platform provides. Safari
 * exposes a true compass bearing directly via `webkitCompassHeading`;
 * elsewhere, `alpha` runs counter-clockwise from north and has to be
 * inverted to become a clockwise bearing. A relative (non-north-referenced)
 * `alpha` is discarded, since it isn't usable as a heading.
 *
 * @param {DeviceOrientationEvent & {webkitCompassHeading?: number}} event
 */
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

/**
 * The heading to dead-reckon along during a GPS outage. Prefers the recent
 * GPS travel bearing (between the last two real fixes) over the device
 * compass, since travel bearing measures where the rider is actually going,
 * not just where the handset happens to be pointing.
 *
 * @returns {number|null} Degrees, or `null` if neither source is available yet.
 */
function getDeadReckoningHeading() {
	// Travel bearing between the last two fixes is the better estimator: it
	// measures where the rider is going, not where the handset is pointing.
	if (state.travelHeadingDegrees != null) return state.travelHeadingDegrees;
	return state.compassHeadingDegrees;
}

/**
 * Updates `state.travelHeadingDegrees` from the bearing between the
 * session's last two recorded points, skipping updates from a near-zero
 * move (GPS jitter at a stop shouldn't spin the estimated heading around).
 *
 * @param {Object} session
 */
function updateTravelHeading(session) {
	const points = session.points;
	if (points.length < 2) return;
	const a = points[points.length - 2];
	const b = points[points.length - 1];
	if (haversineMeters(a.lat, a.lng, b.lat, b.lng) < 2) return;
	state.travelHeadingDegrees = bearingDegrees(a.lat, a.lng, b.lat, b.lng);
}

/**
 * Resets the GPS-outage watchdog timer on every real fix. If no fix arrives
 * within `GPS_OUTAGE_THRESHOLD_MS`, flags an outage and starts dead
 * reckoning. A no-op unless motion sensors are active (dead reckoning only
 * applies to bike rides — see `initMotionSensors`).
 *
 * @param {number} timestamp - The fix's timestamp, in epoch ms.
 */
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

/**
 * Seeds `state.velocityEstimate` from the last known GPS speed when an
 * outage begins, so dead reckoning carries the rider's actual pace through
 * the gap rather than starting from zero.
 */
function beginDeadReckoning() {
	const session = state.currentSession;
	if (!session || !session.lastPoint) return;

	// Carry the last known GPS speed through the gap.
	state.velocityEstimate = session.lastPoint.speed || 0;
}

/**
 * Projects one dead-reckoning step forward from `origin` along a heading, at
 * a given speed, using an equirectangular (flat-earth) approximation — fine
 * over the few-hundred-meter scale a GPS outage typically spans.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {number} headingDegrees
 * @param {number} velocity - Meters/second.
 * @param {number} timeDeltaSeconds - Duration of this step.
 * @returns {{lat: number, lng: number, timestamp: number}}
 */
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

/**
 * Called when GPS resumes after a detected outage: if the dead-reckoned
 * path's endpoint is close enough to the real resumed fix (within
 * `MAX_DEAD_RECKONING_DRIFT_METERS`), splices the estimated points into the
 * session as real (if `estimated: true`-flagged) points, advancing
 * `totalDistance` and `lastPoint` along the way. If the drift is too large,
 * the estimated stretch is discarded entirely and `processPosition` measures
 * a single direct leg from the last real point to the resumed one instead.
 *
 * @param {{lat: number, lng: number}} resumedGPSPoint - The first real fix
 *   after the outage.
 */
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

/**
 * Debug "data saver" support: decides whether a new point is redundant
 * enough with the last two recorded points to overwrite the most recent one
 * instead of appending — used by `processPosition` when the `dataSaver`
 * preference is on, to shrink storage for a ride with a lot of near-stationary
 * GPS noise (e.g. sitting at a long light).
 *
 * A point is rejected either when the last three points (new + previous two)
 * all fit inside a circle smaller than `POINT_REJECTION_THRESHOLD`, or when
 * it lies almost exactly on the line from the second-to-last point through
 * the new point (i.e. the previous point added no new information about the
 * path's shape).
 *
 * @param {{lat: number, lng: number}} point - The candidate new point (not
 *   yet appended to `state.currentSession.points`).
 * @returns {boolean} `true` if the caller should overwrite the last stored
 *   point with `point` rather than pushing a new one.
 */
function determinePointRejection(point) {
	var l = state.currentSession.points.length;

	// we can't reject an intermediate point unless there are at least 3 points to compare
	if (l<=2) return false;

	// Are all the points inside a circle that's smaller than the rejection radius?
	var centerLat = (point.lat + state.currentSession.points[l-1].lat + state.currentSession.points[l-2].lat)/3.0;
	var centerLng = (point.lng + state.currentSession.points[l-1].lng + state.currentSession.points[l-2].lng)/3.0;

	if (haversineMeters(centerLat, centerLng, point.lat, point.lng)<=POINT_REJECTION_THRESHOLD &&
		haversineMeters(centerLat, centerLng, state.currentSession.points[l-1].lat, state.currentSession.points[l-2]) <= POINT_REJECTION_THRESHOLD &&
		haversineMeters(centerLat, centerLng, state.currentSession.points[l-2].lat, state.currentSession.points[l-2].lng) <= POINT_REJECTION_THRESHOLD) {
		// console.log("rejecting point: within rejection radius");
		return true;
	}

	// if the first and last point are the same but the intermediate point is wonky, let's just assume that
	// there's something unpredictable about the data and store the extra point just in case
	var d = {
		lat: point.lat - state.currentSession.points[l-2].lat,
		lng: point.lng - state.currentSession.points[l-2].lng
	};
	if (d.lat == 0 && d.lng == 0) return false;

	// assume a line going from state.currentSession.points[l-2] to point defined as state.currentSession.points[l-2] + d*t;
	// Find the point on the line that's closest to the line
	var a = state.currentSession.points[l-2];
	var b = state.currentSession.points[l-1];
	var t = -((d.lat*(a.lat - b.lat) + d.lng*(a.lng-b.lng))/(d.lng*d.lng + d.lat*d.lat));
	var nearestPoint = {
		lat: a.lat + d.lat*t,
		lng: a.lng + d.lng*t
	};
	// if the distance from the previous point to what would be the interpolated point is below
	// the threshold, then we will reject the point
	var distanceToLine = haversineMeters(b.lat, b.lng, nearestPoint.lat, nearestPoint.lng);
	if (distanceToLine < POINT_REJECTION_THRESHOLD) {
		// console.log("rejecting point: along the interpolated line");
		return true;
	}

	// by default, keep all data
	return false;

}

/**
 * The GPS watch's per-fix handler and the app's single busiest function:
 * filters by accuracy, resolves any pending dead-reckoning outage, updates
 * distance/speed/heading/elevation/segment/checkpoint bookkeeping, and
 * pushes the fix through to the live map and stats display.
 *
 * @param {GeolocationPosition} position
 * @param {boolean} [forceAdd] - Skips the accuracy filter (`accuracy == null
 *   || accuracy > 20` meters is normally rejected). Used for the very first
 *   fix of a ride, which must be recorded even if it's a little noisy.
 */
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

	// determine if we can get rid of the previous point to save on storage space
	if (state.prefs.dataSaver && determinePointRejection(point) == true) {
		session.points[session.points.length-1] = point;
	} else {
		session.points.push(point);
	}
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

/**
 * Folds a new raw altitude reading into the session's elevation gain/drop
 * totals. Smooths over a trailing window of up to 5 samples before
 * comparing to the previous smoothed value, so GPS altitude jitter doesn't
 * get double-counted as repeated small climbs and drops.
 *
 * @param {number} rawAltitude - Meters; ignored if non-finite (no altitude
 *   reading on this fix).
 */
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

/**
 * Checks whether the ride has crossed one or more segment (mile/km)
 * boundaries since the last point, and if so records each crossed segment's
 * duration/average speed and drops a distance-marker flag on the live map at
 * the crossing point. A `while` loop (not `if`) so a burst of distance
 * between two fixes that spans multiple segment lengths is still handled
 * correctly.
 *
 * @param {{lat: number, lng: number}} point - The point that (maybe) crossed
 *   a boundary.
 */
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

/**
 * Refreshes the ride strip's live numbers (current speed, distance, average
 * speed, elapsed time) from the current session state. Also recomputes
 * `session.avgSpeed` as distance over moving time — the same definition the
 * saved ride summary uses, so the two never disagree. Called on every fix
 * and on the 500ms display-refresh interval (so elapsed time keeps ticking
 * between fixes).
 */
export function updateLiveStats() {
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

/**
 * Updates the pause button and ride strip's paused/unpaused visual state.
 * @param {boolean} paused
 */
export function setPauseButton(paused) {
	el.pauseBtn.classList.toggle("is-paused", paused);
	el.pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
	el.rideStrip.classList.toggle("is-paused", paused);
	el.speedLabel.textContent = paused ? "Paused" : "Speed";
}

/**
 * The ride's elapsed moving time right now.
 *
 * @returns {number} Milliseconds: `session.movingTime` while paused (frozen
 *   at the moment of pausing), otherwise `movingTime` plus time since the
 *   last resume. `0` if there's no current session.
 */
export function getElapsedMs() {
	const session = state.currentSession;
	if (!session) return 0;
	if (session.paused) return session.movingTime;
	return session.movingTime + (Date.now() - session.resumeTimestamp);
}

/**
 * The pause/resume button's handler. Pausing freezes `movingTime`, stops the
 * GPS watch, hides the best-pace overlay, releases the wake lock, and
 * checkpoints the ride immediately (a pause is a natural moment the rider
 * might background or close the app). Resuming restarts the clock from now,
 * closes out the pause interval, and restarts the watch/sensors/wake lock.
 *
 * @returns {Promise<void>}
 */
export async function togglePauseSession() {
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
/**
 * Closes out the currently-open pause interval (if any) by recording it in
 * `session.pauses` and clearing `pauseStartedAt`. Called both on resume and
 * again at finalize, so a ride that ends while paused still stores a closed
 * interval rather than one with no end.
 *
 * @param {Object} session
 * @param {number} [endedAt] - Epoch ms; defaults to now.
 */
function closeOpenPause(session, endedAt = Date.now()) {
	if (!session || session.pauseStartedAt == null) return;
	if (!Array.isArray(session.pauses)) session.pauses = [];
	if (endedAt > session.pauseStartedAt) {
		session.pauses.push({ start: session.pauseStartedAt, end: endedAt });
	}
	session.pauseStartedAt = null;
}

/**
 * The "Stop" button's handler: confirms with the rider, then finalizes and
 * opens the ride's summary screen.
 *
 * @returns {Promise<void>}
 */
export async function endSessionWithConfirm() {
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

/**
 * Ends the current ride: freezes the moving-time clock, closes any open
 * pause, stops the watch/timers, releases the wake lock, saves the ride to
 * IndexedDB, clears the in-progress checkpoint, and clears
 * `state.currentSession`. Used both by the normal "Stop" flow and by the
 * unfinished-ride-recovery flow in `maybeRecoverSession`.
 *
 * @returns {Promise<Object|null>} The saved session record (with its new
 *   `id`), or `null` if there was no current session to finalize.
 */
export async function finalizeSession() {
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
	state.rideFlowPhase = null;
	setPauseButton(false);
	return saved;
}

/**
 * Persists the in-progress ride to IndexedDB as a recovery checkpoint, so it
 * can be resumed (or salvaged) if the tab is evicted or the app is reloaded
 * mid-ride. Called periodically from `processPosition` and explicitly on
 * pause/backgrounding. Failures are logged, not surfaced — a missed
 * checkpoint isn't worth interrupting the ride over.
 *
 * @returns {Promise<void>}
 */
export async function saveActiveSessionCheckpoint() {
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

/**
 * Clears the persisted in-progress-ride checkpoint (there is none once a
 * ride is finalized, or once recovery has dealt with a stale one).
 *
 * @returns {Promise<void>}
 */
export async function clearActiveSessionCheckpoint() {
	try {
		await setPref(ACTIVE_SESSION_KEY, null);
	} catch (error) {
		console.warn("Clearing ride checkpoint failed", error);
	}
}

/**
 * Rebuilds a live-session-shaped object from a persisted checkpoint, ready
 * to install as `state.currentSession` and resume tracking on. The
 * interrupted stretch (between the checkpoint and now) is recorded as an
 * extra pause interval — `resumeTimestamp` below restarts the clock, which
 * already excludes that stretch from moving time, but without recording it
 * as a pause too the segment table would otherwise charge the whole
 * interruption to whichever segment was in progress.
 *
 * @param {Object} checkpoint - As saved by `saveActiveSessionCheckpoint`.
 * @returns {Object} A session object suitable for `state.currentSession`.
 */
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
		// Where the heading was last set from; see HEADING_MIN_MOVE_M.
		headingAnchor: null,
	};
}

/**
 * Called once during `init()`: checks for a leftover in-progress-ride
 * checkpoint (from a tab eviction or crash) and, if one is found with at
 * least two recorded points, asks the rider whether to resume it or save it
 * as-is and view the summary. A checkpoint with fewer than 2 points is
 * discarded silently — not enough of a ride to offer back.
 *
 * @returns {Promise<void>}
 */
export async function maybeRecoverSession() {
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

/**
 * Puts a restored checkpoint back into live tracking: installs it as
 * `state.currentSession`, resets the GPS-outage/dead-reckoning sensor state,
 * rebuilds the live map (centred on the last known point) with the route
 * and segment markers already drawn, rebuilds the pace index, and restarts
 * the watch/sensors/wake lock/stats interval.
 *
 * @param {Object} restored - From `restoreSessionFromCheckpoint`.
 * @returns {Promise<void>}
 */
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
