/**
 * Ride charts. Mostly the post-ride pair: elevation over distance and speed
 * over moving time, each drawn onto a `<canvas>` (line colored by speed band,
 * gridlines, min/max labels), and the mouse/touch interaction that, as the
 * cursor hovers or a finger slides along a chart, marks that point on the
 * chart and the post-ride map and reads out its numbers. Also the route
 * planner's simpler profile (`renderProfileChart`), which shares the grid and
 * labels.
 */

import { state, el } from "./state.js";
import { minOf, maxOf, haversineMeters, movingMsBetween, formatElevation, formatSpeed, formatDistance, formatDuration } from "./format.js";
import { speedUnitLabel, distanceUnitLabel } from "./map-visuals.js";
import { speedBand, speedBandColor } from "./colors.js";
import { rideAvgSpeed } from "./history-view.js";

// Smooth mode draws both charts as a rolling average over this share of their
// X axis, so a long ride's line stays readable at phone width, and never over
// less than these spans, so a short ride isn't flattened by GPS noise alone.
const SMOOTHING_AXIS_SHARE = 1 / 80;
const SMOOTHING_MIN_METERS = 100;
const SMOOTHING_MIN_MS = 10000;

/**
 * Draws both post-ride charts for a session.
 *
 * @param {Object} session
 */
export function renderRideCharts(session) {
	renderElevationChart(session);
	renderSpeedChart(session);
}

/**
 * Draws the elevation-vs-distance chart for a session onto `el.elevationChart`,
 * or an empty-state message when the ride has no elevation data, and (re)wires
 * up the mouse/touch handlers that highlight a point on the map as the reader
 * traces the line.
 *
 * @param {Object} session - A saved (or live) ride session with a `points` array.
 */
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
	// Full bleed: the elevation labels sit on the grid lines and the distance
	// labels are HTML under the canvas.
	const padding = { top: 4, right: 0, bottom: 4, left: 0 };
	const chartWidth = cssWidth - padding.left - padding.right;
	const chartHeight = cssHeight - padding.top - padding.bottom;
	const displayUnit = state.prefs.unit;
	const totalDistance = Math.max(points[points.length - 1].distance, 1);
	// Coloured against the raw top speed, so a stretch matches the route line.
	const maxSpeed = Math.max(maxOf(points, (point) => point.speed), 0.0001);

	if (state.prefs.chartDetail === "smooth") {
		const windowMeters = Math.max(SMOOTHING_MIN_METERS, totalDistance * SMOOTHING_AXIS_SHARE);
		smoothPoints(points, (point) => point.distance, windowMeters, ["elevation", "speed"]);
	}

	const minElevation = minOf(points, (point) => point.elevation);
	const maxElevation = maxOf(points, (point) => point.elevation);

	const xFor = (distance) => padding.left + (distance / totalDistance) * chartWidth;
	const yFor = (elevation) => {
		if (maxElevation === minElevation) return padding.top + chartHeight / 2;
		return padding.top + chartHeight - ((elevation - minElevation) / (maxElevation - minElevation)) * chartHeight;
	};

	const pointX = (point) => xFor(point.distance);
	const pointY = (point) => yFor(point.elevation);

	drawChartBackground(ctx, cssWidth, cssHeight, padding);
	drawFadedFill(ctx, points, pointX, pointY, padding.top, cssHeight - padding.bottom);
	drawBandedLine(ctx, points, pointX, pointY, maxSpeed);
	drawElevationLabels(ctx, cssHeight, padding, minElevation, maxElevation, displayUnit);

	// Add event listeners for chart interaction
	setupChartInteraction(canvas, {
		session,
		points,
		padding,
		cssWidth,
		axisValue: (point) => point.distance,
		axisEnd: totalDistance,
		pointX,
		pointY,
		cursor: el.chartCursor,
		readout: el.chartReadout,
		readoutHtml: (point, unit) =>
			`<strong>${formatElevation(point.elevation, unit)}</strong>` +
			`<strong>${formatSpeed(point.speed, unit)} ${speedUnitLabel(unit)}</strong>` +
			`<span>${formatDistance(summaryDistance(session, point, totalDistance), unit)} ${distanceUnitLabel(unit)}</span>`,
	});
}

/**
 * Draws the speed-vs-moving-time chart for a session onto `el.speedChart`,
 * or an empty-state message when the ride has no usable speeds or times. The
 * line runs from zero up to its own fastest stretch, with the ride's average
 * dashed across it. Time spent paused isn't on the axis, so a merged
 * ride's long break leaves no flat gap, while a stop without a pause still
 * shows as a dip.
 *
 * @param {Object} session
 */
function renderSpeedChart(session) {
	const canvas = el.speedChart;
	if (!canvas) return;

	const points = buildSpeedPoints(session);
	if (!points) {
		canvas.chartContext = null;
		drawEmptyChart(canvas, "No speed data available");
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
	const padding = { top: 4, right: 0, bottom: 4, left: 0 };
	const chartHeight = cssHeight - padding.top - padding.bottom;
	const unit = state.prefs.unit;
	const totalTime = points[points.length - 1].time;
	// Coloured against the raw top speed, so a stretch matches the route line.
	const maxSpeed = Math.max(maxOf(points, (point) => point.speed), 0.0001);

	if (state.prefs.chartDetail === "smooth") {
		const windowMs = Math.max(SMOOTHING_MIN_MS, totalTime * SMOOTHING_AXIS_SHARE);
		smoothPoints(points, (point) => point.time, windowMs, ["speed"]);
	}

	const topSpeed = maxOf(points, (point) => point.speed);

	const pointX = (point) => (point.time / totalTime) * cssWidth;
	const yForSpeed = (speed) => padding.top + chartHeight - (speed / topSpeed) * chartHeight;
	const pointY = (point) => yForSpeed(point.speed);

	drawChartBackground(ctx, cssWidth, cssHeight, padding);
	drawFadedFill(ctx, points, pointX, pointY, padding.top, cssHeight - padding.bottom);
	drawBandedLine(ctx, points, pointX, pointY, maxSpeed);

	const averageY = Math.round(yForSpeed(rideAvgSpeed(session))) + 0.5;
	ctx.save();
	ctx.lineWidth = 1;
	ctx.setLineDash([5, 5]);
	ctx.strokeStyle = themeColor("--muted", "#6b7472");
	ctx.beginPath();
	ctx.moveTo(0, averageY);
	ctx.lineTo(cssWidth, averageY);
	ctx.stroke();
	ctx.restore();

	drawRangeLabels(ctx, cssHeight, padding, `${formatSpeed(topSpeed, unit)} ${speedUnitLabel(unit)}`, "0");

	setupChartInteraction(canvas, {
		session,
		points,
		padding,
		cssWidth,
		axisValue: (point) => point.time,
		axisEnd: totalTime,
		pointX,
		pointY,
		cursor: el.speedChartCursor,
		readout: el.speedChartReadout,
		readoutHtml: (point, displayUnit) =>
			`<strong>${formatSpeed(point.speed, displayUnit)} ${speedUnitLabel(displayUnit)}</strong>` +
			`<span>${formatDuration(point.time)}</span>` +
			`<span>${formatDistance(summaryDistance(session, point, points[points.length - 1].distance), displayUnit)} ${distanceUnitLabel(displayUnit)}</span>`,
	});
}

/**
 * A soft fill under a chart's line, fading to nothing at the floor.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<Object>} points
 * @param {(point: Object) => number} pointX
 * @param {(point: Object) => number} pointY
 * @param {number} top - CSS pixels down to the chart's top.
 * @param {number} floor - CSS pixels down to the chart's floor.
 */
function drawFadedFill(ctx, points, pointX, pointY, top, floor) {
	const fill = ctx.createLinearGradient(0, top, 0, floor);
	fill.addColorStop(0, "rgba(143, 201, 58, 0.22)");
	fill.addColorStop(1, "rgba(143, 201, 58, 0)");
	ctx.beginPath();
	ctx.moveTo(pointX(points[0]), floor);
	for (const point of points) ctx.lineTo(pointX(point), pointY(point));
	ctx.lineTo(pointX(points[points.length - 1]), floor);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();
}

/**
 * Strokes a chart's line in speed-band colors: one path per contiguous run
 * of the same band, instead of one path per point pair.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<Object>} points
 * @param {(point: Object) => number} pointX
 * @param {(point: Object) => number} pointY
 * @param {number} maxSpeed - The speed at the top of the color scale.
 */
function drawBandedLine(ctx, points, pointX, pointY, maxSpeed) {
	ctx.lineWidth = 2.5;
	ctx.lineCap = "round";
	// Batched paths have joins where per-segment paths had none, and the canvas
	// default of "miter" throws long spikes wherever noisy elevation data doubles
	// back on itself. Round joins match how the per-segment version looked.
	ctx.lineJoin = "round";

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
			ctx.moveTo(pointX(previous), pointY(previous));
			currentBand = band;
		}

		ctx.lineTo(pointX(current), pointY(current));
	}
	if (currentBand !== -1) ctx.stroke();
}

/**
 * A chart point's distance as the ride's summary counts it, which leaves out
 * GPS jitter and pause gaps that the charts' own, point-to-point distance
 * includes.
 *
 * @param {Object} session
 * @param {{distance: number}} point
 * @param {number} chartDistance - The chart's own total distance.
 * @returns {number} Meters.
 */
function summaryDistance(session, point, chartDistance) {
	const recorded = session.totalDistance;
	return recorded > 0 ? (point.distance / chartDistance) * recorded : point.distance;
}

/**
 * Draws a planned route's elevation profile: one line in the route's own
 * colour over a soft fill, with the grid and min/max labels the ride chart
 * uses. With no points, draws `message` instead.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{distance: number, elevation: number}>} points - Meters.
 * @param {string} color - The line colour, e.g. "#6d4ad8".
 * @param {string} message - Shown when there are no points.
 * @returns {{distanceAt: (x: number) => number, xAt: (distance: number) => number, yAt: (elevation: number) => number, width: number}|null}
 *   Converts between CSS pixels on the canvas and meters along (and up) the
 *   route, for the caller's own pointer handling; null when nothing's drawn.
 */
export function renderProfileChart(canvas, points, color, message) {
	if (points.length < 2) {
		drawEmptyChart(canvas, message);
		return null;
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.floor(rect.width * dpr));
	canvas.height = Math.max(1, Math.floor(rect.height * dpr));
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.scale(dpr, dpr);

	const padding = { top: 4, right: 0, bottom: 4, left: 0 };
	const width = rect.width;
	const height = rect.height;
	const chartHeight = height - padding.top - padding.bottom;
	const totalDistance = Math.max(points[points.length - 1].distance, 1);
	const minElevation = minOf(points, (point) => point.elevation);
	const maxElevation = maxOf(points, (point) => point.elevation);
	const xAt = (distance) => (distance / totalDistance) * width;
	const yAt = (elevation) =>
		maxElevation === minElevation
			? padding.top + chartHeight / 2
			: padding.top + chartHeight - ((elevation - minElevation) / (maxElevation - minElevation)) * chartHeight;

	drawChartBackground(ctx, width, height, padding);

	const floor = height - padding.bottom;
	const fill = ctx.createLinearGradient(0, padding.top, 0, floor);
	fill.addColorStop(0, `${color}38`);
	fill.addColorStop(1, `${color}00`);
	ctx.beginPath();
	ctx.moveTo(xAt(points[0].distance), floor);
	for (const point of points) ctx.lineTo(xAt(point.distance), yAt(point.elevation));
	ctx.lineTo(xAt(points[points.length - 1].distance), floor);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();

	ctx.beginPath();
	points.forEach((point, index) => ctx[index ? "lineTo" : "moveTo"](xAt(point.distance), yAt(point.elevation)));
	ctx.lineWidth = 2.5;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.strokeStyle = color;
	ctx.stroke();

	drawElevationLabels(ctx, height, padding, minElevation, maxElevation, state.prefs.unit, themeColor("--strip-bg", "#fcfcfa"));
	return {
		distanceAt: (x) => Math.max(0, Math.min(1, x / width)) * totalDistance,
		xAt,
		yAt,
		width,
	};
}

/**
 * Wires (or re-wires) a chart canvas's mouse/touch listeners and stashes the
 * current render's geometry on the canvas element so the shared handlers
 * below can map a pointer position back to a chart point without needing
 * their own closures per render. Old listeners are removed first so redrawing
 * the chart (e.g. after a unit change) doesn't stack up duplicate handlers.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} context
 * @param {Object} context.session
 * @param {Array<Object>} context.points - One per `session.points` entry, in
 *   the same order, so an index marks the same spot on the map.
 * @param {{top: number, right: number, bottom: number, left: number}} context.padding
 * @param {number} context.cssWidth
 * @param {(point: Object) => number} context.axisValue - A point's place along
 *   the chart's X axis, in that axis's own units.
 * @param {number} context.axisEnd - The X axis's full length, in those units.
 * @param {(point: Object) => number} context.pointX - CSS pixels across the
 *   chart for a point, to place the readout.
 * @param {(point: Object) => number} context.pointY - CSS pixels down the
 *   chart for a point, to place the dot on the line.
 * @param {HTMLElement} context.cursor - This chart's guide line and dot.
 * @param {HTMLElement} context.readout - This chart's readout.
 * @param {(point: Object, unit: string) => string} context.readoutHtml
 */
function setupChartInteraction(canvas, context) {
	// Remove old listeners if any
	canvas.removeEventListener("mousemove", handleChartMouseMove);
	canvas.removeEventListener("mouseleave", handleChartMouseLeave);
	canvas.removeEventListener("mousedown", handleChartMouseDown);
	canvas.removeEventListener("mouseup", handleChartMouseUp);
	canvas.removeEventListener("touchstart", handleChartTouchStart);
	canvas.removeEventListener("touchmove", handleChartTouchMove);
	canvas.removeEventListener("touchend", handleChartTouchEnd);

	// Store context for event handlers
	canvas.chartContext = context;

	canvas.addEventListener("mousemove", handleChartMouseMove);
	canvas.addEventListener("mouseleave", handleChartMouseLeave);
	canvas.addEventListener("mousedown", handleChartMouseDown);
	canvas.addEventListener("mouseup", handleChartMouseUp);
	canvas.addEventListener("touchstart", handleChartTouchStart);
	canvas.addEventListener("touchmove", handleChartTouchMove);
	canvas.addEventListener("touchend", handleChartTouchEnd);
}

/** Starts a drag and highlights the point under the pointer. @param {MouseEvent} event */
function handleChartMouseDown(event) {
	state.isChartDragging = true;
	updateChartHighlight(event, this);
}

/** Follows the cursor, hovering or dragging. @param {MouseEvent} event */
function handleChartMouseMove(event) {
	updateChartHighlight(event, this);
}

/** Ends a drag. */
function handleChartMouseUp() {
	state.isChartDragging = false;
}

/** Clears the highlight when the pointer leaves the canvas without a drag in progress. */
function handleChartMouseLeave() {
	if (!state.isChartDragging) {
		clearChartHighlight();
	}
}

/** Touch equivalent of `handleChartMouseDown`. @param {TouchEvent} event */
function handleChartTouchStart(event) {
	state.isChartDragging = true;
	updateChartHighlight(event.touches[0], this);
}

/** Touch equivalent of `handleChartMouseMove`, but only while actively dragging. @param {TouchEvent} event */
function handleChartTouchMove(event) {
	if (!state.isChartDragging) return;
	updateChartHighlight(event.touches[0], this);
}

/** Touch equivalent of `handleChartMouseUp`, and also clears the highlight (a lifted finger can't hover). */
function handleChartTouchEnd() {
	state.isChartDragging = false;
	clearChartHighlight();
}

/**
 * Maps a pointer's X position to the nearest chart point along its axis, and if
 * that point differs from the currently-highlighted one, marks it on the
 * chart and the map and reads it out.
 *
 * @param {{clientX: number}} event - A `MouseEvent`, or a `Touch` (both carry `clientX`).
 * @param {HTMLCanvasElement} canvas - The canvas whose `chartContext` (set by
 *   `setupChartInteraction`) supplies this render's geometry.
 */
function updateChartHighlight(event, canvas) {
	const context = canvas?.chartContext;
	if (!context) return;

	const rect = canvas.getBoundingClientRect();
	const x = event.clientX - rect.left;

	// Calculate which point in the chart
	const padding = context.padding;
	const chartWidth = context.cssWidth - padding.left - padding.right;
	const points = context.points;

	if (x < padding.left || x > context.cssWidth - padding.right) {
		clearChartHighlight();
		return;
	}

	// Map X position to a place along the axis
	const relativeX = x - padding.left;
	const target = (relativeX / chartWidth) * context.axisEnd;

	// Find the closest point to it
	let closestIndex = 0;
	let closestDelta = Math.abs(context.axisValue(points[0]) - target);

	for (let i = 1; i < points.length; i++) {
		const delta = Math.abs(context.axisValue(points[i]) - target);
		if (delta < closestDelta) {
			closestDelta = delta;
			closestIndex = i;
		}
	}

	if (closestIndex !== state.highlightedPointIndex) {
		state.highlightedPointIndex = closestIndex;
		highlightPointOnMap(context.session, closestIndex);
		showChartReadout(context, points[closestIndex]);
	}
}

/**
 * Marks a chart point: a guide line down the chart and a dot on the line
 * there, and its numbers in a readout along the chart's top, kept inside the
 * chart's edges.
 *
 * @param {Object} context - The render's `chartContext`.
 * @param {Object} point
 */
function showChartReadout(context, point) {
	const x = context.pointX(point);
	context.cursor.style.left = `${x}px`;
	context.cursor.style.setProperty("--dot-y", `${context.pointY(point)}px`);
	context.cursor.hidden = false;

	const readout = context.readout;
	readout.innerHTML = context.readoutHtml(point, state.prefs.unit);
	readout.hidden = false;
	const half = readout.offsetWidth / 2;
	readout.style.left = `${Math.min(Math.max(x, half), context.cssWidth - half)}px`;
}

/**
 * Moves (creating if necessary) the single chart-highlight marker on the
 * post-ride map to the given point.
 *
 * @param {Object} session
 * @param {number} pointIndex - Index into `session.points`.
 */
function highlightPointOnMap(session, pointIndex) {
	if (!state.postMap || !session.points || !session.points[pointIndex]) return;

	const point = session.points[pointIndex];

	// One marker, moved as the finger slides along the chart.
	if (!state.chartHighlightMarker) {
		const element = document.createElement("div");
		element.className = "chart-highlight-marker";
		state.chartHighlightMarker = new maplibregl.Marker({ element }).setLngLat([point.lng, point.lat]).addTo(state.postMap);
	} else {
		state.chartHighlightMarker.setLngLat([point.lng, point.lat]);
	}
}

/**
 * Removes the chart-highlight marker from the map, if present, and clears
 * the highlighted-point index. Called before every chart redraw and whenever
 * the pointer leaves the chart or a touch ends.
 */
export function clearChartHighlight() {
	if (el.chartCursor) el.chartCursor.hidden = true;
	if (el.chartReadout) el.chartReadout.hidden = true;
	if (el.speedChartCursor) el.speedChartCursor.hidden = true;
	if (el.speedChartReadout) el.speedChartReadout.hidden = true;
	if (state.chartHighlightMarker) {
		state.chartHighlightMarker.remove();
		state.chartHighlightMarker = null;
	}
	state.highlightedPointIndex = -1;
}

/**
 * Converts a session's raw GPS points into chart-ready points: cumulative
 * distance, elevation (holding the last known value across any gap in
 * altitude readings), and speed.
 *
 * @param {Object} session
 * @returns {Array<{distance: number, elevation: number, speed: number}>}
 */
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

/**
 * Converts a session's raw GPS points into the speed chart's points: moving
 * time so far, cumulative distance, and speed.
 *
 * @param {Object} session
 * @returns {Array<{time: number, distance: number, speed: number}>|null}
 *   Null when there's nothing to draw: no moving time, or no speed readings.
 */
function buildSpeedPoints(session) {
	const raw = session.points || [];
	if (raw.length < 2) return null;

	const pauses = Array.isArray(session.pauses) ? session.pauses : [];
	let time = 0;
	let distance = 0;
	const points = raw.map((point, index) => {
		if (index > 0) {
			const previous = raw[index - 1];
			const span = movingMsBetween(previous.timestamp, point.timestamp, pauses);
			if (Number.isFinite(span)) time += span;
			distance += haversineMeters(previous.lat, previous.lng, point.lat, point.lng);
		}
		return { time, distance, speed: Number.isFinite(point.speed) ? point.speed : 0 };
	});

	const totalTime = points[points.length - 1].time;
	if (totalTime <= 0 || maxOf(points, (point) => point.speed) <= 0) return null;
	return points;
}

/**
 * Replaces each of a point's named values with its rolling average over the
 * window centred on that point, which is narrower at the ride's two ends.
 *
 * @param {Array<Object>} points - Modified in place.
 * @param {(point: Object) => number} axisValue - A point's place along the X
 *   axis; must not decrease from one point to the next.
 * @param {number} windowSize - In the axis's own units.
 * @param {Array<string>} keys - The values to smooth.
 */
function smoothPoints(points, axisValue, windowSize, keys) {
	for (const key of keys) {
		// Running totals, so a window of all zeros still averages to exactly zero.
		const totals = [0];
		for (const point of points) totals.push(totals[totals.length - 1] + point[key]);

		let start = 0;
		let end = 0;
		points.forEach((point, index) => {
			const axis = axisValue(point);
			while (end < points.length && axisValue(points[end]) <= axis + windowSize / 2) end += 1;
			while (axisValue(points[start]) < axis - windowSize / 2) start += 1;
			point[key] = (totals[end] - totals[start]) / (end - start);
		});
	}
}

/**
 * Draws a centered placeholder message on the chart canvas, for a ride with
 * no elevation data.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} message
 */
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

/**
 * Reads a CSS custom property from the document root, for the chart to draw
 * in the current light/dark theme's colors.
 *
 * @param {string} name - CSS custom property name, e.g. "--muted".
 * @param {string} fallback - Used if the property is unset or empty.
 * @returns {string}
 */
function themeColor(name, fallback) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Draws the chart's gridlines: hairlines at the top and floor, fainter ones
 * at the thirds.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{top: number, bottom: number}} padding
 */
function drawChartBackground(ctx, width, height, padding) {
	const rule = themeColor("--rule", "rgba(20, 24, 26, 0.1)");
	const hairline = themeColor("--hairline", "rgba(20, 24, 26, 0.07)");
	const top = padding.top;
	const span = height - padding.top - padding.bottom;

	ctx.save();
	ctx.lineWidth = 1;
	for (const [fraction, color] of [
		[0, rule],
		[1 / 3, hairline],
		[2 / 3, hairline],
		[1, rule],
	]) {
		// Half-pixel offset keeps a 1px line crisp.
		const y = Math.round(top + fraction * span) + 0.5;
		ctx.strokeStyle = color;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}
	ctx.restore();
}

/**
 * Draws the highest and lowest elevation readouts, sat on the top and floor
 * gridlines over a patch of page background so the route line does not run
 * through the text.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} height
 * @param {{top: number, bottom: number}} padding
 * @param {number} minElevation - Meters.
 * @param {number} maxElevation - Meters.
 * @param {"imperial"|"metric"} unit
 * @param {string} [background] - What's behind the chart, for the patch
 *   under each label; the page background by default.
 */
function drawElevationLabels(ctx, height, padding, minElevation, maxElevation, unit, background) {
	drawRangeLabels(ctx, height, padding, formatElevation(maxElevation, unit), formatElevation(minElevation, unit), background);
}

/**
 * Draws a chart's top and floor readouts, sat on those gridlines over a patch
 * of page background so the line does not run through the text.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} height
 * @param {{top: number, bottom: number}} padding
 * @param {string} topText
 * @param {string} floorText
 * @param {string} [background] - What's behind the chart, for the patch
 *   under each label; the page background by default.
 */
function drawRangeLabels(ctx, height, padding, topText, floorText, background = themeColor("--bg", "#fcfcfa")) {
	const muted = themeColor("--muted", "#6b7472");

	ctx.save();
	ctx.font = `600 10px ${themeColor("--font", "sans-serif")}`;
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	for (const [text, y] of [
		[topText, padding.top],
		[floorText, height - padding.bottom],
	]) {
		const width = ctx.measureText(text).width + 6;
		ctx.fillStyle = background;
		ctx.fillRect(0, y - 7, width, 14);
		ctx.fillStyle = muted;
		ctx.fillText(text, 0, y);
	}
	ctx.restore();
}
