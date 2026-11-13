/**
 * The records and trends screen: all-time and this-year totals, a bar chart
 * of the last twelve weeks or months, and personal records (longest,
 * fastest, biggest climb, biggest week and month, longest run of weeks with
 * a ride). Everything comes from the ride summaries (db.js), so no ride's
 * GPS points are read.
 */

import { ACTIVITIES } from "./constants.js";
import { state, el } from "./state.js";
import { getAllSessionSummaries } from "./db.js";
import { formatDistance, formatSpeed, formatElevationValue, formatDurationMinutes, escapeHtml } from "./format.js";
import { getSegmentLengthMeters, distanceUnitLabel, speedUnitLabel } from "./map-visuals.js";
import { rideAvgSpeed } from "./history-view.js";
import { openPostSession } from "./post-session.js";
import { navigateToScreen } from "./navigation.js";

// How many weeks or months the trend chart shows, the current one last.
const TREND_PERIODS = 12;
// A ride shorter than this isn't a fair "fastest average": a sprint down the
// street would always win.
const FASTEST_MIN_MOVING_MS = 20 * 60 * 1000;
// Weeks start on Sunday, as the home screen's calendar does.
const WEEK_START_DAY = 0;

// What the screen is showing. The activity starts as the home screen's.
const view = { activity: null, period: "week", metric: "distance" };
// The rides the screen was last opened with, newest first.
let rides = [];

/** Wires the records screen's controls. Called once from `wireEvents`. */
export function wireRecords() {
	el.openRecordsBtn.addEventListener("click", () => openRecords());
	el.recordsBackBtn.addEventListener("click", () => history.back());
	el.recordsActivitySelect.addEventListener("change", () => {
		view.activity = el.recordsActivitySelect.value;
		render();
	});
	el.recordsPeriodToggle.addEventListener("click", (event) => {
		const btn = event.target.closest("button[data-trend-period]");
		if (!btn) return;
		view.period = btn.dataset.trendPeriod;
		render();
	});
	el.recordsMetricToggle.addEventListener("click", (event) => {
		const btn = event.target.closest("button[data-trend-metric]");
		if (!btn) return;
		view.metric = btn.dataset.trendMetric;
		render();
	});
}

/**
 * Opens the records screen, reading the ride summaries afresh.
 * @param {"push"|"replace"|string} [mode] - As for `navigateToScreen`.
 * @returns {Promise<void>}
 */
export async function openRecords(mode = "push") {
	rides = (await getAllSessionSummaries())
		.filter((ride) => Number.isFinite(new Date(ride.date).getTime()))
		.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	view.activity ??= state.prefs.statsActivity;
	navigateToScreen("records", mode);
	render();
}

/** Draws the whole screen for the picked activity. */
function render() {
	renderActivityChoices();
	const counted = view.activity === "all" ? rides : rides.filter((ride) => activityOf(ride) === view.activity);

	el.recordsEmpty.hidden = counted.length > 0;
	el.recordsBody.hidden = counted.length === 0;
	for (const btn of el.recordsPeriodToggle.querySelectorAll("button")) {
		const on = btn.dataset.trendPeriod === view.period;
		btn.classList.toggle("active", on);
		btn.setAttribute("aria-pressed", String(on));
	}
	for (const btn of el.recordsMetricToggle.querySelectorAll("button")) {
		const on = btn.dataset.trendMetric === view.metric;
		btn.classList.toggle("active", on);
		btn.setAttribute("aria-pressed", String(on));
	}
	if (!counted.length) return;

	renderTotals(counted);
	renderTrend(counted);
	renderRecordList(counted);
}

/** A ride's activity key; rides from before activities existed are bike rides. */
function activityOf(ride) {
	return ride.activityType || "bike";
}

/** Fills the activity picker with "All" and each activity that has a ride. */
function renderActivityChoices() {
	const present = new Set(rides.map(activityOf));
	// A picked activity whose rides have all gone falls back to everything.
	if (view.activity !== "all" && !present.has(view.activity)) view.activity = "all";
	el.recordsActivitySelect.innerHTML = [
		'<option value="all">All activities</option>',
		...Object.entries(ACTIVITIES)
			.filter(([key]) => present.has(key))
			.map(([key, activity]) => `<option value="${escapeHtml(key)}">${escapeHtml(activity.label)}</option>`),
	].join("");
	el.recordsActivitySelect.value = view.activity;
}

/** Sums rides into distance, moving time and a count. */
function totalsOf(list) {
	const totals = { distance: 0, time: 0, count: 0 };
	for (const ride of list) {
		totals.distance += ride.totalDistance || 0;
		totals.time += ride.movingTime || 0;
		totals.count += 1;
	}
	return totals;
}

/** The all-time and this-year totals. */
function renderTotals(counted) {
	const unit = state.prefs.unit;
	const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
	const plural = ACTIVITIES[view.activity]?.plural || "Rides";
	const cells = (totals) => `
		<div><dt>Distance</dt><dd>${wholeDistance(totals.distance, unit)} <span class="unit">${distanceUnitLabel(unit)}</span></dd></div>
		<div><dt>${escapeHtml(plural)}</dt><dd>${totals.count}</dd></div>
		<div><dt>Moving time</dt><dd>${formatDurationMinutes(totals.time)}</dd></div>`;
	el.recordsAllTime.innerHTML = cells(totalsOf(counted));
	el.recordsThisYear.innerHTML = cells(totalsOf(counted.filter((ride) => new Date(ride.date).getTime() >= yearStart)));
}

/** A distance to the nearest whole unit under 1,000 and with separators above, for totals. */
function wholeDistance(meters, unit) {
	const value = meters / getSegmentLengthMeters(unit);
	return value < 100 ? value.toFixed(1) : Math.round(value).toLocaleString();
}

/** Local midnight at the start of the week a date falls in. */
function weekStart(date) {
	const back = (date.getDay() - WEEK_START_DAY + 7) % 7;
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back);
}

/** Local midnight on the first of the month a date falls in. */
function monthStart(date) {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Rides grouped by the week or month they started in.
 * @param {Array<Object>} counted
 * @param {"week"|"month"} period
 * @returns {Map<number, {start: Date, distance: number, time: number, count: number}>}
 *   Keyed by the period's start, in epoch ms.
 */
function groupByPeriod(counted, period) {
	const groups = new Map();
	for (const ride of counted) {
		const start = period === "week" ? weekStart(new Date(ride.date)) : monthStart(new Date(ride.date));
		let group = groups.get(start.getTime());
		if (!group) {
			group = { start, distance: 0, time: 0, count: 0 };
			groups.set(start.getTime(), group);
		}
		group.distance += ride.totalDistance || 0;
		group.time += ride.movingTime || 0;
		group.count += 1;
	}
	return groups;
}

/** The last TREND_PERIODS weeks or months as bars, oldest first, the current one last. */
function renderTrend(counted) {
	const unit = state.prefs.unit;
	const groups = groupByPeriod(counted, view.period);
	const now = new Date();
	const periods = [];
	for (let back = TREND_PERIODS - 1; back >= 0; back--) {
		const start =
			view.period === "week"
				? weekStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back * 7))
				: new Date(now.getFullYear(), now.getMonth() - back, 1);
		periods.push(groups.get(start.getTime()) ?? { start, distance: 0, time: 0, count: 0 });
	}

	const valueOf = (group) => (view.metric === "distance" ? group.distance : group.time);
	const top = Math.max(...periods.map(valueOf), 0);
	const perUnit = getSegmentLengthMeters(unit);
	// The figure over a bar: whole miles or km, or hours to one decimal.
	const short = (group) => {
		const value = valueOf(group);
		if (!value) return "";
		if (view.metric === "distance") return String(Math.round(value / perUnit));
		const hours = value / 3600000;
		return hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1);
	};

	el.recordsChart.replaceChildren(
		...periods.map((group, index) => {
			const bar = document.createElement("button");
			bar.type = "button";
			bar.className = "trend-bar";
			if (index === periods.length - 1) bar.classList.add("is-current");
			const share = top > 0 ? valueOf(group) / top : 0;
			bar.innerHTML = `<span class="trend-value">${short(group)}</span><span class="trend-track"><span class="trend-fill" style="height:${(share * 100).toFixed(1)}%"></span></span><span class="trend-tick">${escapeHtml(tickLabel(group.start, periods[index - 1]?.start))}</span>`;
			bar.setAttribute("aria-label", periodDetail(group, unit));
			bar.addEventListener("click", () => {
				for (const other of el.recordsChart.children) other.classList.toggle("is-picked", other === bar);
				el.recordsChartReadout.textContent = periodDetail(group, unit);
			});
			return bar;
		}),
	);
	el.recordsChartUnit.textContent = view.metric === "distance" ? distanceUnitLabel(unit) : "hours";
	// Starts on the current period, the one a rider most often wants.
	el.recordsChartReadout.textContent = periodDetail(periods[periods.length - 1], unit);
	el.recordsChart.lastElementChild.classList.add("is-picked");
}

/** The label under a bar: each month's letter, or for weeks the month where it changes. */
function tickLabel(start, previous) {
	if (view.period === "month") return start.toLocaleDateString(undefined, { month: "narrow" });
	if (previous && previous.getMonth() === start.getMonth()) return "";
	return start.toLocaleDateString(undefined, { month: "short" });
}

/** A period's name: "Week of Aug 4" or "August 2025". */
function periodName(start) {
	if (view.period === "week") return `Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
	return start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** One period in words, for the readout under the chart. */
function periodDetail(group, unit) {
	if (!group.count) return `${periodName(group.start)}: nothing recorded`;
	return `${periodName(group.start)}: ${formatDistance(group.distance, unit)} ${distanceUnitLabel(unit)} · ${formatDurationMinutes(group.time)} · ${countLabel(group.count)}`;
}

/** "1 ride" or "3 rides", in the picked activity's own word. */
function countLabel(count) {
	const noun = ACTIVITIES[view.activity]?.noun || "ride";
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The ride with the highest value of `pick`, or null when none is above zero. */
function best(list, pick) {
	let winner = null;
	let top = 0;
	for (const ride of list) {
		const value = pick(ride);
		if (Number.isFinite(value) && value > top) {
			top = value;
			winner = ride;
		}
	}
	return winner;
}

/** A ride's date as a record's subtitle: "Aug 26, 2025". */
function rideDay(ride) {
	return new Date(ride.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The longest run of consecutive weeks with a ride, and the run that reaches
 * the current week (or last week, so a run isn't lost on a Sunday morning).
 *
 * @param {Array<Object>} counted
 * @returns {{longest: number, current: number}} In weeks.
 */
function weekStreaks(counted) {
	const WEEK_MS = 7 * 24 * 3600 * 1000;
	// Rounded, since a week with a clock change in it isn't exactly 168 hours.
	const index = (date) => Math.round(weekStart(date).getTime() / WEEK_MS);
	const weeks = [...new Set(counted.map((ride) => index(new Date(ride.date))))].sort((a, b) => a - b);
	let longest = 0;
	let run = 0;
	let previous = null;
	for (const week of weeks) {
		run = previous !== null && week === previous + 1 ? run + 1 : 1;
		longest = Math.max(longest, run);
		previous = week;
	}
	const thisWeek = index(new Date());
	const current = previous !== null && previous >= thisWeek - 1 ? run : 0;
	return { longest, current };
}

/** The list of personal records. A record set by one ride opens it. */
function renderRecordList(counted) {
	const unit = state.prefs.unit;
	const elevationUnit = unit === "imperial" ? "ft" : "m";
	const rows = [];
	const rideRecord = (title, ride, value, unitLabel) => {
		if (ride) rows.push({ title, sub: rideDay(ride), value, unitLabel, rideId: ride.id });
	};

	const longest = best(counted, (ride) => ride.totalDistance);
	rideRecord("Longest distance", longest, longest && formatDistance(longest.totalDistance, unit), distanceUnitLabel(unit));

	const longestTime = best(counted, (ride) => ride.movingTime);
	rideRecord("Longest moving time", longestTime, longestTime && formatDurationMinutes(longestTime.movingTime), "");

	const fastest = best(
		counted.filter((ride) => (ride.movingTime || 0) >= FASTEST_MIN_MOVING_MS),
		rideAvgSpeed,
	);
	rideRecord("Fastest average", fastest, fastest && formatSpeed(rideAvgSpeed(fastest), unit), speedUnitLabel(unit));

	const climb = best(counted, (ride) => ride.elevationGain);
	rideRecord("Biggest climb", climb, climb && formatElevationValue(climb.elevationGain, unit), elevationUnit);

	const topSpeed = best(counted, (ride) => ride.maxSpeed);
	rideRecord("Top speed", topSpeed, topSpeed && formatSpeed(topSpeed.maxSpeed, unit), speedUnitLabel(unit));

	for (const [period, title] of [
		["week", "Biggest week"],
		["month", "Biggest month"],
	]) {
		const top = best([...groupByPeriod(counted, period).values()], (group) => group.distance);
		if (!top) continue;
		const name =
			period === "week"
				? `Week of ${top.start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
				: top.start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
		rows.push({ title, sub: `${name} · ${countLabel(top.count)}`, value: formatDistance(top.distance, unit), unitLabel: distanceUnitLabel(unit) });
	}

	const streaks = weekStreaks(counted);
	if (streaks.longest > 1) {
		const now = streaks.current > 1 ? `${streaks.current} weeks running now` : "Not on a run now";
		rows.push({ title: "Longest weekly streak", sub: now, value: String(streaks.longest), unitLabel: "weeks" });
	}

	el.recordsList.replaceChildren(
		...rows.map((row) => {
			const li = document.createElement("li");
			// Only a record one ride set has anywhere to go.
			const item = document.createElement(row.rideId != null ? "button" : "div");
			item.className = "session-row";
			if (row.rideId != null) {
				item.type = "button";
				item.addEventListener("click", () => openPostSession(row.rideId, null, "push"));
			}
			item.innerHTML = `
				<span class="session-main">
					<span class="session-when">${escapeHtml(row.title)}</span>
					<span class="session-sub">${escapeHtml(row.sub)}</span>
				</span>
				<span class="session-distance">${escapeHtml(row.value)}${row.unitLabel ? ` <span class="unit">${escapeHtml(row.unitLabel)}</span>` : ""}</span>
				<span class="chevron" aria-hidden="true">${row.rideId != null ? "›" : ""}</span>`;
			li.append(item);
			return li;
		}),
	);
}
