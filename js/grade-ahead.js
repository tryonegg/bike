/**
 * The grade ahead on the live ride screen: while following a route (or
 * directions back to the start), the next stretch of it is measured from
 * the terrain tiles (terrain.js), and when a climb or descent is coming up,
 * or the rider's on one, its profile shows in a strip at the bottom of the
 * screen, colored by grade as the planner's Grades overlay colors roads
 * (grade-map.js), with how steep it is, how far off, and how long.
 *
 * Without a line to follow there's no knowing which way the rider will go,
 * so nothing's shown; the grade chip (grade.js) still gives the grade
 * underfoot.
 */

import {
	GRADE_AHEAD_M,
	GRADE_AHEAD_STEP_M,
	GRADE_AHEAD_SHOW_M,
	GRADE_AHEAD_MIN_RUN_M,
	GRADE_AHEAD_REFRESH_M,
	GRADE_SHOW,
	GRADE_MODERATE,
	ROUTE_OFF_ROUTE_M,
} from "./constants.js";
import { state, el } from "./state.js";
import { haversineMeters } from "./format.js";
import { heightAt } from "./terrain.js";
import { createLineTracker } from "./route-follow.js";
import { gradeColor } from "./grade-map.js";
import { formatNavDistance } from "./directions.js";

// Each piece of the profile is colored by its grade over this many samples.
const PIECE_STEPS = 2;
// The profile is never drawn taller than this many meters of height spans,
// so a road that barely rises still looks nearly flat.
const MIN_HEIGHT_SPAN_M = 15;

// Bumped by every update, so a measurement still waiting on terrain tiles
// when a newer one starts, or the ride pauses, can't overwrite what's shown.
let latest = 0;
// The line followed and where the rider was when it was last measured.
let measuredFor = null;
let measuredAt = null;
// A line tracker for each line followed, so progress along a route followed
// as is carries on from fix to fix; and the reversed guide line home.
const trackers = new WeakMap();
const reversed = new WeakMap();

/**
 * Called on every live GPS fix: measures the line ahead, once the rider's
 * moved far enough since it was last measured, and shows or hides the strip.
 *
 * @param {Object} session - The current ride.
 * @returns {Promise<void>}
 */
export async function updateGradeAhead(session) {
	const point = session.lastPoint;
	const ahead = session.activityType === "kayak" || !point ? null : lineAhead(session);
	if (!ahead) {
		hideGradeAhead();
		return;
	}
	const moved = measuredAt ? haversineMeters(measuredAt.lat, measuredAt.lng, point.lat, point.lng) : Infinity;
	if (ahead.source === measuredFor && moved < GRADE_AHEAD_REFRESH_M) return;
	measuredFor = ahead.source;
	measuredAt = point;

	const request = ++latest;
	const profile = await profileAhead(ahead.coords, point);
	if (request !== latest) return;
	render(profile);
}

/** Hides the strip, as when the ride pauses or ends, or there's nothing being followed. */
export function hideGradeAhead() {
	latest++;
	measuredFor = null;
	measuredAt = null;
	setShown(false);
}

/**
 * The line the rider's following, rider end first where it's known which
 * way it goes: the route being ridden (see ride-plan.js), or the route back
 * to the start once its directions are on. `source` says which, so a switch
 * is measured straight away.
 */
function lineAhead(session) {
	if (state.rideRoute && !session.routeCancelled && state.livePlanCoords?.length >= 2) {
		return { source: state.rideRoute, coords: state.livePlanCoords };
	}
	const home = state.liveGuideCoords;
	if (session.startDirections && home?.length >= 2) {
		// The guide line runs from the start to the rider.
		if (!reversed.has(home)) reversed.set(home, [...home].reverse());
		return { source: "home", coords: reversed.get(home) };
	}
	return null;
}

/**
 * The terrain heights every GRADE_AHEAD_STEP_M along `coords` from the
 * rider on, for GRADE_AHEAD_M or to the line's end.
 *
 * @returns {Promise<Array<number>|null>} Null when the rider's off the line,
 *   it's too short to say, or a terrain tile can't be had.
 */
async function profileAhead(coords, point) {
	if (!trackers.has(coords)) trackers.set(coords, createLineTracker(coords));
	const tracker = trackers.get(coords);
	const { along, meters } = tracker.match(point);
	if (meters > ROUTE_OFF_ROUTE_M) return null;
	const end = Math.min(tracker.total, along + GRADE_AHEAD_M);
	if (end - along < GRADE_AHEAD_MIN_RUN_M) return null;

	const samples = [];
	let segment = 0;
	for (let at = along; at <= end; at += GRADE_AHEAD_STEP_M) {
		while (segment + 2 < tracker.distances.length && tracker.distances[segment + 1] < at) segment++;
		const from = tracker.distances[segment];
		const length = tracker.distances[segment + 1] - from;
		const t = length ? Math.min(1, (at - from) / length) : 0;
		const [a, b] = [coords[segment], coords[segment + 1]];
		samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	}
	const heights = await Promise.all(samples.map(heightAt));
	if (heights.includes(null)) return null;
	// Each height averaged with its neighbours, which irons out the meter or so
	// of roughness in the terrain data itself.
	return heights.map((_, i) => {
		const near = heights.slice(Math.max(0, i - 1), i + 2);
		return near.reduce((sum, height) => sum + height, 0) / near.length;
	});
}

/**
 * The profile cut into pieces PIECE_STEPS samples long, each with its grade.
 * @param {Array<number>} heights
 * @returns {Array<{from: number, to: number, grade: number}>} Meters ahead.
 */
function piecesOf(heights) {
	const pieces = [];
	for (let i = 0; i + 1 < heights.length; i += PIECE_STEPS) {
		const j = Math.min(i + PIECE_STEPS, heights.length - 1);
		const run = (j - i) * GRADE_AHEAD_STEP_M;
		pieces.push({ from: i * GRADE_AHEAD_STEP_M, to: j * GRADE_AHEAD_STEP_M, grade: (heights[j] - heights[i]) / run });
	}
	return pieces;
}

/**
 * The first climb or descent worth showing: one that starts on a piece of
 * GRADE_MODERATE or more and carries on while the road keeps going the same
 * way by GRADE_SHOW or more, at least GRADE_AHEAD_MIN_RUN_M long and
 * averaging GRADE_MODERATE, starting within GRADE_AHEAD_SHOW_M.
 *
 * @returns {{from: number, to: number, grade: number}|null}
 */
function nextSlope(pieces) {
	for (let i = 0; i < pieces.length && pieces[i].from <= GRADE_AHEAD_SHOW_M; i++) {
		if (Math.abs(pieces[i].grade) < GRADE_MODERATE) continue;
		const sign = Math.sign(pieces[i].grade);
		let j = i;
		while (j + 1 < pieces.length && pieces[j + 1].grade * sign >= GRADE_SHOW) j++;
		const from = pieces[i].from;
		const to = pieces[j].to;
		const grade = pieces.slice(i, j + 1).reduce((sum, piece) => sum + piece.grade * (piece.to - piece.from), 0) / (to - from);
		if (to - from >= GRADE_AHEAD_MIN_RUN_M && Math.abs(grade) >= GRADE_MODERATE) return { from, to, grade };
		i = j;
	}
	return null;
}

/** Shows the strip for a measured profile, or hides it with nothing to show. */
function render(heights) {
	const pieces = heights ? piecesOf(heights) : [];
	const slope = nextSlope(pieces);
	if (!slope) {
		setShown(false);
		return;
	}
	setShown(true);

	const percent = Math.round(Math.abs(slope.grade) * 100);
	const climbing = slope.grade > 0;
	const kind = climbing ? "climb" : "descent";
	const distance = (meters) => formatNavDistance(meters).join(" ");
	// A slope that runs past the end of what's measured is longer still.
	const length = `${distance(slope.to - slope.from)}${slope.to >= pieces.at(-1).to ? "+" : ""}`;
	el.gradeAheadValue.textContent = `${climbing ? "" : "−"}${percent}%`;
	el.gradeAheadValue.style.color = gradeColor(slope.grade);
	el.gradeAheadText.textContent =
		slope.from < GRADE_AHEAD_STEP_M * PIECE_STEPS ? `${kind} · ${length} to go` : `${kind} in ${distance(slope.from)} · ${length} long`;
	el.gradeAhead.setAttribute("aria-label", `${percent}% ${el.gradeAheadText.textContent}`);
	drawProfile(el.gradeAheadCanvas, heights, pieces, slope);
}

function setShown(shown) {
	el.gradeAhead.hidden = !shown;
	el.screens.active.classList.toggle("grade-ahead-on", shown);
}

/**
 * Draws the profile ahead, the rider at its left end: each piece filled in
 * its grade's color, the slope coming up stronger than the rest, under a
 * line along the top.
 */
function drawProfile(canvas, heights, pieces, slope) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.floor(rect.width * dpr));
	canvas.height = Math.max(1, Math.floor(rect.height * dpr));
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, rect.width, rect.height);

	const total = (heights.length - 1) * GRADE_AHEAD_STEP_M;
	const low = Math.min(...heights);
	const span = Math.max(MIN_HEIGHT_SPAN_M, Math.max(...heights) - low);
	const top = 6;
	const floor = rect.height;
	// The rider's dot sits at the left end, so the line starts just inside it.
	const left = 8;
	const xAt = (meters) => left + (meters / total) * (rect.width - left);
	const yAt = (height) => floor - 2 - ((height - low) / span) * (floor - top - 2);
	const heightAtMeters = (meters) => heights[Math.round(meters / GRADE_AHEAD_STEP_M)];

	for (const piece of pieces) {
		const onSlope = piece.from >= slope.from && piece.to <= slope.to;
		ctx.globalAlpha = onSlope ? 0.9 : 0.5;
		ctx.fillStyle = gradeColor(piece.grade);
		ctx.beginPath();
		ctx.moveTo(xAt(piece.from), floor);
		for (let at = piece.from; at <= piece.to; at += GRADE_AHEAD_STEP_M) ctx.lineTo(xAt(at), yAt(heightAtMeters(at)));
		ctx.lineTo(xAt(piece.to), floor);
		ctx.closePath();
		ctx.fill();
	}
	ctx.globalAlpha = 1;

	const ink = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#14181a";
	ctx.beginPath();
	heights.forEach((height, i) => ctx[i ? "lineTo" : "moveTo"](xAt(i * GRADE_AHEAD_STEP_M), yAt(height)));
	ctx.lineWidth = 2;
	ctx.lineJoin = "round";
	ctx.strokeStyle = ink;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(xAt(0), yAt(heights[0]), 5, 0, Math.PI * 2);
	ctx.fillStyle = ink;
	ctx.fill();
}
