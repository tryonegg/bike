// Best past pace during a ride, read off the best pace map (pace-map.js): the
// map's sections indexed by location so the live map can find the section the
// rider is on and the sections on the roads ahead, plus the rider's own pace
// over the stretch just ridden to compare against.
//
// Pure computation on stored sections; the app decides what to draw.

// Pace is distance over time for the last stretch of this length. A single GPS
// speed reading spikes; a stretch average is stable, and close to the length
// of a map section, which is what "best" is measured over.
const PACE_WINDOW_M = 150;
// The rider's own pace needs at least this much of the stretch behind them.
const MIN_CURRENT_WINDOW_M = 40;
// A stretch never reaches back across a pause or a GPS dropout this long.
const GAP_MS = 10000;
// Nor across a jump this long between consecutive points.
const GAP_M = 60;

// The rider is on a section within this distance, running within this
// heading of theirs.
const MATCH_RADIUS_M = 25;
const MATCH_HEADING_DEG = 45;
// Sections are indexed by points this far apart along them.
const SAMPLE_SPACING_M = 8;
// Grid cell size for the lookup; the 3x3 cells around a point cover the radius.
const CELL_M = 50;
// Ahead means within this angle either side of the rider's heading. Within
// NEAR_RIDER_M direction says nothing, so only the section's own heading
// decides whether it is the rider's road.
const AHEAD_DEG = 100;
const NEAR_RIDER_M = 30;
// A section whose far end is this close to the rider has been ridden past.
const END_PASSED_M = 5;

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;

/** @param {number} lat - Degrees. @returns {number} Meters per degree of longitude at that latitude. */
function metersPerDegLng(lat) {
	return M_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

/**
 * Flat-earth distance between two lat/lng points — plenty accurate at the
 * scale this module compares over, and much cheaper than a great-circle
 * formula run on every live fix.
 *
 * @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2
 * @returns {number} Meters.
 */
function localDistance(lat1, lng1, lat2, lng2) {
	const dx = (lng2 - lng1) * metersPerDegLng((lat1 + lat2) / 2);
	const dy = (lat2 - lat1) * M_PER_DEG_LAT;
	return Math.hypot(dx, dy);
}

/**
 * Flat-earth bearing from one point to another (see `localDistance` for the
 * same approximation).
 * @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2
 * @returns {number} Degrees clockwise from north, in [0, 360).
 */
function localBearing(lat1, lng1, lat2, lng2) {
	const dx = (lng2 - lng1) * metersPerDegLng((lat1 + lat2) / 2);
	const dy = (lat2 - lat1) * M_PER_DEG_LAT;
	return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/**
 * The angular difference between two headings, taking the shorter way around.
 * @param {number} a @param {number} b - Degrees.
 * @returns {number} Degrees, in [0, 180].
 */
function headingDifference(a, b) {
	const diff = Math.abs(a - b) % 360;
	return diff > 180 ? 360 - diff : diff;
}

/**
 * How far a section's heading at some point is from the rider's: a flat
 * section shared by both directions runs whichever way the rider does.
 * @param {Object} section @param {number} sectionHeading @param {number} heading - Degrees.
 * @returns {number} Degrees, in [0, 180] (or [0, 90] for a two-way section).
 */
function headingOff(section, sectionHeading, heading) {
	const diff = headingDifference(sectionHeading, heading);
	return section.bothWays ? Math.min(diff, 180 - diff) : diff;
}

/** @param {number} lat @param {number} lng @returns {[number, number]} This point's grid cell, [row, col]. */
function cellOf(lat, lng) {
	return [Math.floor((lat * M_PER_DEG_LAT) / CELL_M), Math.floor((lng * metersPerDegLng(lat)) / CELL_M)];
}

/**
 * Whether a step between two consecutive points is a pause/dropout that
 * should break a pace stretch, rather than ordinary riding.
 * @param {number} tMs - Milliseconds since the previous point.
 * @param {number} dMeters - Distance from the previous point.
 * @returns {boolean}
 */
function isGap(tMs, dMeters) {
	return tMs > GAP_MS || dMeters > GAP_M;
}

/**
 * The slow-to-fast color range for a set of sections: the 10th and 90th
 * percentile of their best paces, so red and green mean slow and fast for
 * this rider, not for some fixed speed, and one freak section doesn't
 * squash every other color together.
 *
 * @param {Array<{best: number|null}>} sections
 * @returns {{slow: number, fast: number}} m/s; both 0 with no timed sections.
 */
export function paceRange(sections) {
	const paces = sections.map((section) => section.best).filter(Number.isFinite).sort((a, b) => a - b);
	if (!paces.length) return { slow: 0, fast: 0 };
	const quantile = (q) => paces[Math.min(paces.length - 1, Math.floor(q * paces.length))];
	return { slow: quantile(0.1), fast: quantile(0.9) };
}

/**
 * Indexes the best pace map's sections for live lookups: points every few
 * meters along each one, each with the section's heading there, bucketed
 * into a grid.
 *
 * @param {Array<Object>} sections - Records from pace-map.js, one activity's.
 * @returns {{sections: Array<Object>, cells: Map<string, Array<{s: number,
 *   lat: number, lng: number, heading: number}>>, slow: number, fast: number}}
 */
export function buildSectionIndex(sections) {
	const cells = new Map();
	sections.forEach((section, s) => {
		const coords = section.coords;
		for (let k = 1; k < coords.length; k++) {
			const [lngA, latA] = coords[k - 1];
			const [lngB, latB] = coords[k];
			const step = localDistance(latA, lngA, latB, lngB);
			if (!step) continue;
			const heading = localBearing(latA, lngA, latB, lngB);
			const count = Math.max(1, Math.ceil(step / SAMPLE_SPACING_M));
			for (let i = k === 1 ? 0 : 1; i <= count; i++) {
				const lat = latA + ((latB - latA) * i) / count;
				const lng = lngA + ((lngB - lngA) * i) / count;
				const key = cellOf(lat, lng).join(":");
				const list = cells.get(key);
				const sample = { s, lat, lng, heading };
				if (list) list.push(sample);
				else cells.set(key, [sample]);
			}
		}
	});
	return { sections, cells, ...paceRange(sections) };
}

/**
 * The section the rider is on: the nearest within `MATCH_RADIUS_M` running
 * the rider's way.
 *
 * @param {Object} index - From `buildSectionIndex`.
 * @param {number} lat @param {number} lng
 * @param {number} heading - Degrees.
 * @returns {Object|null} The section record, or null off the map.
 */
export function sectionAt(index, lat, lng, heading) {
	const [row, col] = cellOf(lat, lng);
	let best = null;
	let bestDistance = MATCH_RADIUS_M;
	for (let r = row - 1; r <= row + 1; r++) {
		for (let c = col - 1; c <= col + 1; c++) {
			for (const sample of index.cells.get(`${r}:${c}`) ?? []) {
				if (Number.isFinite(heading) && headingOff(index.sections[sample.s], sample.heading, heading) > MATCH_HEADING_DEG) continue;
				const distance = localDistance(lat, lng, sample.lat, sample.lng);
				if (distance <= bestDistance) {
					best = index.sections[sample.s];
					bestDistance = distance;
				}
			}
		}
	}
	return best;
}

/**
 * The timed sections on the roads ahead of the rider within `radius`, each
 * with its distance from the rider. Where a road has a section for each
 * direction, only the one leading away from the rider counts, so the roads
 * ahead read outward from where they are; a flat road's one section counts
 * either way.
 *
 * @param {Object} index - From `buildSectionIndex`.
 * @param {{lat: number, lng: number}} from - The rider.
 * @param {number} heading - Degrees.
 * @param {number} radius - Meters.
 * @returns {Array<{section: Object, distance: number}>}
 */
export function sectionsAhead(index, from, heading, radius) {
	const [row, col] = cellOf(from.lat, from.lng);
	const span = Math.ceil(radius / CELL_M);
	const nearest = new Map();
	for (let r = row - span; r <= row + span; r++) {
		for (let c = col - span; c <= col + span; c++) {
			for (const sample of index.cells.get(`${r}:${c}`) ?? []) {
				const distance = localDistance(from.lat, from.lng, sample.lat, sample.lng);
				if (distance > radius || distance >= (nearest.get(sample.s)?.distance ?? Infinity)) continue;
				nearest.set(sample.s, { distance, sample });
			}
		}
	}

	const found = [];
	for (const [s, { distance, sample }] of nearest) {
		const section = index.sections[s];
		if (!Number.isFinite(section.best)) continue;
		const [midLng, midLat] = section.mid;
		const outward = localBearing(from.lat, from.lng, midLat, midLng);
		// Near the rider, a section of their own road counts until its far end
		// (either end, for a two-way section) is behind them: the one just
		// ridden ends where they are.
		const isAhead = ([lng, lat]) =>
			localDistance(from.lat, from.lng, lat, lng) > END_PASSED_M &&
			(!Number.isFinite(heading) || headingDifference(heading, localBearing(from.lat, from.lng, lat, lng)) < 90);
		const endAhead = isAhead(section.coords[section.coords.length - 1]) || (section.bothWays && isAhead(section.coords[0]));
		const ahead =
			distance <= NEAR_RIDER_M
				? endAhead && (!Number.isFinite(heading) || headingOff(section, sample.heading, heading) <= MATCH_HEADING_DEG)
				: (!Number.isFinite(heading) || headingDifference(heading, outward) <= AHEAD_DEG) &&
					(section.bothWays || headingDifference(section.bearing, outward) < 90);
		if (ahead) found.push({ section, distance });
	}
	return found;
}

/**
 * The rider's own pace over the stretch just ridden: a trailing window of at
 * least `PACE_WINDOW_M`, never reaching back across a pause/dropout — about
 * a section's length, so the live "you vs. your best" comparison is
 * apples-to-apples.
 *
 * @param {Array<{lat: number, lng: number, timestamp: number}>} points -
 *   The current ride's recorded points so far.
 * @returns {number} m/s, or `NaN` until at least `MIN_CURRENT_WINDOW_M` of
 *   unbroken stretch exists behind the rider.
 */
export function trailingPace(points) {
	const last = points.length - 1;
	if (last < 1) return NaN;
	let distance = 0;
	let j = last;
	while (j > 0 && distance < PACE_WINDOW_M) {
		const a = points[j - 1];
		const b = points[j];
		const step = localDistance(a.lat, a.lng, b.lat, b.lng);
		if (isGap(b.timestamp - a.timestamp, step)) break;
		distance += step;
		j--;
	}
	const seconds = (points[last].timestamp - points[j].timestamp) / 1000;
	if (distance < MIN_CURRENT_WINDOW_M || seconds <= 0) return NaN;
	return distance / seconds;
}
