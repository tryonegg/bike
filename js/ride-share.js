/**
 * Sharing a ride as a picture: a card with the ride's name and date, its
 * route traced in the summary map's speed colours, and its headline numbers,
 * drawn on a canvas and handed to the system share sheet (or downloaded
 * where the browser can't share files). The route is drawn on a plain
 * background rather than over map tiles, so the picture needs no network
 * and shows the route's shape without the streets around it.
 */

import { ACTIVITIES } from "./constants.js";
import { state, el } from "./state.js";
import { formatDistance, formatSpeed, formatElevationValue, formatDuration, maxOf } from "./format.js";
import { speedBand, speedBandColor } from "./colors.js";
import { distanceUnitLabel, speedUnitLabel } from "./map-visuals.js";
import { rideAvgSpeed, sessionTimeTitle } from "./history-view.js";
import { showMessage } from "./modal.js";

// A 4:5 portrait card, the tallest shape the usual feeds show uncropped.
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const CARD_MARGIN = 80;
// The box the route is fitted into.
const ROUTE_TOP = 250;
const ROUTE_BOTTOM = 820;

/**
 * The ride summary's Share button: draws the ride on screen as a picture and
 * shares it, or downloads it where files can't be shared.
 * @returns {Promise<void>}
 */
export async function shareCurrentRide() {
	const session = state.currentPostSession;
	if (!session) return;
	el.shareRideBtn.disabled = true;
	try {
		const blob = await rideCardBlob(session);
		const stamp = new Date(session.date);
		const day = Number.isNaN(stamp.getTime()) ? "ride" : stamp.toISOString().slice(0, 10);
		const file = new File([blob], `${ACTIVITIES[session.activityType || "bike"]?.noun || "ride"}-${day}.png`, { type: "image/png" });
		if (navigator.canShare?.({ files: [file] })) {
			try {
				await navigator.share({ files: [file], title: sessionTimeTitle(session, stamp) });
			} catch (error) {
				// Closing the share sheet isn't a failure.
				if (error.name !== "AbortError") throw error;
			}
			return;
		}
		const url = URL.createObjectURL(file);
		const a = document.createElement("a");
		a.href = url;
		a.download = file.name;
		a.click();
		// Not at once: some browsers (Safari) cancel a download whose URL is gone.
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	} catch (error) {
		console.warn("Sharing the ride failed", error);
		await showMessage("Share Ride", "The picture of this ride couldn't be made.");
	} finally {
		el.shareRideBtn.disabled = false;
	}
}

/**
 * Draws a ride's share card.
 * @param {Object} session - A saved ride.
 * @returns {Promise<Blob>} A PNG.
 */
export async function rideCardBlob(session) {
	// The app's own typeface, when it has loaded; the canvas falls back otherwise.
	await Promise.all([document.fonts?.load('700 60px "Archivo"'), document.fonts?.load('500 30px "Archivo"')]).catch(() => {});

	const canvas = document.createElement("canvas");
	canvas.width = CARD_WIDTH;
	canvas.height = CARD_HEIGHT;
	const ctx = canvas.getContext("2d");
	const styles = getComputedStyle(document.documentElement);
	const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
	const font = (weight, size) => `${weight} ${size}px "Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif`;
	const text = color("--text", "#14181a");
	const muted = color("--muted", "#6b7472");
	const unit = state.prefs.unit;
	const date = new Date(session.date);

	ctx.fillStyle = color("--bg", "#fcfcfa");
	ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

	ctx.textBaseline = "alphabetic";
	ctx.fillStyle = muted;
	ctx.font = font(600, 30);
	const day = Number.isNaN(date.getTime())
		? ""
		: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
	ctx.fillText(day.toUpperCase(), CARD_MARGIN, 120);
	ctx.fillStyle = text;
	ctx.font = font(700, 64);
	ctx.fillText(sessionTimeTitle(session, date), CARD_MARGIN, 196);

	drawRoute(ctx, session.points || [], color("--accent", "#2f8f63"), text);

	// The distance, large, then the other figures in a row under a rule.
	ctx.fillStyle = muted;
	ctx.font = font(700, 26);
	ctx.fillText("DISTANCE", CARD_MARGIN, 905);
	ctx.fillStyle = text;
	ctx.font = font(700, 170);
	const distance = formatDistance(session.totalDistance || 0, unit);
	ctx.fillText(distance, CARD_MARGIN - 6, 1055);
	const distanceWidth = ctx.measureText(distance).width;
	ctx.fillStyle = muted;
	ctx.font = font(500, 56);
	ctx.fillText(distanceUnitLabel(unit), CARD_MARGIN + distanceWidth + 12, 1055);

	ctx.strokeStyle = color("--rule", "rgba(20, 24, 26, 0.1)");
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(CARD_MARGIN, 1105);
	ctx.lineTo(CARD_WIDTH - CARD_MARGIN, 1105);
	ctx.stroke();

	const stats = [
		["MOVING TIME", formatDuration(session.movingTime || 0), ""],
		["AVG SPEED", formatSpeed(rideAvgSpeed(session), unit), speedUnitLabel(unit)],
		["CLIMB", formatElevationValue(session.elevationGain || 0, unit), unit === "imperial" ? "ft" : "m"],
	];
	const column = (CARD_WIDTH - CARD_MARGIN * 2) / stats.length;
	stats.forEach(([label, value, valueUnit], index) => {
		const x = CARD_MARGIN + column * index;
		ctx.fillStyle = muted;
		ctx.font = font(700, 24);
		ctx.fillText(label, x, 1165);
		ctx.fillStyle = text;
		ctx.font = font(700, 60);
		ctx.fillText(value, x, 1238);
		if (valueUnit) {
			const width = ctx.measureText(value).width;
			ctx.fillStyle = muted;
			ctx.font = font(500, 30);
			ctx.fillText(valueUnit, x + width + 10, 1238);
		}
	});

	ctx.fillStyle = muted;
	ctx.font = font(700, 22);
	ctx.textAlign = "right";
	ctx.fillText("BIKE TRACKER", CARD_WIDTH - CARD_MARGIN, 1300);
	ctx.textAlign = "left";

	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The canvas gave no image."))), "image/png");
	});
}

/**
 * Traces the route into its box, coloured by speed as the summary map's line
 * is, with the start and finish dotted. Projected with Web Mercator, as the
 * maps are, so its shape matches them.
 */
function drawRoute(ctx, points, startColor, finishColor) {
	const usable = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
	if (usable.length < 2) return;

	const project = (point) => [point.lng, -Math.log(Math.tan(Math.PI / 4 + (point.lat * Math.PI) / 360)) * (180 / Math.PI)];
	const projected = usable.map(project);
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const [x, y] of projected) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	const boxWidth = CARD_WIDTH - CARD_MARGIN * 2;
	const boxHeight = ROUTE_BOTTOM - ROUTE_TOP;
	// An out-and-back along a straight road has no width (or height) to scale by.
	const scale = Math.min(boxWidth / Math.max(maxX - minX, 1e-9), boxHeight / Math.max(maxY - minY, 1e-9));
	const offsetX = CARD_MARGIN + (boxWidth - (maxX - minX) * scale) / 2;
	const offsetY = ROUTE_TOP + (boxHeight - (maxY - minY) * scale) / 2;
	const place = ([x, y]) => [offsetX + (x - minX) * scale, offsetY + (y - minY) * scale];

	const maxSpeed = Math.max(maxOf(usable, (point) => point.speed || 0), 0.0001);
	ctx.lineWidth = 9;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	// One path per run of the same speed band, rather than one per point pair.
	let band = null;
	for (let i = 1; i < usable.length; i++) {
		const next = speedBand(((usable[i - 1].speed || 0) + (usable[i].speed || 0)) / 2, maxSpeed);
		if (next !== band) {
			if (band !== null) ctx.stroke();
			band = next;
			ctx.strokeStyle = speedBandColor(band);
			ctx.beginPath();
			ctx.moveTo(...place(projected[i - 1]));
		}
		ctx.lineTo(...place(projected[i]));
	}
	ctx.stroke();

	const dot = (at, fill) => {
		const [x, y] = place(at);
		ctx.beginPath();
		ctx.arc(x, y, 15, 0, Math.PI * 2);
		ctx.fillStyle = "#ffffff";
		ctx.fill();
		ctx.beginPath();
		ctx.arc(x, y, 10, 0, Math.PI * 2);
		ctx.fillStyle = fill;
		ctx.fill();
	};
	// Finish first, so the start shows on top where a loop ends where it began.
	dot(projected[projected.length - 1], finishColor);
	dot(projected[0], startColor);
}
