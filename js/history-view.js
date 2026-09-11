/**
 * The home screen's "Past rides" section: month/week totals, the list view
 * and the calendar view (both sharing the same red-to-green pace/distance/
 * time coloring), and the row/title formatting helpers both views build on.
 */

import { ACTIVITIES } from "./constants.js";
import { state, el } from "./state.js";
import { getAllSessions } from "./db.js";
import { getSegmentLengthMeters, distanceUnitLabel, speedUnitLabel } from "./map-visuals.js";
import { formatDistance, formatSpeed, formatDurationMinutes } from "./format.js";
import { paceColor } from "./colors.js";
import { openPostSession } from "./post-session.js";
import { showModal } from "./modal.js";

/**
 * Loads every saved ride and re-renders the whole "Past rides" section: the
 * home totals header, and whichever of the list/calendar views is currently
 * selected (the other is left stale until it's shown, to avoid building both
 * on every render).
 *
 * @returns {Promise<void>}
 */
export async function renderPastRides() {
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

/**
 * Renders the home screen's month-to-date and trailing-7-day totals, over
 * whichever activity is selected in settings (or every activity, for "all").
 * Average speed is distance over moving time, the same definition every
 * other average in the app uses.
 *
 * @param {Array<Object>} sessions - Every saved ride.
 */
export function renderHomeTotals(sessions) {
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

/**
 * Renders the flat, newest-first list of past rides, with a year divider
 * whenever the year changes and a comparison bar per row (see `rideBarScale`).
 *
 * @param {Array<Object>} sessions - Every saved ride, already sorted newest-first.
 */
export function renderRidesList(sessions) {
	el.sessionsList.innerHTML = "";

	// Sorted newest first, so the year changes at most once per group. The first
	// year rides in the section label; each older one gets a divider row.
	let currentYear;
	const barScale = rideBarScale(sessions);

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
		li.appendChild(buildSessionRow(session, date, { bar: barScale(session) }));
		el.sessionsList.appendChild(li);
	}
}

// Weeks run Sunday-first. The column labels themselves come from the locale.
const WEEK_START_DAY = 0;

/** @param {Date} date @returns {Date} The 1st of `date`'s month, at local midnight. */
function startOfMonth(date) {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Pages the calendar view by `delta` months and re-renders.
 *
 * @param {number} delta - `-1` for the previous month, `1` for the next.
 * @returns {Promise<void>}
 */
export async function shiftCalendarMonth(delta) {
	const month = state.calendarMonth;
	if (!month) return;
	// renderRidesCalendar clamps, so an out-of-range step cannot get through even if
	// the buttons have not caught up with a change to the stored rides.
	state.calendarMonth = new Date(month.getFullYear(), month.getMonth() + delta, 1);
	await renderPastRides();
}

/**
 * The calendar's paging range: from the earliest recorded ride's month to
 * the current month. The current month is always inside the range so today
 * stays reachable, and a ride somehow dated ahead of the clock extends the
 * top of the range rather than being made unreachable.
 *
 * @param {Array<Object>} sessions
 * @returns {{min: number, max: number}} Month-start timestamps.
 */
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

/**
 * The calendar's initial month: the most recent ride's month, so the
 * calendar isn't blank after a break from riding. Falls back to the current
 * month when there are no rides yet.
 *
 * @param {Array<Object>} sessions
 * @returns {Date}
 */
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

/**
 * Clamps a calendar month into the given paging range.
 *
 * @param {Date} month
 * @param {{min: number, max: number}} bounds
 * @returns {Date}
 */
function clampCalendarMonth(month, bounds) {
	const time = month.getTime();
	if (time < bounds.min) return new Date(bounds.min);
	if (time > bounds.max) return new Date(bounds.max);
	return month;
}

/** @param {Date} date @returns {string} A grouping key unique to one calendar day. */
function dayKey(date) {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Renders the calendar grid for `state.calendarMonth` (defaulting/clamping
 * it first), including the leading/trailing days that spill into neighboring
 * months — those days show their rides too, they're just visually muted.
 *
 * @param {Array<Object>} sessions - Every saved ride (not filtered to the
 *   displayed month).
 */
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

/** Renders the calendar's weekday header row, from the locale's own weekday names. */
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

/**
 * Builds one calendar-day button: the day's rides' moving time and distance
 * added up, the top rule colored by `dayScale`. Clicking it opens the single
 * ride directly, or a picker when the day holds several.
 *
 * @param {Array<Object>} rides - This day's rides, oldest first.
 * @param {Date} cellDate
 * @param {(rides: Array<Object>) => number} dayScale - From `calendarDayScale`.
 * @returns {HTMLButtonElement}
 */
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

/**
 * Opens a modal listing every ride on one calendar day; each row opens its
 * own ride, the same as the flat list does.
 *
 * @param {Array<Object>} rides
 * @param {Date} cellDate
 */
function pickRideFromDay(rides, cellDate) {
	showModal({
		title: cellDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
		message: "",
		listItems: rides.map((session) => buildSessionRow(session, new Date(session.date), { withTime: true })),
		hideConfirm: true,
		cancelText: "Close",
	});
}

/**
 * Builds a function that places a day's combined rides on a red (0) to
 * green (1) scale, by whichever measure ("distance"/"time"/"pace") is chosen
 * in settings. Every saved day is included in the comparison, not just the
 * month on screen, so a day keeps its color as the calendar is paged. With
 * nothing to compare against — one day, or every day alike — a day sits in
 * the middle (0.5).
 *
 * @param {Map<string, Array<Object>>} byDay - Day key (see `dayKey`) to that
 *   day's rides.
 * @param {Array<Object>} sessions - Every saved ride, for building pace ranges.
 * @returns {(rides: Array<Object>) => number}
 */
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

/**
 * Builds a function returning one ride's comparison-bar length and color for
 * the list view, by the same measure the calendar uses. Length is the ride
 * against the biggest one (the same way a segment-table bar is scaled
 * against the fastest segment); color places it between the smallest and
 * biggest. Unlike `calendarDayScale`, rides are compared individually here,
 * not combined per day.
 *
 * @param {Array<Object>} sessions
 * @returns {(session: Object) => {length: number, color: number}}
 */
function rideBarScale(sessions) {
	if (state.prefs.calendarColor === "pace") {
		const ranges = ridePaceRanges(sessions);
		return (session) => {
			const range = ranges.get(session.activityType || "bike");
			return {
				length: range ? rideAvgSpeed(session) / range.max : 0,
				color: ridePaceFraction(session, ranges),
			};
		};
	}

	const measure =
		state.prefs.calendarColor === "time" ? (session) => session.movingTime || 0 : (session) => session.totalDistance || 0;
	let min = Infinity;
	let max = -Infinity;
	for (const session of sessions) {
		const value = measure(session);
		min = Math.min(min, value);
		max = Math.max(max, value);
	}
	return (session) => {
		const value = measure(session);
		return {
			length: max > 0 ? value / max : 0,
			color: max > min ? (value - min) / (max - min) : 0.5,
		};
	};
}

/**
 * Each activity type's slowest and fastest average speed across every saved
 * ride, so a ride's pace is judged against its own kind — a brisk walk isn't
 * colored red just because bike rides are quicker.
 *
 * @param {Array<Object>} sessions
 * @returns {Map<string, {min: number, max: number}>} Keyed by activity type.
 */
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

/**
 * A ride's pace as a 0..1 fraction within its activity's range.
 *
 * @param {Object} session
 * @param {Map<string, {min: number, max: number}>} ranges - From `ridePaceRanges`.
 * @returns {number} 0 for the slowest ride of that activity, 1 for the
 *   fastest, 0.5 as the neutral fallback when there's nothing to compare.
 */
function ridePaceFraction(session, ranges) {
	const range = ranges.get(session.activityType || "bike");
	const speed = rideAvgSpeed(session);
	if (!range || speed <= 0) return 0.5;
	if (range.max - range.min < 0.05) return 0.5;
	return (speed - range.min) / (range.max - range.min);
}

/**
 * A ride's average speed. Stored on every saved ride, but worked out again
 * (distance over moving time) for any imported one that lacks it.
 *
 * @param {Object} session
 * @returns {number} Meters/second.
 */
export function rideAvgSpeed(session) {
	if (Number.isFinite(session.avgSpeed)) return session.avgSpeed;
	const moving = session.movingTime || 0;
	return moving > 0 ? (session.totalDistance || 0) / (moving / 1000) : 0;
}

/**
 * Builds one clickable ride row, shared by the flat list, the calendar's
 * day-picker modal, and (via `sessionTimeTitle`) the post-ride summary title.
 *
 * @param {Object} session
 * @param {Date} date
 * @param {Object} [options]
 * @param {boolean} [options.withTime] - Shows the clock time in place of the
 *   part-of-day, for the day-picker modal where every row already shares the
 *   date.
 * @param {{length: number, color: number}|null} [options.bar] - From
 *   `rideBarScale`; adds the home list's comparison bar when given.
 * @returns {HTMLButtonElement}
 */
export function buildSessionRow(session, date, { withTime = false, bar = null } = {}) {
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

	button.append(main);
	if (bar) {
		button.classList.add("with-bar");
		const track = document.createElement("span");
		track.className = "pace-track session-bar";
		track.setAttribute("aria-hidden", "true");
		const fill = document.createElement("span");
		fill.className = "pace-fill";
		fill.style.width = `${Math.max(2, Math.min(1, bar.length) * 100).toFixed(1)}%`;
		fill.style.background = paceColor(bar.color);
		track.appendChild(fill);
		button.appendChild(track);
	}
	button.append(distance, chevron);
	button.addEventListener("click", () => openPostSession(session.id, null, "push"));
	return button;
}

/**
 * The list row's title: "Aug 26 · Morning" for a bike ride (the app's
 * default activity, so it names only the day part), or "Aug 26 · Morning
 * walk" for anything else (day part plus the activity's noun).
 *
 * @param {Object} session
 * @param {Date} date
 * @returns {string}
 */
function sessionRowTitle(session, date) {
	const dayPart = sessionDayPart(session, date);
	const type = session.activityType || "bike";
	const part = type === "bike" ? dayPart : [dayPartWord(dayPart), ACTIVITIES[type]?.noun].filter(Boolean).join(" ");
	return `${formatSessionDay(date)}${part ? ` · ${part}` : ""}`;
}

/**
 * The ride-summary screen's title: "Morning walk · 8:04 AM".
 *
 * @param {Object} session
 * @param {Date} date
 * @returns {string}
 */
export function sessionTimeTitle(session, date) {
	if (Number.isNaN(date.getTime())) return rideTitle(session);
	return `${rideTitle(session)} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * A ride's name: "Morning ride", "All-day hike", or just "Ride" when there's
 * no usable date to derive a part-of-day from.
 *
 * @param {Object} session
 * @returns {string}
 */
function rideTitle(session) {
	const date = new Date(session.date);
	const noun = ACTIVITIES[session.activityType || "bike"]?.noun || "ride";
	const part = dayPartWord(sessionDayPart(session, date));
	if (!part) return noun.charAt(0).toUpperCase() + noun.slice(1);
	return `${part} ${noun}`;
}

/** @param {string} dayPart @returns {string} "All day" becomes the adjective "All-day"; everything else passes through. */
function dayPartWord(dayPart) {
	return dayPart === "All day" ? "All-day" : dayPart;
}

/** @param {Date} date @returns {string} e.g. "Aug 26", or "Unknown date" for an invalid date. */
function formatSessionDay(date) {
	if (Number.isNaN(date.getTime())) return "Unknown date";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Which half of the day a ride sat in, or "All day" when it ran across noon
 * or past midnight. The clock time itself is available on the summary
 * screen if it's wanted.
 *
 * @param {Object} session
 * @param {Date} date - The ride's start date.
 * @returns {""|"All day"|"Morning"|"Afternoon"|"Evening"} Empty string for
 *   an invalid date.
 */
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

/**
 * A ride's end time. The last recorded fix is the real end; `movingTime`
 * (which excludes stops) only stands in for a ride that recorded no points
 * at all.
 *
 * @param {Object} session
 * @param {Date} startDate
 * @returns {Date}
 */
function sessionEndDate(session, startDate) {
	// The last fix is the real end. movingTime excludes stops, so it only stands in
	// when a ride recorded no points at all.
	const points = session.points;
	const lastTimestamp = Array.isArray(points) && points.length ? points[points.length - 1].timestamp : null;
	if (Number.isFinite(lastTimestamp)) return new Date(lastTimestamp);
	return new Date(startDate.getTime() + (session.movingTime || 0));
}
