/**
 * Merging saved rides: the post-ride summary's "Merge rides" picker, and
 * joining several rides into one in time order. The time between one ride's
 * end and the next one's start becomes a pause, so moving time and the
 * segment table only count time spent riding.
 */

import { state } from "./state.js";
import { getAllSessionSummaries, getSessionById, addSession } from "./db.js";
import { showModal, showMessage, confirmWithModal } from "./modal.js";
import { renderPastRides, sessionTimeTitle } from "./history-view.js";
import { openPostSession } from "./post-session.js";
import { formatDistance } from "./format.js";
import { distanceUnitLabel } from "./map-visuals.js";

// How many other rides the picker offers, nearest in time to the one on screen.
const MERGE_CANDIDATE_LIMIT = 20;

/**
 * The post-ride summary screen's "Merge rides" handler: lists the rides
 * nearest in time to the one on screen as checkboxes, confirms, then saves
 * them as one new merged ride and shows it. The rides it was made from are
 * left as they were, for the rider to delete if they want.
 * @returns {Promise<void>}
 */
export async function mergeCurrentRide() {
	const current = state.currentPostSession;
	if (!current) return;

	const currentStart = rideStart(current);
	// Summaries to pick from; only the rides picked are read in full.
	const candidates = (await getAllSessionSummaries())
		.filter((session) => session.id !== current.id)
		.sort((a, b) => Math.abs(rideStart(a) - currentStart) - Math.abs(rideStart(b) - currentStart))
		.slice(0, MERGE_CANDIDATE_LIMIT)
		.sort((a, b) => rideStart(a) - rideStart(b));

	if (!candidates.length) {
		await showMessage("Nothing to Merge", "There are no other saved rides to merge this one with.");
		return;
	}

	const checkboxes = [];
	const items = candidates.map((session) => {
		const item = buildCandidateRow(session);
		checkboxes.push(item.querySelector("input"));
		return item;
	});

	const result = await showModal({
		title: "Merge Rides",
		message: "Pick the rides to join with this one. They become a single ride, in the order they happened.",
		listItems: items,
		keepOpenOnPick: true,
		confirmText: "Merge",
		cancelText: "Cancel",
	});
	if (result !== "confirm") return;

	const pickedIds = candidates.filter((_, index) => checkboxes[index].checked).map((summary) => summary.id);
	if (!pickedIds.length) return;
	const picked = (await Promise.all(pickedIds.map((id) => getSessionById(id)))).filter(Boolean);
	if (!picked.length) return;

	const rides = [current, ...picked];
	if (findOverlap(rides)) {
		await showMessage("Rides Overlap", "Rides that were recorded at the same time can't be merged.");
		return;
	}

	const ok = await confirmWithModal({
		title: `Merge ${rides.length} Rides?`,
		message: `This saves a new ride combining all ${rides.length}. The originals are kept; delete them yourself if you no longer want them.`,
		confirmText: "Merge",
		cancelText: "Cancel",
	});
	if (!ok) return;

	const merged = mergeSessions(rides);
	merged.id = await addSession(merged);
	await renderPastRides();
	await openPostSession(merged.id, merged, "push");
}

/**
 * One picker row: a checkbox labelled with the ride's day, name, time and
 * distance.
 *
 * @param {Object} session
 * @returns {HTMLLabelElement}
 */
function buildCandidateRow(session) {
	const unit = state.prefs.unit;
	const date = new Date(session.date);

	const label = document.createElement("label");
	label.className = "session-row merge-row";

	const box = document.createElement("input");
	box.type = "checkbox";

	const main = document.createElement("span");
	main.className = "session-main";
	const when = document.createElement("span");
	when.className = "session-when";
	when.textContent = sessionTimeTitle(session, date);
	const sub = document.createElement("span");
	sub.className = "session-sub";
	sub.textContent = Number.isNaN(date.getTime())
		? "Unknown date"
		: date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
	main.append(when, sub);

	const distance = document.createElement("span");
	distance.className = "session-distance";
	distance.innerHTML = `${formatDistance(session.totalDistance || 0, unit)} <span class="unit">${distanceUnitLabel(unit)}</span>`;

	label.append(box, main, distance);
	return label;
}

/** @param {Object} session - A ride or its summary. @returns {number} The first fix's time, or the ride's date. */
function rideStart(session) {
	const first = session.startTime ?? session.points?.[0]?.timestamp;
	return Number.isFinite(first) ? first : new Date(session.date).getTime() || 0;
}

/** @param {Object} session @returns {number} The last fix's time, or the start plus moving time. */
function rideEnd(session) {
	const points = session.points || [];
	const last = points[points.length - 1]?.timestamp;
	return Number.isFinite(last) ? last : rideStart(session) + (session.movingTime || 0);
}

/**
 * Whether any two of the rides were recorded over the same stretch of time,
 * which would interleave their tracks.
 *
 * @param {Array<Object>} rides
 * @returns {boolean}
 */
function findOverlap(rides) {
	const sorted = [...rides].sort((a, b) => rideStart(a) - rideStart(b));
	return sorted.some((ride, index) => index > 0 && rideStart(ride) < rideEnd(sorted[index - 1]));
}

/**
 * Joins rides into one session record, oldest first. Totals add up (the
 * distance between one ride's end and the next one's start is not ridden, so
 * it isn't counted), and each gap is recorded as a pause. The activity, unit
 * and date come from the earliest ride.
 *
 * @param {Array<Object>} rides - Two or more saved rides that don't overlap.
 * @returns {Object} A session record without an id.
 */
export function mergeSessions(rides) {
	const sorted = [...rides].sort((a, b) => rideStart(a) - rideStart(b));
	const first = sorted[0];

	const points = [];
	const pauses = [];
	let totalDistance = 0;
	let movingTime = 0;
	let maxSpeed = 0;
	let elevationGain = 0;
	let elevationDrop = 0;

	for (const [index, ride] of sorted.entries()) {
		if (index > 0) pauses.push({ start: rideEnd(sorted[index - 1]), end: rideStart(ride) });
		points.push(...(ride.points || []));
		pauses.push(...(Array.isArray(ride.pauses) ? ride.pauses : []));
		totalDistance += ride.totalDistance || 0;
		movingTime += ride.movingTime || 0;
		maxSpeed = Math.max(maxSpeed, ride.maxSpeed || 0);
		elevationGain += ride.elevationGain || 0;
		elevationDrop += ride.elevationDrop || 0;
	}

	const routeIds = new Set(sorted.map((ride) => ride.routeId ?? null));

	return {
		date: first.date,
		unit: first.unit,
		activityType: first.activityType || "bike",
		keepScreenOn: sorted.some((ride) => ride.keepScreenOn),
		points,
		totalDistance,
		movingTime,
		maxSpeed,
		avgSpeed: movingTime > 0 ? totalDistance / (movingTime / 1000) : 0,
		elevationGain,
		elevationDrop,
		// The summary screen works segments out afresh from the points.
		segments: [],
		segmentMarkers: [],
		pauses,
		// Only kept when every ride followed the same saved route.
		routeId: routeIds.size === 1 ? first.routeId ?? null : null,
	};
}
