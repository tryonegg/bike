/**
 * Turn-by-turn directions during a ride: the banner under the ride stats
 * (the next turn, how far to it, and how far the next stop is, or the
 * route's end, tapped between), spoken prompts (voice.js), and the sheet the
 * banner's close button opens (skip the next stop, cancel the route, or
 * keep going).
 *
 * Directions follow the ride's planned route (ride-plan.js) while one is
 * being followed, and otherwise the route home (route-home.js) once the
 * rider is well away from the start, each only when its settings allow:
 * `navRouteVisual`/`navRouteVoice` and `navHomeVisual`/`navHomeVoice` (the
 * latter only with Back to Start set to Route).
 *
 * The guidance both give is {steps, along, offRoute, target, following,
 * stopsLeft, canSkip}: steps (route-steps.js) each with `along`, the meters
 * along the route in the same reckoning as the rider's own `along`.
 */

import {
	NAV_EARLY_S,
	NAV_EARLY_MIN_M,
	NAV_EARLY_MAX_M,
	NAV_NOW_M,
	NAV_THEN_M,
	NAV_TURN_AROUND_DEG,
	NAV_TURN_AROUND_MIN_SPEED_MPS,
	NAV_REROUTE_SPEAK_MS,
	NAV_FOLLOWING_M,
	NAV_HOME_AWAY_M,
	PLAN_ARRIVE_M,
	METERS_PER_MILE,
	FEET_PER_METER,
} from "./constants.js";
import { state, el } from "./state.js";
import { haversineMeters, bearingDegrees } from "./format.js";
import { ridePlanGuidance, skipNextPoint, cancelRideRoute } from "./ride-plan.js";
import { latestRouteHome } from "./route-home.js";
import { say } from "./voice.js";
import { getElapsedMs } from "./live-session.js";

// Line icons for each turn, drawn in a 24-unit box.
const ICONS = {
	left: '<path d="M17 20v-8a4 4 0 0 0-4-4H5"/><path d="m9 4-4 4 4 4"/>',
	right: '<path d="M7 20v-8a4 4 0 0 1 4-4h8"/><path d="m15 4 4 4-4 4"/>',
	"slight-left": '<path d="M16 20v-7L8 5"/><path d="M14 5H8v6"/>',
	"slight-right": '<path d="M8 20v-7l8-8"/><path d="M10 5h6v6"/>',
	"sharp-left": '<path d="M16 20V6"/><path d="m16 6-9 9"/><path d="M7 9v6h6"/>',
	"sharp-right": '<path d="M8 20V6"/><path d="m8 6 9 9"/><path d="M17 9v6h-6"/>',
	uturn: '<path d="M16 20V9a4 4 0 0 0-8 0v7"/><path d="m4 13 4 4 4-4"/>',
	straight: '<path d="M12 20V4"/><path d="m6 10 6-6 6 6"/>',
	arrive: '<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>',
	reroute: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
	skip: '<path d="m5 6 6 6-6 6"/><path d="m13 6 6 6-6 6"/>',
	cancel: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
};

const TURN_WORDS = {
	left: "Turn left",
	right: "Turn right",
	"slight-left": "Bear left",
	"slight-right": "Bear right",
	"sharp-left": "Sharp left",
	"sharp-right": "Sharp right",
	uturn: "Make a U-turn",
};

// Each turn as it's spoken, mid-sentence.
const SPOKEN_TURNS = {
	left: "turn left",
	right: "turn right",
	"slight-left": "bear left",
	"slight-right": "bear right",
	"sharp-left": "make a sharp left",
	"sharp-right": "make a sharp right",
	uturn: "make a U-turn",
};

// Riding speeds to estimate time to the next stop with, in m/s, until the
// ride's own average is worth trusting.
const DEFAULT_SPEED_MPS = { bike: 4.5, kayak: 1.5 };
const DEFAULT_FOOT_SPEED_MPS = 1.3;
const TURN_AROUND_SPEAK_MS = 120000;

let redraw = null;
// What's been said and seen this ride, so nothing's said twice. Reset when
// a new ride (session) starts.
let memory = null;
// What the sheet is offering, while it's open.
let sheetFor = null;
// Whether the banner's stop button shows the route's end rather than the
// next stop. Kept from ride to ride, as a rider's preference.
let showFinish = false;
// The last view drawn, to redraw straight away when that's tapped.
let lastView = null;

/**
 * Registers how to redraw the ride map and directions straight away (after
 * skipping a stop or cancelling a route). Set by live-map.js.
 * @param {() => void} fn
 */
export function setDirectionsRedraw(fn) {
	redraw = fn;
}

/** Wires up the banner's close button and the sheet. Called once from `wireEvents`. */
export function wireDirections() {
	el.navCloseBtn.addEventListener("click", openSheet);
	el.navStopBtn.addEventListener("click", () => {
		showFinish = !showFinish;
		if (lastView) render(lastView);
	});
	el.navKeepBtn.addEventListener("click", closeSheet);
	el.navSheet.addEventListener("click", (event) => {
		if (event.target === el.navSheet) closeSheet();
	});
	el.navSkipBtn.addEventListener("click", () => {
		const session = state.currentSession;
		if (session) {
			skipNextPoint(session);
			if (memory) memory.skipped = true;
			if (sheetFor?.voice) say("Skipping to the next point.");
		}
		closeSheet();
		redraw?.();
	});
	el.navCancelBtn.addEventListener("click", () => {
		const session = state.currentSession;
		if (session && sheetFor?.kind === "route") cancelRideRoute(session);
		if (session && sheetFor?.kind === "home") session.homeDirectionsOff = true;
		if (sheetFor?.voice) say("Directions stopped.");
		closeSheet();
		redraw?.();
	});
}

/**
 * Brings directions up to date for the rider at `point`: which guidance
 * applies, the banner, and anything that needs saying. Called on every fix,
 * whenever a route arrives, and when a directions setting changes.
 *
 * @param {{lat: number, lng: number, speed?: number}} [point] - The rider;
 *   defaults to the ride's latest fix.
 */
export function updateDirections(point = state.currentSession?.lastPoint) {
	const session = state.currentSession;
	if (!session || !point) {
		hideDirections();
		return;
	}
	if (memory?.session !== session) memory = freshMemory(session);

	const source = activeGuidance(session, point);
	listenForArrivals(session, source);
	if (!source) {
		el.navBanner.hidden = true;
		el.navTurnFlash.hidden = true;
		return;
	}

	const view = describe(source, session, point);
	if (source.voice) speakFor(source, view);
	el.navBanner.hidden = !source.visual;
	if (source.visual) render(view);
	renderTurnFlash(source.visual ? view : null);
	if (sheetFor) fillSheet(source);
}

/** Hides the banner and sheet: no ride, or a new one starting. */
export function hideDirections() {
	el.navBanner.hidden = true;
	el.navTurnFlash.hidden = true;
	closeSheet();
	memory = null;
	lastView = null;
}

function freshMemory(session) {
	return {
		session,
		spoken: new Map(),
		nextWaypoint: session.nextWaypoint ?? 0,
		routeFinished: false,
		skipped: false,
		offRoute: false,
		lastRerouteSpokenAt: 0,
		lastTurnAroundSpokenAt: 0,
		homeArrived: false,
		homeAway: false,
		followedAlong: 0,
	};
}

/**
 * Which guidance applies: the planned route while it's being followed and
 * its directions are on, else the route home once the rider is well away
 * from the start and those directions are on, else none.
 */
function activeGuidance(session, point) {
	const prefs = state.prefs;
	const plan = ridePlanGuidance();
	if (plan && !plan.finished && (prefs.navRouteVisual || prefs.navRouteVoice)) {
		return { kind: "route", guidance: plan, visual: prefs.navRouteVisual, voice: prefs.navRouteVoice, live: plan.canSkip };
	}

	const homeOn = prefs.backToStart === "route" && (prefs.navHomeVisual || prefs.navHomeVoice);
	if (!homeOn || session.homeDirectionsOff || session.activityType === "kayak") return null;
	const start = session.points[0];
	const fromStart = start ? haversineMeters(point.lat, point.lng, start.lat, start.lng) : 0;
	if (fromStart >= NAV_HOME_AWAY_M) memory.homeAway = true;
	const home = latestRouteHome();
	if (!memory.homeAway || !home) return null;
	return {
		kind: "home",
		guidance: {
			steps: home.steps,
			along: home.along,
			offRoute: home.offRoute,
			target: { label: "Start", meters: home.meters, point: [start.lng, start.lat] },
			following: null,
			stopsLeft: null,
			canSkip: false,
		},
		visual: prefs.navHomeVisual,
		voice: prefs.navHomeVoice,
		live: true,
	};
}

/**
 * Works out what the banner says: the next step (or turning around, or
 * rerouting), how far to it, how far along towards it the rider is, the
 * step after, and the next stop.
 */
function describe(source, session, point) {
	const { guidance } = source;
	const steps = guidance.steps ?? [];
	const along = guidance.along ?? 0;
	const nextIndex = steps.findIndex((step) => step.along > along + 1);
	const next = nextIndex >= 0 ? steps[nextIndex] : null;
	const after = next && next.turn !== "arrive" ? steps[nextIndex + 1] : null;
	const previousAlong = nextIndex > 0 ? steps[nextIndex - 1].along : 0;

	const view = {
		step: next,
		after,
		distance: next ? next.along - along : guidance.target.meters,
		progress: next ? clamp((along - previousAlong) / Math.max(1, next.along - previousAlong)) : 0,
		icon: next ? (next.turn === "arrive" ? "arrive" : next.turn) : "straight",
		instruction: next ? instructionFor(next, source) : `Head to ${targetName(source)}`,
		turnAround: false,
		offRoute: guidance.offRoute,
		target: guidance.target,
		finish: guidance.finish && guidance.stopsLeft > 1 ? guidance.finish : null,
		kind: source.kind,
		eta: etaFor(guidance.target.meters, session),
	};

	if (guidance.offRoute) {
		view.icon = "reroute";
		view.instruction = source.live ? "Rerouting…" : "Return to the route";
		view.step = null;
		view.after = null;
	} else if (headingAway(source, point)) {
		view.turnAround = true;
		view.icon = "uturn";
		view.instruction = "Turn around";
	}
	return view;
}

/** Whether the rider is riding away from the way the route goes from them. */
function headingAway(source, point) {
	const speed = point.speed ?? 0;
	if (speed < NAV_TURN_AROUND_MIN_SPEED_MPS) return false;
	const heading = state.currentSession?.currentHeading;
	const toward = routeDirectionFrom(source);
	if (!Number.isFinite(heading) || toward === null) return false;
	const off = Math.abs(((toward - heading + 540) % 360) - 180);
	return off > NAV_TURN_AROUND_DEG;
}

/** The compass direction the route heads in from the rider: toward the next step, or the target. */
function routeDirectionFrom(source) {
	const session = state.currentSession;
	const rider = session?.lastPoint;
	if (!rider) return null;
	const { guidance } = source;
	const next = (guidance.steps ?? []).find((step) => step.along > (guidance.along ?? 0) + 1);
	const toward = next?.point ?? guidance.target.point;
	if (!toward) return null;
	// Too close to tell a direction from.
	if (haversineMeters(rider.lat, rider.lng, toward[1], toward[0]) < 25) return null;
	return bearingDegrees(rider.lat, rider.lng, toward[1], toward[0]);
}

function instructionFor(step, source) {
	if (step.turn === "arrive") return `Arrive at ${targetName(source)}`;
	const way = step.name ?? (step.kind ? `the ${step.kind}` : null);
	if (!way) return TURN_WORDS[step.turn];
	return `${TURN_WORDS[step.turn]} ${step.stay ? "to stay on" : "onto"} ${way}`;
}

function targetName(source) {
	const label = source.guidance.target.label;
	if (label === "Start") return "the start";
	if (label === "End of route") return "the end of the route";
	if (label === "Destination") return "your destination";
	return label;
}

/** The time to ride `meters` at the ride's average so far (or a typical pace until that's known). */
function etaFor(meters, session) {
	return meters / paceFor(session);
}

/** The ride's average speed so far, in m/s, or a typical pace until that's known. */
function paceFor(session) {
	const movingSeconds = getElapsedMs() / 1000;
	const average = movingSeconds > 60 ? session.totalDistance / movingSeconds : 0;
	const fallback = DEFAULT_SPEED_MPS[session.activityType] ?? DEFAULT_FOOT_SPEED_MPS;
	return average > 1 ? average : fallback;
}

function clamp(value) {
	return Math.max(0, Math.min(1, value));
}

// ---- Banner ----

function render(view) {
	const [value, unit] = formatNavDistance(view.distance);
	el.navIcon.innerHTML = iconSvg(view.icon);
	el.navDistance.textContent = view.offRoute || view.turnAround ? "" : value;
	el.navDistanceUnit.textContent = view.offRoute || view.turnAround ? "" : unit;
	el.navInstruction.textContent = view.instruction;
	el.navProgress.style.width = `${Math.round(view.progress * 100)}%`;

	// The next stop, or (tapped) the route's end, when there are stops before it.
	const finish = showFinish && view.finish;
	const meters = finish ? view.finish.meters : view.target.meters;
	const [stopValue, stopUnit] = formatNavDistance(meters);
	el.navStopLabel.textContent = finish ? "Route end" : stopLabel(view);
	el.navStopDistance.innerHTML = `${stopValue} <span class="nav-unit">${stopUnit}</span>`;
	el.navStopBtn.disabled = !view.finish;
	el.navStopBtn.classList.toggle("can-swap", Boolean(view.finish));
	const eta = formatEta(finish ? etaFor(meters, state.currentSession) : view.eta);
	el.navStopBtn.setAttribute(
		"aria-label",
		`${el.navStopLabel.textContent}: ${stopValue} ${stopUnit}, about ${eta}${view.finish ? `. Tap to show ${finish ? "the next stop" : "the route end"}` : ""}`,
	);
	lastView = view;
}

/**
 * The big turn arrow over the ride stats and banner, shown while the rider
 * is within NAV_NOW_M of a turn (when the last prompt for it is spoken), and
 * gone once it's made.
 * @param {Object|null} view - From `describe`, or null to hide it.
 */
function renderTurnFlash(view) {
	const step = view?.step;
	const show = Boolean(step) && step.turn !== "arrive" && !view.offRoute && !view.turnAround && view.distance <= NAV_NOW_M;
	el.navTurnFlash.hidden = !show;
	if (!show) return;
	el.navTurnFlashIcon.innerHTML = iconSvg(step.turn);
	el.navTurnFlashText.textContent = TURN_WORDS[step.turn];
}

/** What the stop button calls the target when it's the only one left. */
function stopLabel(view) {
	if (view.finish) return "Next stop";
	if (view.kind === "home") return "To start";
	if (view.target.label === "Destination") return "Destination";
	return "Route end";
}

function iconSvg(name) {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.straight}</svg>`;
}

/**
 * A distance for directions: feet (to the nearest 50, or 10 when close) up
 * to about a fifth of a mile, then miles to a tenth; or meters, then km.
 * @returns {[string, string]} Value and unit.
 */
export function formatNavDistance(meters) {
	const m = Math.max(0, meters);
	// Rounded first, so a distance that rounds up to 1000 ft (or m) reads in miles (or km).
	const rounded = (value, fine) => Math.round(value / (value < fine ? 10 : 50)) * (value < fine ? 10 : 50);
	if (state.prefs.unit === "imperial") {
		const feet = rounded(m * FEET_PER_METER, 100);
		if (feet < 1000) return [String(feet), "ft"];
		const miles = m / METERS_PER_MILE;
		return [miles < 10 ? miles.toFixed(1) : String(Math.round(miles)), "mi"];
	}
	if (rounded(m, 200) < 1000) return [String(rounded(m, 200)), "m"];
	const km = m / 1000;
	return [km < 10 ? km.toFixed(1) : String(Math.round(km)), "km"];
}

function formatEta(seconds) {
	const minutes = Math.round(seconds / 60);
	if (minutes < 1) return "<1 min";
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ---- Voice ----

/**
 * Says what's due: each turn about NAV_EARLY_S ahead, with its distance
 * and street, and again as it's time to turn (a turn close behind each
 * chained on), "rerouting" when the rider leaves a route they'd been
 * following, "off route" for a route followed as is, and "turn around" when
 * heading away from a planned route.
 */
function speakFor(source, view) {
	const now = Date.now();
	const guidance = source.guidance;
	if (!view.offRoute) memory.followedAlong = Math.max(memory.followedAlong, guidance.along ?? 0);

	if (view.offRoute) {
		if (!memory.offRoute && memory.followedAlong >= NAV_FOLLOWING_M && now - memory.lastRerouteSpokenAt > NAV_REROUTE_SPEAK_MS) {
			say(source.live ? "Rerouting." : "You're off the route.");
			memory.lastRerouteSpokenAt = now;
		}
		memory.offRoute = true;
		return;
	}
	if (memory.offRoute) {
		memory.offRoute = false;
		// A new route: progress along it starts again.
		memory.followedAlong = 0;
	}

	if (view.turnAround) {
		// Riding out, the way home is always behind; only a planned route asks.
		if (source.kind === "route" && now - memory.lastTurnAroundSpokenAt > TURN_AROUND_SPEAK_MS) {
			say("Turn around when you can.");
			memory.lastTurnAroundSpokenAt = now;
		}
		return;
	}

	const step = view.step;
	if (!step || step.turn === "arrive") return;
	// Two prompts a turn at most: about NAV_EARLY_S ahead, and as it's time to turn.
	const atTurn = view.distance <= NAV_NOW_M;
	if (!atTurn && view.distance > earlyMeters(state.currentSession)) return;
	const stage = atTurn ? 1 : 0;
	const key = `${step.turn}@${step.point[0].toFixed(4)},${step.point[1].toFixed(4)}`;
	if ((memory.spoken.get(key) ?? -1) >= stage) return;
	memory.spoken.set(key, stage);

	// At the turn itself it's just the turn: "Turn right."
	let text = atTurn ? spokenTurn(step, false) : `in ${spokenDistance(view.distance)}, ${spokenTurn(step, true)}`;
	const after = view.after;
	if (after && after.turn !== "arrive" && after.along - step.along <= NAV_THEN_M) {
		text += `, then ${spokenTurn(after, !atTurn)}`;
	}
	say(sentence(text));
}

/**
 * How far ahead a turn is first announced: NAV_EARLY_S at the rider's
 * current speed (or the ride's average, or a typical pace, when stopped or
 * unknown).
 */
function earlyMeters(session) {
	const speed = session.lastPoint?.speed ?? 0;
	const pace = speed >= 1 ? speed : paceFor(session);
	return Math.min(NAV_EARLY_MAX_M, Math.max(NAV_EARLY_MIN_M, pace * NAV_EARLY_S));
}

/** A distance as spoken: "200 feet", "0.2 miles". */
function spokenDistance(meters) {
	const [value, unit] = formatNavDistance(meters);
	const words = { ft: "feet", mi: "miles", m: "meters", km: "kilometers" };
	return `${value} ${words[unit] ?? unit}`;
}

/**
 * A turn in words, with the street it's onto when that's known and wanted:
 * "turn right onto Main Street".
 */
function spokenTurn(step, withStreet) {
	const turn = SPOKEN_TURNS[step.turn];
	const way = withStreet ? (step.name ?? (step.kind ? `the ${step.kind}` : null)) : null;
	return way ? `${turn} ${step.stay ? "to stay on" : "onto"} ${way}` : turn;
}

/** Capitalized, with a full stop. */
function sentence(text) {
	const trimmed = text.trim().replace(/[,.]$/, "");
	return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

/**
 * Notices arrivals, to say them: a planned route's next point reached (not
 * skipped) or its end, and getting back to the start.
 */
function listenForArrivals(session, source) {
	const voiceRoute = state.prefs.navRouteVoice;
	const plan = ridePlanGuidance();
	const next = session.nextWaypoint ?? 0;
	// A stop skipped from the sheet wasn't reached, and skipping the last one
	// isn't finishing the route either.
	const skipped = memory.skipped && next > memory.nextWaypoint;
	if (next > memory.nextWaypoint) {
		memory.skipped = false;
		if (!skipped && voiceRoute && !plan?.finished) say(`You've reached point ${next}.`);
	}
	memory.nextWaypoint = next;

	if (plan?.finished && !memory.routeFinished) {
		memory.routeFinished = true;
		if (voiceRoute && !skipped && !session.routeCancelled) say(plan.destination ? "You've arrived at your destination." : "You've reached the end of your route.");
	}

	if (source?.kind === "home") {
		const meters = source.guidance.target.meters;
		if (meters <= PLAN_ARRIVE_M && !memory.homeArrived) {
			memory.homeArrived = true;
			if (source.voice) say("You're back at the start.");
		} else if (meters > NAV_HOME_AWAY_M) {
			memory.homeArrived = false;
		}
	}
}

// ---- Sheet ----

function openSheet() {
	const session = state.currentSession;
	if (!session) return;
	const source = activeGuidance(session, session.lastPoint ?? {});
	if (!source) return;
	fillSheet(source);
	el.navSheet.hidden = false;
}

/** Fills the sheet in for what's being followed: skipping and cancelling a route, or stopping directions home. */
function fillSheet(source) {
	sheetFor = { kind: source.kind, voice: source.voice };
	const guidance = source.guidance;
	const canSkip = source.kind === "route" && guidance.canSkip && guidance.stopsLeft >= 1;
	el.navSkipBtn.hidden = !canSkip;
	if (canSkip) {
		const [value, unit] = formatNavDistance(guidance.target.meters);
		el.navSkipDetail.textContent = `${guidance.target.label} · ${value} ${unit} away`;
		el.navSkipNext.textContent = guidance.following ?? "Route end";
	}
	if (source.kind === "route") {
		el.navCancelTitle.textContent = guidance.destination ? "Cancel destination" : "Cancel entire route";
		el.navCancelDetail.textContent = guidance.destination
			? "Stops directions to it for this ride"
			: guidance.stopsLeft != null
				? `Clears ${guidance.stopsLeft === 1 ? "the last remaining stop" : `all ${guidance.stopsLeft} remaining stops`}`
				: "Stops following this route";
	} else {
		el.navCancelTitle.textContent = "Stop directions home";
		el.navCancelDetail.textContent = "For the rest of this ride";
	}
	for (const [target, name] of [
		[el.navSkipIcon, "skip"],
		[el.navCancelIcon, "cancel"],
	]) {
		target.innerHTML = iconSvg(name);
	}
}

function closeSheet() {
	el.navSheet.hidden = true;
	sheetFor = null;
}
