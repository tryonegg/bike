/**
 * Elevation charts. Mostly the post-ride one: drawing it onto a `<canvas>`
 * (elevation line colored by speed band, gridlines, min/max labels) and the
 * mouse/touch interaction that highlights a point on the post-ride map as
 * the finger or cursor moves along the chart. Also the route planner's
 * simpler profile (`renderProfileChart`), which shares the grid and labels.
 */

import { state, el } from "./state.js";
import { minOf, maxOf, haversineMeters, formatElevation } from "./format.js";
import { speedBand, speedBandColor } from "./colors.js";

/**
 * Draws the elevation-vs-distance chart for a session onto `el.elevationChart`,
 * or an empty-state message when the ride has no elevation data, and (re)wires
 * up the mouse/touch handlers that highlight a point on the map as the reader
 * traces the line.
 *
 * @param {Object} session - A saved (or live) ride session with a `points` array.
 */
export function renderElevationChart(session) {
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

	const minElevation = minOf(points, (point) => point.elevation);
	const maxElevation = maxOf(points, (point) => point.elevation);
	const maxSpeed = Math.max(maxOf(points, (point) => point.speed), 0.0001);

	const xFor = (distance) => padding.left + (distance / totalDistance) * chartWidth;
	const yFor = (elevation) => {
		if (maxElevation === minElevation) return padding.top + chartHeight / 2;
		return padding.top + chartHeight - ((elevation - minElevation) / (maxElevation - minElevation)) * chartHeight;
	};

	drawChartBackground(ctx, cssWidth, cssHeight, padding);

	// A soft fill under the line, fading to nothing at the floor.
	const floor = cssHeight - padding.bottom;
	const fill = ctx.createLinearGradient(0, padding.top, 0, floor);
	fill.addColorStop(0, "rgba(143, 201, 58, 0.22)");
	fill.addColorStop(1, "rgba(143, 201, 58, 0)");
	ctx.beginPath();
	ctx.moveTo(xFor(points[0].distance), floor);
	for (const point of points) ctx.lineTo(xFor(point.distance), yFor(point.elevation));
	ctx.lineTo(xFor(points[points.length - 1].distance), floor);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();

	ctx.lineWidth = 2.5;
	ctx.lineCap = "round";
	// Batched paths have joins where per-segment paths had none, and the canvas
	// default of "miter" throws long spikes wherever noisy elevation data doubles
	// back on itself. Round joins match how the per-segment version looked.
	ctx.lineJoin = "round";

	// Stroke one path per contiguous run of the same speed band instead of one
	// path per point pair.
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
			ctx.moveTo(xFor(previous.distance), yFor(previous.elevation));
			currentBand = band;
		}

		ctx.lineTo(xFor(current.distance), yFor(current.elevation));
	}
	if (currentBand !== -1) ctx.stroke();

	drawElevationLabels(ctx, cssHeight, padding, minElevation, maxElevation, displayUnit);

	// Add event listeners for chart interaction
	setupChartInteraction(canvas, session, points, padding, cssWidth, cssHeight, minElevation, maxElevation, totalDistance, xFor, yFor);
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
 * @returns {{distanceAt: (x: number) => number, xAt: (distance: number) => number}|null}
 *   Converts between CSS pixels across the canvas and meters along the
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
	};
}

/**
 * Wires (or re-wires) the chart canvas's mouse/touch listeners and stashes
 * the current render's geometry on the canvas element so the shared handlers
 * below can map a pointer position back to a chart point without needing
 * their own closures per render. Old listeners are removed first so redrawing
 * the chart (e.g. after a unit change) doesn't stack up duplicate handlers.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} session
 * @param {Array<{distance: number, elevation: number, speed: number}>} points
 * @param {{top: number, right: number, bottom: number, left: number}} padding
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} minElevation
 * @param {number} maxElevation
 * @param {number} totalDistance
 * @param {(distance: number) => number} xFor - Unused by the handlers
 *   (recomputed from the stashed context instead) but accepted to mirror the
 *   render call site.
 * @param {(elevation: number) => number} yFor - Same as `xFor`.
 */
function setupChartInteraction(canvas, session, points, padding, cssWidth, cssHeight, minElevation, maxElevation, totalDistance, xFor, yFor) {
	// Remove old listeners if any
	canvas.removeEventListener("mousemove", handleChartMouseMove);
	canvas.removeEventListener("mouseleave", handleChartMouseLeave);
	canvas.removeEventListener("mousedown", handleChartMouseDown);
	canvas.removeEventListener("mouseup", handleChartMouseUp);
	canvas.removeEventListener("touchstart", handleChartTouchStart);
	canvas.removeEventListener("touchmove", handleChartTouchMove);
	canvas.removeEventListener("touchend", handleChartTouchEnd);

	// Store context for event handlers
	canvas.chartContext = { session, points, padding, cssWidth, cssHeight, minElevation, maxElevation, totalDistance };

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

/**
 * Updates the highlight while dragging, or while merely hovering with the
 * button held (`event.buttons` catches a drag that started outside the canvas).
 * @param {MouseEvent} event
 */
function handleChartMouseMove(event) {
	if (!state.isChartDragging && event.buttons === 0) return;
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
 * Maps a pointer's X position to the nearest chart point by distance, and if
 * that point differs from the currently-highlighted one, moves the map
 * highlight marker to it.
 *
 * @param {{clientX: number}} event - A `MouseEvent`, or a `Touch` (both carry `clientX`).
 * @param {HTMLCanvasElement} canvas - The canvas whose `chartContext` (set by
 *   `setupChartInteraction`) supplies this render's geometry.
 */
function updateChartHighlight(event, canvas) {
	const context = canvas?.chartContext;
	if (!context || !state.postMap) return;

	const rect = canvas.getBoundingClientRect();
	const x = event.clientX - rect.left;

	// Calculate which point in the chart
	const padding = context.padding;
	const chartWidth = context.cssWidth - padding.left - padding.right;
	const totalDistance = context.totalDistance;
	const points = context.points;

	if (x < padding.left || x > context.cssWidth - padding.right) {
		clearChartHighlight();
		return;
	}

	// Map X position to distance
	const relativeX = x - padding.left;
	const distanceRatio = relativeX / chartWidth;
	const targetDistance = distanceRatio * totalDistance;

	// Find the closest point with distance <= targetDistance
	let closestIndex = 0;
	let closestDelta = Math.abs(points[0].distance - targetDistance);

	for (let i = 1; i < points.length; i++) {
		const delta = Math.abs(points[i].distance - targetDistance);
		if (delta < closestDelta) {
			closestDelta = delta;
			closestIndex = i;
		}
	}

	if (closestIndex !== state.highlightedPointIndex) {
		state.highlightedPointIndex = closestIndex;
		highlightPointOnMap(context.session, closestIndex);
	}
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
function drawElevationLabels(ctx, height, padding, minElevation, maxElevation, unit, background = themeColor("--bg", "#fcfcfa")) {
	const muted = themeColor("--muted", "#6b7472");

	ctx.save();
	ctx.font = `600 10px ${themeColor("--font", "sans-serif")}`;
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	for (const [text, y] of [
		[formatElevation(maxElevation, unit), padding.top],
		[formatElevation(minElevation, unit), height - padding.bottom],
	]) {
		const width = ctx.measureText(text).width + 6;
		ctx.fillStyle = background;
		ctx.fillRect(0, y - 7, width, 14);
		ctx.fillStyle = muted;
		ctx.fillText(text, 0, y);
	}
	ctx.restore();
}
