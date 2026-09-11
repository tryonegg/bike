// Best past pace. The rider's own earlier tracks are indexed by location and
// direction of travel, so a road ridden uphill and the same road ridden downhill
// are compared separately. No road data is involved: "the same road" means
// "where an earlier track went, heading the same way".
//
// Pure computation on saved sessions; the app decides what to draw.

// Pace is distance over time for the last stretch of this length. A single GPS
// speed reading spikes; a stretch average is stable and is what "best" means.
const PACE_WINDOW_M = 150;
// The rider's own pace needs at least this much of the stretch behind them.
const MIN_CURRENT_WINDOW_M = 40;
// GPS altitude is noisy, so grade is taken over a longer stretch and averaged
// across every earlier pass.
const GRADE_WINDOW_M = 200;

// A past point counts as "here" within this distance and heading difference.
const MATCH_RADIUS_M = 25;
const MATCH_HEADING_DEG = 35;

// Grid cell size for the lookup; the 3x3 cells around a point cover the radius.
const CELL_M = 25;
// Indexed points are thinned to this spacing, well under the match radius.
const INDEX_SPACING_M = 8;
// Heading is the direction across this distance either side of a point.
const HEADING_SPAN_M = 10;
// A step faster than this is a GPS jump, not riding.
const MAX_PLAUSIBLE_MPS = 30;
// A stretch never reaches back across a pause or a GPS dropout this long.
const GAP_MS = 10000;
// Nor across a jump this long between consecutive points.
const GAP_M = 60;

// The paths ahead: indexed points of one track this close along it join into a
// line. A point within the match radius of an already drawn one, heading the
// same way, is the same road with the same best pace, so overlapping rides
// draw once; rides on one road sit meters apart from GPS error alone. What is
// left of a path after that must be at least MIN_LINE_M long; shorter scraps
// are a second ride weaving in and out of the first, not a road of their own.
const RUN_JOIN_M = 20;
const DEDUPE_M = MATCH_RADIUS_M;
const MIN_LINE_M = 40;
// Within this distance of the rider the direction to a point says nothing, so
// only the track's own heading decides whether it is the rider's road.
const NEAR_RIDER_M = 15;

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;
// A track and point index packed into one number: track * REF_SCALE + point.
const REF_SCALE = 2 ** 21;

/** @param {number} lat - Degrees. @returns {number} Meters per degree of longitude at that latitude. */
function metersPerDegLng(lat) {
	return M_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

// Flat-earth distance, plenty accurate at the tens of meters compared here.
/**
 * Flat-earth distance between two lat/lng points — plenty accurate at the
 * tens-of-meters scale this module compares over, and much cheaper than a
 * great-circle formula run millions of times while indexing.
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

// Each row's column width is set by that row's latitude, so every cell is
// roughly square wherever the rides are.
/**
 * The spatial-hash grid row a latitude falls in. Row height is a fixed
 * number of meters; column width (see `cellCol`) is scaled per-row by that
 * row's latitude, so every cell stays roughly square wherever the rides are,
 * despite longitude degrees shrinking toward the poles.
 * @param {number} lat - Degrees.
 * @returns {number} Row index.
 */
function cellRow(lat) {
	return Math.floor((lat * M_PER_DEG_LAT) / CELL_M);
}

/** @param {number} row @param {number} lng - Degrees. @returns {number} Column index within `row`. */
function cellCol(row, lng) {
	const rowLat = ((row + 0.5) * CELL_M) / M_PER_DEG_LAT;
	return Math.floor((lng * metersPerDegLng(rowLat)) / CELL_M);
}

/** @param {number} lat @param {number} lng @returns {string} This point's grid-cell key, `"row:col"`. */
function cellKey(lat, lng) {
	const row = cellRow(lat);
	return `${row}:${cellCol(row, lng)}`;
}

// Every cell that could hold a point within radius meters.
/**
 * Every grid-cell key that could hold a point within `radius` meters of
 * `(lat, lng)` — used for a radius search wider than the fixed 3x3
 * neighborhood `neighborKeys` covers.
 * @param {number} lat @param {number} lng @param {number} radius - Meters.
 * @yields {string} Cell keys.
 */
function* cellKeysWithin(lat, lng, radius) {
	const rowLow = cellRow(lat - radius / M_PER_DEG_LAT);
	const rowHigh = cellRow(lat + radius / M_PER_DEG_LAT);
	for (let r = rowLow; r <= rowHigh; r++) {
		const rowLat = ((r + 0.5) * CELL_M) / M_PER_DEG_LAT;
		const span = radius / metersPerDegLng(rowLat);
		const colLow = cellCol(r, lng - span);
		const colHigh = cellCol(r, lng + span);
		for (let c = colLow; c <= colHigh; c++) yield `${r}:${c}`;
	}
}

/**
 * The 3x3 grid cells centered on `(lat, lng)` — enough to cover
 * `MATCH_RADIUS_M`, since `CELL_M` is chosen to match. Cheaper than
 * `cellKeysWithin` for the fixed-radius point match `matchPasses` does on
 * every live fix.
 * @param {number} lat @param {number} lng
 * @yields {string} Cell keys.
 */
function* neighborKeys(lat, lng) {
	const row = cellRow(lat);
	for (let r = row - 1; r <= row + 1; r++) {
		const col = cellCol(r, lng);
		for (let c = col - 1; c <= col + 1; c++) yield `${r}:${c}`;
	}
}

/**
 * Whether a step between two consecutive points is a pause/dropout that
 * should break a pace/grade/run-joining stretch, rather than ordinary riding.
 * @param {number} tMs - Milliseconds since the previous point.
 * @param {number} dMeters - Distance from the previous point.
 * @returns {boolean}
 */
function isGap(tMs, dMeters) {
	return tMs > GAP_MS || dMeters > GAP_M;
}

// Typed arrays per saved ride, with pace, grade and heading worked out once.
/**
 * Converts one saved ride into the typed-array-backed "track" shape every
 * other function in this module works with: cumulative distance, a
 * smoothed altitude, and per-point heading/pace/grade, each computed once
 * up front rather than recomputed on every lookup. Points the app itself
 * estimated during a GPS dropout are excluded — a dead-reckoned guess isn't
 * a real pace.
 *
 * @param {Object} session - A saved ride (`{id, date, points}}`).
 * @returns {{id: number, date: string, n: number, lat: Float64Array,
 *   lng: Float64Array, time: Float64Array, dist: Float64Array,
 *   since: Int32Array, heading: Float32Array, pace: Float32Array,
 *   grade: Float32Array}|null} `null` if the ride has fewer than 2 usable points.
 */
function prepareTrack(session) {
	// Points the app estimated during a GPS dropout are a guess, not a pace.
	const points = (session.points || []).filter(
		(p) => !p.estimated && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.timestamp),
	);
	const n = points.length;
	if (n < 2) return null;

	const lat = new Float64Array(n);
	const lng = new Float64Array(n);
	const time = new Float64Array(n);
	const dist = new Float64Array(n);
	const alt = new Float32Array(n).fill(NaN);
	// Index of the first point after the most recent gap, per point.
	const since = new Int32Array(n);

	for (let i = 0; i < n; i++) {
		lat[i] = points[i].lat;
		lng[i] = points[i].lng;
		time[i] = points[i].timestamp;
		if (i === 0) continue;
		const step = localDistance(lat[i - 1], lng[i - 1], lat[i], lng[i]);
		const dt = time[i] - time[i - 1];
		const glitch = dt <= 0 || step / (dt / 1000) > MAX_PLAUSIBLE_MPS;
		dist[i] = dist[i - 1] + (glitch ? 0 : step);
		since[i] = isGap(dt, step) ? i : since[i - 1];
	}

	// A five-point moving average takes the worst of the GPS altitude jitter off.
	for (let i = 0; i < n; i++) {
		let sum = 0;
		let count = 0;
		for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) {
			const value = points[k].altitude;
			if (Number.isFinite(value)) {
				sum += value;
				count++;
			}
		}
		if (count) alt[i] = sum / count;
	}

	const heading = new Float32Array(n).fill(NaN);
	const pace = new Float32Array(n).fill(NaN);
	const grade = new Float32Array(n).fill(NaN);

	let back = 0;
	let ahead = 0;
	let paceStart = 0;
	let gradeStart = 0;
	for (let i = 0; i < n; i++) {
		while (back < i && dist[back + 1] <= dist[i] - HEADING_SPAN_M) back++;
		while (ahead < n - 1 && dist[ahead] < dist[i] + HEADING_SPAN_M) ahead++;
		if (dist[ahead] - dist[back] >= HEADING_SPAN_M / 2) {
			heading[i] = localBearing(lat[back], lng[back], lat[ahead], lng[ahead]);
		}

		// The shortest stretch ending here that is at least a window long, never
		// reaching back past the last gap.
		paceStart = Math.max(paceStart, since[i]);
		while (paceStart < i && dist[i] - dist[paceStart + 1] >= PACE_WINDOW_M) paceStart++;
		const paceSpan = dist[i] - dist[paceStart];
		const paceTime = (time[i] - time[paceStart]) / 1000;
		if (paceSpan >= PACE_WINDOW_M && paceTime > 0) pace[i] = paceSpan / paceTime;

		gradeStart = Math.max(gradeStart, since[i]);
		while (gradeStart < i && dist[i] - dist[gradeStart + 1] >= GRADE_WINDOW_M) gradeStart++;
		const gradeSpan = dist[i] - dist[gradeStart];
		if (gradeSpan >= GRADE_WINDOW_M && Number.isFinite(alt[i]) && Number.isFinite(alt[gradeStart])) {
			grade[i] = (alt[i] - alt[gradeStart]) / gradeSpan;
		}
	}

	return { id: session.id, date: session.date, n, lat, lng, time, dist, since, heading, pace, grade };
}

// Builds the lookup from saved sessions. Yields between rides so a large
// history does not stall the ride screen while it builds.
/**
 * Builds the full pace index from a rider's saved rides of one activity
 * type: prepares every track, thins its points to `INDEX_SPACING_M` spacing
 * and files each into the spatial-hash grid, and samples the resulting
 * pace distribution to pick a slow/fast color range. Yields to the event
 * loop between rides (via a zero-delay `setTimeout`) so indexing a large
 * ride history doesn't stall the ride screen while it runs.
 *
 * @param {Array<Object>} sessions - Saved rides, already filtered to one activity type.
 * @returns {Promise<{tracks: Array<Object>, cells: Map<string, number[]>,
 *   slow: number, fast: number, bestCache: Map<number, number>}>} The index,
 *   ready for `bestPaceAt`/`pathsAhead`. `slow`/`fast` are the rider's own
 *   10th/90th-percentile pace (m/s) — the color scale runs across their own
 *   range, so red and green mean slow and fast for them, not for some fixed
 *   speed. `bestCache` starts empty; see `bestAtTrackPoint`.
 */
export async function buildPaceIndex(sessions) {
	const tracks = [];
	const cells = new Map();
	const paceSample = [];

	for (const session of sessions) {
		const track = prepareTrack(session);
		if (track) {
			const trackIndex = tracks.push(track) - 1;
			let lastIndexed = -Infinity;
			for (let i = 0; i < track.n; i++) {
				if (!Number.isFinite(track.heading[i])) continue;
				if (track.dist[i] - lastIndexed < INDEX_SPACING_M) continue;
				lastIndexed = track.dist[i];
				const key = cellKey(track.lat[i], track.lng[i]);
				let refs = cells.get(key);
				if (!refs) {
					refs = [];
					cells.set(key, refs);
				}
				refs.push(trackIndex * REF_SCALE + i);
				if (Number.isFinite(track.pace[i]) && paceSample.length < 20000) paceSample.push(track.pace[i]);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	// The colour scale runs across the rider's own range of paces, so red and
	// green mean slow and fast for them rather than for some fixed speed.
	paceSample.sort((a, b) => a - b);
	const quantile = (q) => paceSample[Math.min(paceSample.length - 1, Math.floor(q * paceSample.length))];
	const slow = paceSample.length ? quantile(0.1) : 0;
	const fast = paceSample.length ? quantile(0.9) : 0;

	return { tracks, cells, slow, fast, bestCache: new Map() };
}

// The closest point of each earlier track that passes here heading the same way.
/**
 * Finds, per earlier track, the single closest indexed point within
 * `MATCH_RADIUS_M`/`MATCH_HEADING_DEG` of `(lat, lng)` heading roughly the
 * given way — i.e. every past pass through "here, going this direction",
 * one per track.
 *
 * @param {Object} index - From `buildPaceIndex`.
 * @param {number} lat @param {number} lng
 * @param {number} heading - Degrees; returns `[]` if non-finite (no
 *   reliable heading to match against yet).
 * @returns {Array<{trackIndex: number, i: number, distance: number}>}
 */
function matchPasses(index, lat, lng, heading) {
	const closest = new Map();
	if (!Number.isFinite(heading)) return [];
	for (const key of neighborKeys(lat, lng)) {
		const refs = index.cells.get(key);
		if (!refs) continue;
		for (const ref of refs) {
			const trackIndex = Math.floor(ref / REF_SCALE);
			const i = ref % REF_SCALE;
			const track = index.tracks[trackIndex];
			const distance = localDistance(lat, lng, track.lat[i], track.lng[i]);
			if (distance > MATCH_RADIUS_M) continue;
			if (headingDifference(heading, track.heading[i]) > MATCH_HEADING_DEG) continue;
			const previous = closest.get(trackIndex);
			if (!previous || distance < previous.distance) closest.set(trackIndex, { trackIndex, i, distance });
		}
	}
	return [...closest.values()];
}

// Best past pace and average grade at a spot, heading a given way. best is NaN
// when no earlier ride went this way here.
/**
 * The rider's best past pace at a spot, heading a given way, and the
 * average grade earlier rides recorded there.
 *
 * @param {Object} index
 * @param {number} lat @param {number} lng @param {number} heading - Degrees.
 * @returns {{best: number, grade: number, passes: Array<Object>}} `best`
 *   (m/s) is `NaN` when no earlier ride went this way here; `grade` is `NaN`
 *   when no matching pass had a usable grade reading. `passes` is the raw
 *   match list from `matchPasses`, reused by `pathsAhead`'s caller-adjacent
 *   code where relevant.
 */
export function bestPaceAt(index, lat, lng, heading) {
	const passes = matchPasses(index, lat, lng, heading);
	let best = NaN;
	let gradeSum = 0;
	let gradeCount = 0;
	for (const pass of passes) {
		const track = index.tracks[pass.trackIndex];
		const pace = track.pace[pass.i];
		if (Number.isFinite(pace) && !(pace <= best)) best = pace;
		const grade = track.grade[pass.i];
		if (Number.isFinite(grade)) {
			gradeSum += grade;
			gradeCount++;
		}
	}
	return { best, grade: gradeCount ? gradeSum / gradeCount : NaN, passes };
}

// Best pace at one point of an earlier track, cached: the index does not change
// during a ride, and the band ahead asks about the same points fix after fix.
/**
 * The best pace recorded at one specific indexed point of an earlier track,
 * memoized in `index.bestCache`. The index never changes during a ride, and
 * `pathsAhead` re-asks about the same points on nearly every fix as the
 * rider moves, so caching avoids redoing the full `bestPaceAt` neighborhood
 * search repeatedly for the same point.
 *
 * @param {Object} index
 * @param {number} trackIndex
 * @param {number} i - Point index within that track.
 * @returns {number} Pace in m/s; falls back to the point's own recorded pace
 *   if no other track's pass beat it (or matched at all).
 */
function bestAtTrackPoint(index, trackIndex, i) {
	const key = trackIndex * REF_SCALE + i;
	let best = index.bestCache.get(key);
	if (best === undefined) {
		const track = index.tracks[trackIndex];
		best = bestPaceAt(index, track.lat[i], track.lng[i], track.heading[i]).best;
		if (!Number.isFinite(best)) best = track.pace[i];
		index.bestCache.set(key, best);
	}
	return best;
}

// Every earlier path in the half-circle ahead of the rider, out to radius
// meters: straight on and off to either side. A path counts where it was
// heading away from the rider, which keeps roads they could take and drops
// traffic coming toward them. Where rides overlap the road is drawn once, and
// every point carries the best pace any ride set there in that direction.
// Returns lines of {coords, paces, distances}, distances being straight-line
// from the rider.
/**
 * Finds every earlier ride's path in the half-circle ahead of the rider,
 * out to `radius` meters — straight on and off to either side, but not
 * behind. A point counts only where its track was heading away from the
 * rider (keeping roads the rider could actually take, and dropping traffic
 * that passed heading toward them). Where rides overlap, the road is
 * deduplicated to a single drawn line so the map doesn't show N copies of
 * a well-ridden route; every point on that line still carries the best pace
 * any ride set there heading that direction (via `bestAtTrackPoint`).
 *
 * This is the module's most involved function: it (1) collects qualifying
 * indexed points per track within the search radius, (2) breaks each
 * track's points into unbroken runs (splitting on gaps or gaps in indexing
 * spacing), (3) processes runs longest-first, matching each point against
 * already-claimed ground so overlapping rides merge onto one line and a
 * branch joins the existing line exactly rather than a GPS-error's width
 * away, and (4) discards any resulting line whose genuinely new (unclaimed)
 * road is shorter than `MIN_LINE_M` — a short scrap is treated as a second
 * ride weaving in and out of the first, not a road of its own.
 *
 * @param {Object} index
 * @param {{lat: number, lng: number}} from - The rider's current position.
 * @param {number} heading - Degrees; returns `[]` if non-finite.
 * @param {number} radius - Meters.
 * @returns {Array<{coords: Array<[number, number]>, paces: number[],
 *   distances: number[]}>} One entry per drawable path; `distances` is
 *   straight-line distance from the rider to each coordinate.
 */
export function pathsAhead(index, from, heading, radius) {
	if (!Number.isFinite(heading)) return [];

	// Qualifying indexed points, grouped by track.
	const byTrack = new Map();
	for (const key of cellKeysWithin(from.lat, from.lng, radius)) {
		const refs = index.cells.get(key);
		if (!refs) continue;
		for (const ref of refs) {
			const trackIndex = Math.floor(ref / REF_SCALE);
			const i = ref % REF_SCALE;
			const track = index.tracks[trackIndex];
			const distance = localDistance(from.lat, from.lng, track.lat[i], track.lng[i]);
			if (distance > radius) continue;
			if (distance < NEAR_RIDER_M) {
				if (headingDifference(track.heading[i], heading) > MATCH_HEADING_DEG) continue;
			} else {
				const outward = localBearing(from.lat, from.lng, track.lat[i], track.lng[i]);
				if (headingDifference(outward, heading) > 90) continue;
				if (headingDifference(track.heading[i], outward) > 90) continue;
			}
			let points = byTrack.get(trackIndex);
			if (!points) {
				points = [];
				byTrack.set(trackIndex, points);
			}
			points.push({ i, distance });
		}
	}

	// Unbroken runs along each track.
	const runs = [];
	for (const [trackIndex, points] of byTrack) {
		const track = index.tracks[trackIndex];
		points.sort((a, b) => a.i - b.i);
		let run = [];
		for (const point of points) {
			const previous = run[run.length - 1];
			const joins =
				previous &&
				track.dist[point.i] - track.dist[previous.i] <= RUN_JOIN_M &&
				track.since[point.i] === track.since[previous.i];
			if (!joins && run.length) {
				runs.push({ trackIndex, points: run });
				run = [];
			}
			run.push(point);
		}
		if (run.length) runs.push({ trackIndex, points: run });
	}

	// Longest runs claim the road first, so a well-ridden route stays one line
	// and shorter rides only add where they go somewhere it does not.
	runs.sort((a, b) => b.points.length - a.points.length);
	const claimed = new Map();
	const claimKey = (lat, lng) => {
		const row = Math.floor((lat * M_PER_DEG_LAT) / DEDUPE_M);
		return [row, Math.floor((lng * metersPerDegLng(lat)) / DEDUPE_M)];
	};
	// The nearest drawn point on the same road, or null when there is none.
	const claimedMatch = (lat, lng, pointHeading) => {
		const [row, col] = claimKey(lat, lng);
		let nearest = null;
		let nearestDistance = DEDUPE_M;
		for (let r = row - 1; r <= row + 1; r++) {
			for (let c = col - 1; c <= col + 1; c++) {
				for (const other of claimed.get(`${r}:${c}`) ?? []) {
					const distance = localDistance(lat, lng, other.lat, other.lng);
					if (distance <= nearestDistance && headingDifference(pointHeading, other.heading) <= MATCH_HEADING_DEG) {
						nearest = other;
						nearestDistance = distance;
					}
				}
			}
		}
		return nearest;
	};
	const claim = (lat, lng, pointHeading) => {
		const [row, col] = claimKey(lat, lng);
		const key = `${row}:${col}`;
		let list = claimed.get(key);
		if (!list) {
			list = [];
			claimed.set(key, list);
		}
		list.push({ lat, lng, heading: pointHeading });
	};

	const lines = [];
	for (const { trackIndex, points } of runs) {
		const track = index.tracks[trackIndex];
		const covered = points.map(({ i }) => claimedMatch(track.lat[i], track.lng[i], track.heading[i]));
		let line = null;
		const add = (k) => {
			const { i, distance } = points[k];
			// A point on an already drawn road is placed on that road's line, so a
			// branch meets it exactly rather than a GPS error's width away.
			const onRoad = covered[k];
			line.coords.push(onRoad ? [onRoad.lng, onRoad.lat] : [track.lng[i], track.lat[i]]);
			line.paces.push(bestAtTrackPoint(index, trackIndex, i));
			line.distances.push(distance);
			if (!onRoad) line.newRoad.push([track.lng[i], track.lat[i]]);
		};
		for (let k = 0; k < points.length; k++) {
			if (covered[k]) {
				// A branch rejoining a drawn road ends on it, with no gap.
				if (line) {
					add(k);
					lines.push(line);
					line = null;
				}
				continue;
			}
			if (!line) {
				line = { coords: [], paces: [], distances: [], newRoad: [] };
				// A branch leaving a drawn road starts on it, with no gap.
				if (k > 0) add(k - 1);
			}
			add(k);
		}
		if (line) lines.push(line);
		points.forEach(({ i }, k) => {
			if (!covered[k]) claim(track.lat[i], track.lng[i], track.heading[i]);
		});
	}
	// Judged on the road a line adds, not counting the ends that join it to others.
	return lines
		.filter((line) => lineLength(line.newRoad) >= MIN_LINE_M)
		.map(({ coords, paces, distances }) => smoothLine({ coords, paces, distances }));
}

/** @param {Array<[number, number]>} coords @returns {number} Total length in meters. */
function lineLength(coords) {
	let length = 0;
	for (let k = 1; k < coords.length; k++) {
		length += localDistance(coords[k - 1][1], coords[k - 1][0], coords[k][1], coords[k][0]);
	}
	return length;
}

// GPS points zigzag either side of the road. A short weighted average along
// the line settles them onto it; the ends stay put so joined paths still meet.
/**
 * Smooths a path's coordinates with a short weighted moving average, to
 * settle GPS zigzag back onto the road it was tracking. The first and last
 * points are left untouched so a smoothed line still meets exactly wherever
 * it was joined to another (see the "on-road" join logic in `pathsAhead`).
 *
 * @param {{coords: Array<[number, number]>}} line
 * @returns {Object} `line` with `coords` replaced by the smoothed version;
 *   other properties (`paces`, `distances`) pass through unchanged.
 */
function smoothLine(line) {
	const { coords } = line;
	const weights = [1, 2, 3, 2, 1];
	const smoothed = coords.map((coord, k) => {
		if (k === 0 || k === coords.length - 1) return coord;
		let lng = 0;
		let lat = 0;
		let total = 0;
		for (let offset = -2; offset <= 2; offset++) {
			const neighbor = coords[k + offset];
			if (!neighbor) continue;
			const weight = weights[offset + 2];
			lng += neighbor[0] * weight;
			lat += neighbor[1] * weight;
			total += weight;
		}
		return [lng / total, lat / total];
	});
	return { ...line, coords: smoothed };
}

// The rider's own pace over the stretch just ridden, measured the same way as
// the past paces. NaN until enough of the stretch exists since the last gap.
/**
 * The rider's own pace over the stretch just ridden, measured the same way
 * `prepareTrack` measures past paces (a trailing window of at least
 * `PACE_WINDOW_M`, never reaching back across a pause/dropout) — so the live
 * "you vs. your best" comparison is apples-to-apples.
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
