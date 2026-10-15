/**
 * The grade on the live ride screen: how steeply the stretch just ridden
 * climbs or drops, as a percentage in a chip under the ride stats while
 * it's on a slope. Heights come from the terrain tiles (terrain.js) rather
 * than GPS altitude, which wanders by meters from fix to fix: more than a
 * short stretch of road rises. Not shown on the water, which is flat.
 */

import { GRADE_WINDOW_M, GRADE_STEP_M, GRADE_SHOW, GRADE_HIDE, GRADE_MODERATE, GRADE_STEEP } from "./constants.js";
import { el } from "./state.js";
import { haversineMeters } from "./format.js";
import { heightAt } from "./terrain.js";

// Bumped by every update, so a lookup still waiting on a terrain tile when a
// newer fix comes in, or the ride pauses, can't overwrite what's shown.
let latest = 0;

/**
 * Called on every live GPS fix: works out the grade over the last stretch
 * ridden and shows or hides the chip to match.
 *
 * @param {Object} session - The current ride.
 * @returns {Promise<void>}
 */
export async function updateGrade(session) {
	const request = ++latest;
	if (session.activityType === "kayak") return;
	const grade = await trailingGrade(session.points);
	if (request === latest) renderGrade(grade);
}

/** Hides the grade chip, as when the ride pauses or ends. */
export function hideGrade() {
	latest++;
	el.gradeChip.hidden = true;
}

/**
 * The slope of the last GRADE_WINDOW_M of a track: a least-squares line
 * through terrain heights every GRADE_STEP_M back along it, which irons out
 * the meter or so of roughness in the terrain data itself.
 *
 * @param {Array<{lat: number, lng: number}>} points - The ride so far.
 * @returns {Promise<number>} Rise over run, positive uphill in the direction
 *   of travel. NaN until the ride is GRADE_WINDOW_M long, or where a terrain
 *   tile can't be had.
 */
async function trailingGrade(points) {
	// Every GRADE_STEP_M back from the rider, interpolated along the track.
	const samples = [];
	let next = 0;
	let back = 0;
	for (let i = points.length - 1; i > 0 && next <= GRADE_WINDOW_M; i--) {
		const a = points[i];
		const b = points[i - 1];
		const length = haversineMeters(a.lat, a.lng, b.lat, b.lng);
		while (next <= back + length && next <= GRADE_WINDOW_M) {
			const t = length ? (next - back) / length : 0;
			samples.push([a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t]);
			next += GRADE_STEP_M;
		}
		back += length;
	}
	if (next <= GRADE_WINDOW_M) return NaN;

	const heights = await Promise.all(samples.map(heightAt));
	if (heights.includes(null)) return NaN;
	// Sample k is k steps back, so its distance ahead of the samples' middle is
	// half the window less k steps.
	const meanHeight = heights.reduce((sum, height) => sum + height, 0) / heights.length;
	let rise = 0;
	let run = 0;
	heights.forEach((height, k) => {
		const ahead = GRADE_WINDOW_M / 2 - k * GRADE_STEP_M;
		rise += ahead * (height - meanHeight);
		run += ahead * ahead;
	});
	return rise / run;
}

/**
 * Shows a grade in the chip, its wedge leaning with the slope and tinted by
 * how steep the figure shown is, or hides the chip on the flat or with no
 * grade to show.
 *
 * @param {number} grade - Rise over run, or NaN.
 */
function renderGrade(grade) {
	const chip = el.gradeChip;
	const steepness = Math.abs(grade);
	if (!(steepness >= (chip.hidden ? GRADE_SHOW : GRADE_HIDE))) {
		chip.hidden = true;
		return;
	}
	const percent = Math.round(steepness * 100);
	const climbing = grade > 0;
	chip.hidden = false;
	chip.dataset.slope = climbing ? "up" : "down";
	chip.dataset.steepness = percent / 100 >= GRADE_STEEP ? "steep" : percent / 100 >= GRADE_MODERATE ? "moderate" : "gentle";
	el.gradeValue.textContent = `${climbing ? "" : "−"}${percent}%`;
	chip.setAttribute("aria-label", `${percent}% ${climbing ? "climb" : "descent"}`);
}
