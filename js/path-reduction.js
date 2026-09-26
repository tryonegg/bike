/**
 * Path-reduction framework: a registry of algorithms that thin a ride's
 * recorded points, a builder that carries the speed data across to the points
 * kept, and metrics that score how much a reduction lost. Pure functions, no
 * DOM or app state, so the whole thing runs the same in the Path Lab screen
 * (path-lab.js) and under Node.
 *
 * An algorithm is `reduce(ride, params) -> kept indices` (ascending, always
 * including the first and last point). Everything else — speed averaging,
 * pinning points around pauses, scoring, tuning to a point budget — is done
 * here once, so every algorithm is judged the same way.
 */

import { haversineMeters } from "./format.js";

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LNG = 111320;

// ---------------------------------------------------------------------------
// Preparing a ride
// ---------------------------------------------------------------------------

/**
 * Projects a ride onto a flat meter grid and precomputes what the algorithms
 * and metrics share: cumulative speed sums (for fast span averages, weighted
 * by moving time so a pause doesn't drag an average down) and the points that
 * must survive any reduction because they bracket a pause.
 *
 * @param {Array<{lat: number, lng: number, speed?: number, timestamp: number}>} points
 *   The ride as recorded. This is the truth every reduction is scored against.
 * @param {Array<{start: number, end: number}>} [pauses] - The ride's pauses, epoch ms.
 * @param {Array<{lat: number, lng: number}>|null} [working] - Positions for the
 *   algorithms to work on, one per point, when they differ from the recorded
 *   ones (the points snapped to roads). Kept points are saved at these.
 * @returns {Object} The prepared ride; pass it to `runAlgorithm` and friends.
 */
export function prepareRide(points, pauses = [], working = null) {
	working ??= points;
	const n = points.length;
	const lat0 = n ? points.reduce((sum, p) => sum + p.lat, 0) / n : 0;
	const lng0 = n ? points.reduce((sum, p) => sum + p.lng, 0) / n : 0;
	const lngScale = METERS_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180);

	const x = new Float64Array(n);
	const y = new Float64Array(n);
	const t = new Float64Array(n);
	const v = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		x[i] = (working[i].lng - lng0) * lngScale;
		y[i] = (working[i].lat - lat0) * METERS_PER_DEG_LAT;
		t[i] = points[i].timestamp;
		v[i] = Number.isFinite(points[i].speed) ? points[i].speed : 0;
	}

	// Interval j runs from point j to j+1. Its speed is the mean of its two
	// ends (how the app itself colors a segment) and its weight is the seconds
	// of it actually spent moving. cumW/cumWV are prefix sums over intervals.
	const cumW = new Float64Array(n);
	const cumWV = new Float64Array(n);
	const pinned = new Set(n ? [0, n - 1] : []);
	for (let j = 0; j < n - 1; j++) {
		const dt = t[j + 1] - t[j];
		const paused = pausedMs(t[j], t[j + 1], pauses);
		if (paused > 0) {
			pinned.add(j);
			pinned.add(j + 1);
		}
		const w = Math.max(0, dt - paused) / 1000;
		cumW[j + 1] = cumW[j] + w;
		cumWV[j + 1] = cumWV[j] + w * ((v[j] + v[j + 1]) / 2);
	}

	// Where the rider really was, for scoring; the same arrays when nothing was snapped.
	let tx = x;
	let ty = y;
	if (working !== points) {
		tx = new Float64Array(n);
		ty = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			tx[i] = (points[i].lng - lng0) * lngScale;
			ty[i] = (points[i].lat - lat0) * METERS_PER_DEG_LAT;
		}
	}

	return { points, working, n, x, y, tx, ty, t, v, cumW, cumWV, pinned };
}

function pausedMs(startMs, endMs, pauses) {
	let total = 0;
	for (const pause of pauses) {
		const overlap = Math.min(endMs, pause.end) - Math.max(startMs, pause.start);
		if (overlap > 0) total += overlap;
	}
	return total;
}

/**
 * Moving-time-weighted mean speed over the original intervals from point `a`
 * to point `b`; falls back to the mean of the two ends when no time was spent
 * moving in between (a span that is all pause).
 */
export function meanSpeed(ride, a, b) {
	if (b <= a) return ride.v[a];
	const w = ride.cumW[b] - ride.cumW[a];
	if (w <= 0) return (ride.v[a] + ride.v[b]) / 2;
	return (ride.cumWV[b] - ride.cumWV[a]) / w;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Distance from point p to the segment a-b (clamped to its ends), in meters. */
function segmentDistance(ride, p, a, b) {
	return distanceToSegment(ride.x[p], ride.y[p], ride, a, b);
}

/** Distance from (px, py) to the segment between working points a and b. */
function distanceToSegment(px, py, ride, a, b) {
	const { x, y } = ride;
	const dx = x[b] - x[a];
	const dy = y[b] - y[a];
	const len2 = dx * dx + dy * dy;
	let u = len2 > 0 ? ((px - x[a]) * dx + (py - y[a]) * dy) / len2 : 0;
	u = Math.max(0, Math.min(1, u));
	return Math.hypot(px - (x[a] + u * dx), py - (y[a] + u * dy));
}

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

/**
 * "Matt": the shipped `dataSaver` (live-session.js `determinePointRejection`),
 * replayed over a finished ride. Streaming: a new fix replaces the last kept
 * point, instead of being appended, when the last two kept points and the new
 * one fit a tiny circle, or when the last kept point sits on the line from the
 * one before it to the new fix.
 *
 * `fixCircle` off reproduces the shipped code exactly. There the circle test
 * passes an object where a longitude belongs, which evaluates to NaN, so the
 * test never fires and only the line rule does. On repairs that.
 */
function matt(ride, { threshold, fixCircle }) {
	const pts = ride.working;
	const kept = [];
	for (let i = 0; i < ride.n; i++) {
		if (mattRejects(pts, kept, i, threshold, Boolean(fixCircle))) {
			kept[kept.length - 1] = i;
		} else {
			kept.push(i);
		}
	}
	return kept;
}

function mattRejects(pts, kept, i, threshold, fixCircle) {
	const l = kept.length;
	if (l <= 2) return false;
	const p = pts[i];
	const a = pts[kept[l - 2]];
	const b = pts[kept[l - 1]];

	const centerLat = (p.lat + b.lat + a.lat) / 3;
	const centerLng = (p.lng + b.lng + a.lng) / 3;
	const bLng = fixCircle ? b.lng : NaN;
	if (
		haversineMeters(centerLat, centerLng, p.lat, p.lng) <= threshold &&
		haversineMeters(centerLat, centerLng, b.lat, bLng) <= threshold &&
		haversineMeters(centerLat, centerLng, a.lat, a.lng) <= threshold
	) {
		return true;
	}

	const dLat = p.lat - a.lat;
	const dLng = p.lng - a.lng;
	if (dLat === 0 && dLng === 0) return false;
	const t = -((dLat * (a.lat - b.lat) + dLng * (a.lng - b.lng)) / (dLng * dLng + dLat * dLat));
	return haversineMeters(b.lat, b.lng, a.lat + dLat * t, a.lng + dLng * t) < threshold;
}

/**
 * Douglas–Peucker: keep the point farthest from the chord if it is more than
 * `tolerance` away, and recurse on each half. Position only; it knows nothing
 * about speed. Iterative, so a long ride can't overflow the stack.
 */
function douglasPeucker(ride, { tolerance }) {
	return splitRanges(ride, (s, e) => {
		let worst = -1;
		let worstDist = tolerance;
		for (let i = s + 1; i < e; i++) {
			const d = segmentDistance(ride, i, s, e);
			if (d > worstDist) {
				worstDist = d;
				worst = i;
			}
		}
		return worst;
	});
}

/**
 * Douglas–Peucker that also splits where speed departs from the span's own
 * average, so a stop, a sprint or a hard brake survives even on a dead-straight
 * road. A point's score is the larger of its position error over `tolerance`
 * and its speed error over `tolerance * speedPerMeter`; the span splits at the
 * worst point scoring above 1. One knob, so it tunes to a budget like the rest.
 */
function speedAwareDP(ride, { tolerance, speedPerMeter }) {
	const speedTol = tolerance * speedPerMeter;
	return splitRanges(ride, (s, e) => {
		const avg = meanSpeed(ride, s, e);
		let worst = -1;
		let worstScore = 1;
		for (let i = s + 1; i < e; i++) {
			const score = Math.max(segmentDistance(ride, i, s, e) / tolerance, Math.abs(ride.v[i] - avg) / speedTol);
			if (score > worstScore) {
				worstScore = score;
				worst = i;
			}
		}
		return worst;
	});
}

/** Shared split loop: `pick(s, e)` returns the index to split (s,e) at, or -1. */
function splitRanges(ride, pick) {
	const n = ride.n;
	if (n < 3) return Array.from({ length: n }, (_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack = [[0, n - 1]];
	while (stack.length) {
		const [s, e] = stack.pop();
		if (e - s < 2) continue;
		const split = pick(s, e);
		if (split < 0) continue;
		keep[split] = 1;
		stack.push([s, split], [split, e]);
	}
	return indicesOf(keep);
}

/**
 * Visvalingam–Whyatt: repeatedly drop the point whose triangle with its two
 * neighbours has the least area, until the least is `minArea` m². Favors
 * keeping corners over slight wiggles. Position only.
 */
function visvalingam(ride, { minArea }) {
	const n = ride.n;
	if (n < 3) return Array.from({ length: n }, (_, i) => i);
	const prev = new Int32Array(n);
	const next = new Int32Array(n);
	const version = new Int32Array(n);
	const removed = new Uint8Array(n);
	const area = (i) =>
		Math.abs(
			(ride.x[i] - ride.x[prev[i]]) * (ride.y[next[i]] - ride.y[prev[i]]) -
				(ride.x[next[i]] - ride.x[prev[i]]) * (ride.y[i] - ride.y[prev[i]]),
		) / 2;

	const heap = new MinHeap();
	for (let i = 0; i < n; i++) {
		prev[i] = i - 1;
		next[i] = i + 1;
	}
	for (let i = 1; i < n - 1; i++) heap.push(area(i), i, 0);

	let floor = 0;
	while (heap.size) {
		const [a, i, ver] = heap.pop();
		if (removed[i] || ver !== version[i]) continue;
		floor = Math.max(floor, a);
		if (floor >= minArea) break;
		removed[i] = 1;
		const p = prev[i];
		const q = next[i];
		next[p] = q;
		prev[q] = p;
		for (const k of [p, q]) {
			if (k > 0 && k < n - 1) heap.push(area(k), k, ++version[k]);
		}
	}
	const keep = new Uint8Array(n);
	for (let i = 0; i < n; i++) keep[i] = removed[i] ? 0 : 1;
	return indicesOf(keep);
}

class MinHeap {
	constructor() {
		this.items = [];
	}
	get size() {
		return this.items.length;
	}
	push(key, a, b) {
		const items = this.items;
		items.push([key, a, b]);
		let i = items.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (items[parent][0] <= items[i][0]) break;
			[items[parent], items[i]] = [items[i], items[parent]];
			i = parent;
		}
	}
	pop() {
		const items = this.items;
		const top = items[0];
		const last = items.pop();
		if (items.length) {
			items[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < items.length && items[l][0] < items[m][0]) m = l;
				if (r < items.length && items[r][0] < items[m][0]) m = r;
				if (m === i) break;
				[items[m], items[i]] = [items[i], items[m]];
				i = m;
			}
		}
		return top;
	}
}

/**
 * Sliding corridor: grow a line out from the last kept point for as long as
 * every fix since it stays within `tolerance` of the line, then keep the point
 * before the one that broke it. Streaming with a guaranteed error bound, so it
 * could run live on the phone as fixes arrive.
 */
function slidingCorridor(ride, { tolerance }) {
	const n = ride.n;
	const kept = [0];
	let anchor = 0;
	let j = 2;
	while (j < n) {
		let ok = true;
		for (let k = anchor + 1; k < j; k++) {
			if (segmentDistance(ride, k, anchor, j) > tolerance) {
				ok = false;
				break;
			}
		}
		if (ok) {
			j++;
		} else {
			anchor = j - 1;
			kept.push(anchor);
			j = anchor + 2;
		}
	}
	if (kept[kept.length - 1] !== n - 1) kept.push(n - 1);
	return kept;
}

/** Keeps a point only once it is `spacing` meters from the last one kept. */
function minSpacing(ride, { spacing }) {
	const n = ride.n;
	const kept = [0];
	let last = 0;
	for (let i = 1; i < n - 1; i++) {
		if (Math.hypot(ride.x[i] - ride.x[last], ride.y[i] - ride.y[last]) >= spacing) {
			kept.push(i);
			last = i;
		}
	}
	if (n > 1) kept.push(n - 1);
	return kept;
}

/** Keeps a point every `interval` seconds, whatever the rider is doing. */
function timeInterval(ride, { interval }) {
	const n = ride.n;
	const kept = [0];
	let lastT = ride.t[0];
	for (let i = 1; i < n - 1; i++) {
		if ((ride.t[i] - lastT) / 1000 >= interval) {
			kept.push(i);
			lastT = ride.t[i];
		}
	}
	if (n > 1) kept.push(n - 1);
	return kept;
}

function indicesOf(keep) {
	const out = [];
	for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(i);
	return out;
}

/**
 * The registry. The first entry of `params` is the algorithm's main knob:
 * larger always means fewer points, and it is what `tuneToCount` bisects on.
 * Add an algorithm by adding an entry here; nothing else needs to change.
 */
export const ALGORITHMS = [
	{
		id: "matt",
		name: "Matt",
		note: "The shipped data saver, replayed. Streaming.",
		params: [
			{ key: "threshold", label: "Threshold", unit: "m", min: 0.05, max: 300, default: 1 },
			{ key: "fixCircle", label: "Repair circle test", fixed: 0 },
		],
		reduce: matt,
	},
	{
		id: "dp",
		name: "Douglas–Peucker",
		note: "Keeps the farthest point from the chord, recursively. Position only.",
		params: [{ key: "tolerance", label: "Tolerance", unit: "m", min: 0.05, max: 300, default: 3 }],
		reduce: douglasPeucker,
	},
	{
		id: "dp-speed",
		name: "Speed-aware DP",
		note: "Douglas–Peucker that also keeps points where speed departs from the span's average.",
		params: [
			{ key: "tolerance", label: "Tolerance", unit: "m", min: 0.05, max: 300, default: 3 },
			{ key: "speedPerMeter", label: "m/s per m", fixed: 0.25 },
		],
		reduce: speedAwareDP,
	},
	{
		id: "vw",
		name: "Visvalingam–Whyatt",
		note: "Drops the least-significant triangle first. Favors corners. Position only.",
		params: [{ key: "minArea", label: "Min area", unit: "m²", min: 0.05, max: 200000, default: 10 }],
		reduce: visvalingam,
	},
	{
		id: "corridor",
		name: "Sliding corridor",
		note: "Streaming line-fit with a hard error bound. Position only.",
		params: [{ key: "tolerance", label: "Tolerance", unit: "m", min: 0.05, max: 300, default: 3 }],
		reduce: slidingCorridor,
	},
	{
		id: "spacing",
		name: "Min spacing",
		note: "Baseline: one point per N meters travelled.",
		params: [{ key: "spacing", label: "Spacing", unit: "m", min: 0.05, max: 1000, default: 10 }],
		reduce: minSpacing,
	},
	{
		id: "time",
		name: "Fixed interval",
		note: "Baseline: one point per N seconds.",
		params: [{ key: "interval", label: "Interval", unit: "s", min: 1, max: 600, default: 5 }],
		reduce: timeInterval,
	},
];

/** Default values for every param of an algorithm, `fixed` ones included. */
export function defaultParams(algo) {
	return Object.fromEntries(algo.params.map((p) => [p.key, p.fixed ?? p.default]));
}

// ---------------------------------------------------------------------------
// Running, speed-preserving output, scoring
// ---------------------------------------------------------------------------

/**
 * Runs one algorithm and returns everything the lab shows: the kept indices,
 * the points that would be saved, and the metrics.
 *
 * @param {Object} ride - From `prepareRide`.
 * @param {Object} algo - An entry of `ALGORITHMS`.
 * @param {Object} [params] - Overrides for the algorithm's defaults.
 * @param {{pinPauses?: boolean}} [options] - `pinPauses` (default true) also
 *   keeps the points either side of a pause, so no span averages across one.
 */
export function runAlgorithm(ride, algo, params = {}, { pinPauses = true } = {}) {
	const merged = { ...defaultParams(algo), ...params };
	let indices = ride.n ? algo.reduce(ride, merged) : [];
	if (pinPauses && ride.pinned.size > 2) {
		indices = [...new Set([...indices, ...ride.pinned])].sort((a, b) => a - b);
	}
	const kept = buildKeptPoints(ride, indices);
	return { algo, params: merged, indices, kept, metrics: scoreReduction(ride, indices, kept) };
}

/**
 * Turns kept indices into the points to save, carrying speed across.
 *
 * `speed` is the drop-in value: what the existing point format can hold, and
 * the app colors a segment by the mean of its two ends, so each kept point
 * gets the moving-time-weighted mean over the window centered on it (half of
 * each neighbouring span). `segSpeed` is the exact mean over the span running
 * forward to the next kept point, for a format that stores speed per segment.
 * `rawSpeed` is the point's own reading, kept only to compare against.
 */
export function buildKeptPoints(ride, indices) {
	const m = indices.length;
	const kept = new Array(m);
	for (let k = 0; k < m; k++) {
		const i = indices[k];
		const lo = k === 0 ? i : (indices[k - 1] + i) >> 1;
		const hi = k === m - 1 ? i : (i + indices[k + 1]) >> 1;
		kept[k] = {
			...ride.points[i],
			lat: ride.working[i].lat,
			lng: ride.working[i].lng,
			speed: hi > lo ? meanSpeed(ride, lo, hi) : ride.v[i],
			segSpeed: k < m - 1 ? meanSpeed(ride, i, indices[k + 1]) : null,
			rawSpeed: ride.v[i],
			index: i,
		};
	}
	return kept;
}

/**
 * Scores a reduction against the original ride.
 *
 * Position error is each recorded point's distance to the span that replaced
 * it, so with snapped positions it includes how far the snap moved the point.
 * Speed error is each original point's reading against the speed a reader of
 * the saved data would get back there: `speedErr` interpolates the drop-in
 * vertex speeds over time, `segSpeedErr` reads the per-segment speed.
 * `peakKept` is the reduced ride's top speed over the original's; averaging
 * flattens peaks, so the session's own max speed is what a stats screen needs.
 */
export function scoreReduction(ride, indices, kept) {
	const n = ride.n;
	const m = indices.length;
	if (!n || m < 2) return emptyMetrics(n, m);

	const posErr = new Float64Array(n);
	const speedDiff = new Float64Array(n);
	const segDiff = new Float64Array(n);
	let length = 0;
	let keptLength = 0;
	for (let i = 1; i < n; i++) length += Math.hypot(ride.tx[i] - ride.tx[i - 1], ride.ty[i] - ride.ty[i - 1]);

	for (let k = 0; k < m - 1; k++) {
		const s = indices[k];
		const e = indices[k + 1];
		keptLength += Math.hypot(ride.x[e] - ride.x[s], ride.y[e] - ride.y[s]);
		const v0 = kept[k].speed;
		const v1 = kept[k + 1].speed;
		const span = ride.t[e] - ride.t[s];
		for (let i = s; i < e; i++) {
			posErr[i] = distanceToSegment(ride.tx[i], ride.ty[i], ride, s, e);
			const u = span > 0 ? (ride.t[i] - ride.t[s]) / span : 0;
			speedDiff[i] = Math.abs(ride.v[i] - (v0 + (v1 - v0) * u));
			segDiff[i] = Math.abs(ride.v[i] - kept[k].segSpeed);
		}
	}

	const last = indices[m - 1];
	posErr[last] = Math.hypot(ride.tx[last] - ride.x[last], ride.ty[last] - ride.y[last]);

	let peakOrig = 0;
	let peakKept = 0;
	for (let i = 0; i < n; i++) peakOrig = Math.max(peakOrig, ride.v[i]);
	for (const p of kept) peakKept = Math.max(peakKept, p.speed);

	return {
		original: n,
		kept: m,
		keptFraction: m / n,
		bytes: JSON.stringify(kept.map(storedShape)).length,
		originalBytes: JSON.stringify(ride.points).length,
		posMean: mean(posErr),
		posP95: percentile(posErr, 0.95),
		posMax: max(posErr),
		lengthChange: length > 0 ? (keptLength - length) / length : 0,
		speedMean: mean(speedDiff),
		speedMax: max(speedDiff),
		segSpeedMean: mean(segDiff),
		segSpeedMax: max(segDiff),
		peakKept: peakOrig > 0 ? peakKept / peakOrig : 1,
	};
}

/** A kept point as it would actually be saved: the working fields are dropped. */
function storedShape({ segSpeed, rawSpeed, index, ...saved }) {
	return saved;
}

function emptyMetrics(n, m) {
	return {
		original: n,
		kept: m,
		keptFraction: n ? m / n : 0,
		bytes: 0,
		originalBytes: 0,
		posMean: 0,
		posP95: 0,
		posMax: 0,
		lengthChange: 0,
		speedMean: 0,
		speedMax: 0,
		segSpeedMean: 0,
		segSpeedMax: 0,
		peakKept: 1,
	};
}

function mean(arr) {
	let sum = 0;
	for (let i = 0; i < arr.length; i++) sum += arr[i];
	return arr.length ? sum / arr.length : 0;
}

function max(arr) {
	let best = 0;
	for (let i = 0; i < arr.length; i++) if (arr[i] > best) best = arr[i];
	return best;
}

function percentile(arr, q) {
	if (!arr.length) return 0;
	const sorted = Float64Array.from(arr).sort();
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// ---------------------------------------------------------------------------
// Comparing at equal size
// ---------------------------------------------------------------------------

/**
 * Sets an algorithm's main knob so it keeps about `targetCount` points, by
 * bisecting on a log scale between the knob's limits. Comparing algorithms at
 * the same point count is the fair test: which one loses least for the same
 * storage. Pinned pauses are part of the count.
 *
 * @returns {Object} The `runAlgorithm` result nearest the target.
 */
export function tuneToCount(ride, algo, targetCount, options = {}) {
	const knob = algo.params[0];
	let lo = Math.log(knob.min);
	let hi = Math.log(knob.max);
	let best = null;
	for (let step = 0; step < 22; step++) {
		const mid = (lo + hi) / 2;
		const result = runAlgorithm(ride, algo, { [knob.key]: Math.exp(mid) }, options);
		if (!best || Math.abs(result.kept.length - targetCount) < Math.abs(best.kept.length - targetCount)) best = result;
		if (result.kept.length === targetCount) break;
		if (result.kept.length > targetCount) lo = mid;
		else hi = mid;
	}
	return best;
}

/**
 * Runs every algorithm on one ride, each tuned to the same point budget, plus
 * Matt exactly as shipped for reference.
 *
 * @param {Object} ride - From `prepareRide`.
 * @param {number} keepFraction - Share of the original points to keep, 0-1.
 * @returns {Array<Object>} `runAlgorithm` results, tagged with `label`.
 */
export function compareAll(ride, keepFraction, options = {}) {
	const target = Math.max(2, Math.round(ride.n * keepFraction));
	const shipped = runAlgorithm(ride, ALGORITHMS[0], {}, options);
	const results = [{ ...shipped, label: "Matt (as shipped)", id: "matt-shipped" }];
	for (const algo of ALGORITHMS) {
		results.push({ ...tuneToCount(ride, algo, target, options), label: algo.name, id: algo.id });
	}
	return results;
}
