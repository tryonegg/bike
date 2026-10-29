/**
 * The best pace map: every road section ever ridden (about 100 m each,
 * between junctions; see pace-sections.js) with the fastest it was ever
 * ridden. A section steep enough for its grade to matter keeps a best per
 * direction; a flat one (grade within FLAT_GRADE) keeps a single best for
 * both, since which way it was ridden says nothing about pace there. It is
 * kept up to date ride by ride rather than
 * worked out from every saved ride whenever it's needed, and a best stays
 * even after the ride that set it is deleted.
 *
 * Each saved ride is taken in once: the routing worker matches it to the
 * roads, and its sections are merged in here. Rides waiting to be taken in
 * are found by their summary's `paceMapped` flag, so rides saved before the
 * map existed, imported, or merged are all picked up the same way.
 */

import {
	getAllSessionSummaries,
	getSessionById,
	getAllPaceSections,
	savePaceSections,
	markRidePaceMapped,
	clearPaceSections,
	replacePaceSections,
	getPref,
	setPref,
} from "./db.js";

// A new section is the same as a stored one when their middles are this close
// (but no more than this share of the section's length apart), they run the
// same way, and their lengths roughly agree. Rides along the same road are
// matched onto the same map lines, so real matches sit within a meter or two;
// the slack covers a map update moving a road slightly.
const SAME_MIDDLE_M = 10;
const SAME_MIDDLE_SHARE = 0.3;
const SAME_HEADING_DEG = 45;
const SAME_LENGTH_RATIO = 1.4;
// A section this flat or flatter (rise over run, either way) is ridden the
// same both ways, so it keeps one best for both directions.
export const FLAT_GRADE = 0.02;
// The FLAT_GRADE the stored sections' flat directions were last merged at,
// so raising it merges the newly flat ones too.
const FLAT_MERGED_PREF = "paceMapFlatMerged";
// A section off the mapped ways follows the ride that first went there, so
// a later ride's cuts fall elsewhere: it's the same when its middle lies
// within this distance of the stored section's line. A partial piece of a
// road section is matched the same way, but on the road's own line.
const SAME_OFF_NETWORK_M = 20;
const SAME_PARTIAL_M = 5;
// How far from a section's middle its line can reach: half the longest section.
const SECTION_SEARCH_M = 75;
// Grid cell size for finding stored sections by their middle.
const CELL_M = 25;
// Bumped when rides are matched to the map differently enough that every
// ride should be taken in again: the map is then rebuilt once.
const MAP_VERSION = 4;
const MAP_VERSION_PREF = "paceMapVersion";

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;

let syncing = null;
const listeners = new Set();

/**
 * Registers a function called after the map changes (a ride taken in, or a
 * rebuild), and with progress while rides are being taken in.
 *
 * @param {(progress: {done: number, total: number, running: boolean}) => void} fn
 * @returns {() => void} Unregisters it.
 */
export function onPaceMapChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Whether rides are being taken into the map right now.
 * @returns {boolean}
 */
export function isPaceMapSyncing() {
	return syncing !== null;
}

/**
 * Takes every saved ride not yet in the map into it, oldest first. Only one
 * pass runs at a time; calling again while one runs returns that one. A ride
 * whose map tiles can't be had (offline) is left for the next pass.
 *
 * @returns {Promise<void>}
 */
export function syncPaceMap() {
	syncing ??= runSync().finally(() => {
		syncing = null;
		notify({ done: 0, total: 0, running: false });
	});
	return syncing;
}

/**
 * Empties the map and builds it again from the rides saved now, dropping
 * bests set by rides since deleted.
 *
 * @returns {Promise<void>}
 */
export async function rebuildPaceMap() {
	await syncing;
	await clearPaceSections();
	notify({ done: 0, total: 0, running: false });
	await syncPaceMap();
}

/**
 * Empties the map, for when every ride has been deleted: a best whose ride
 * is gone would otherwise outlive all of them. Waits out a pass in
 * progress, so it can't write sections back after the map is emptied.
 *
 * @returns {Promise<void>}
 */
export async function clearPaceMap() {
	await syncing;
	await clearPaceSections();
	notify({ done: 0, total: 0, running: false });
}

/**
 * The map's sections for one activity.
 *
 * @param {string} activity - An ACTIVITIES key.
 * @returns {Promise<Array<Object>>}
 */
export async function loadPaceSections(activity) {
	return (await getAllPaceSections()).filter((section) => section.activity === activity);
}

async function runSync() {
	if ((await getPref(MAP_VERSION_PREF, null)) !== MAP_VERSION) {
		await clearPaceSections();
		// A map built afresh has nothing left to merge.
		await setPref(FLAT_MERGED_PREF, FLAT_GRADE);
		await setPref(MAP_VERSION_PREF, MAP_VERSION);
	}
	await mergeFlatDirectionsOnce();
	const pending = (await getAllSessionSummaries()).filter((summary) => !summary.paceMapped);
	if (!pending.length) return;
	pending.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

	const stored = await getAllPaceSections();
	const lookup = new Map();
	for (const section of stored) addToLookup(lookup, section);

	const worker = new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
	let done = 0;
	try {
		notify({ done, total: pending.length, running: true });
		for (const summary of pending) {
			const session = await getSessionById(summary.id);
			const points = (session?.points ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.timestamp));
			if (points.length < 2) {
				await markRidePaceMapped(summary.id);
			} else {
				const activity = session.activityType || "bike";
				try {
					const result = await ask(worker, {
						type: "paceSections",
						points: points.map((p) => [p.lng, p.lat, p.timestamp, Boolean(p.estimated)]),
						pauses: Array.isArray(session.pauses) ? session.pauses : [],
					});
					// Without sections its tiles couldn't be had; it's tried again next time.
					if (result.sections) {
						const changed = mergeRide(lookup, result.sections, { id: session.id, date: session.date, activity });
						await savePaceSections(session.id, changed);
					}
				} catch (error) {
					console.warn(`Adding ride ${session.id} to the best pace map failed`, error);
				}
			}
			done++;
			notify({ done, total: pending.length, running: true });
		}
	} finally {
		worker.terminate();
	}
}

/** Sends one request to the worker and waits for its answer. */
function ask(worker, message) {
	return new Promise((resolve, reject) => {
		const onMessage = ({ data }) => {
			worker.removeEventListener("message", onMessage);
			worker.removeEventListener("error", onError);
			if (data.error) reject(new Error(data.error));
			else resolve(data);
		};
		const onError = (event) => {
			worker.removeEventListener("message", onMessage);
			worker.removeEventListener("error", onError);
			reject(new Error(event.message || "worker failed"));
		};
		worker.addEventListener("message", onMessage);
		worker.addEventListener("error", onError);
		worker.postMessage({ id: 1, ...message });
	});
}

/**
 * Folds one ride's sections into the map: a section already there takes
 * the ride's speed if it's faster, and one not there yet is added.
 *
 * @param {Map<string, Array<Object>>} lookup - Stored sections by grid cell,
 *   updated in place.
 * @param {Array<{coords: Array<[number, number]>, meters: number, speed: number|null, grade: number|null}>} sections
 * @param {{id: number, date: string, activity: string}} ride
 * @returns {Array<Object>} The records added or changed.
 */
function mergeRide(lookup, sections, ride) {
	const changed = new Set();
	for (const found of sections) {
		const shape = sectionShape(found.coords, found.meters);
		const kind = found.offNetwork ? "offNetwork" : found.partial ? "partial" : "road";
		let record = findSame(lookup, shape, ride.activity, kind);
		// A piece of a section already on the map adds nothing to it.
		if (kind === "partial" && record && !record.partial) continue;
		if (!record) {
			record = {
				activity: ride.activity,
				offNetwork: kind === "offNetwork",
				partial: kind === "partial",
				bothWays: isFlat(found.grade),
				coords: found.coords,
				meters: found.meters,
				mid: shape.mid,
				bearing: shape.bearing,
				best: null,
				bestRideId: null,
				bestDate: null,
				grade: found.grade,
				passes: 0,
				firstDate: ride.date,
				lastDate: ride.date,
			};
			addToLookup(lookup, record);
		}
		record.passes++;
		if (new Date(ride.date) > new Date(record.lastDate)) record.lastDate = ride.date;
		if (new Date(ride.date) < new Date(record.firstDate)) record.firstDate = ride.date;
		if (record.grade === null && found.grade !== null) record.grade = found.grade;
		if (found.speed !== null && !(record.best >= found.speed)) {
			record.best = found.speed;
			record.bestRideId = ride.id;
			record.bestDate = ride.date;
		}
		changed.add(record);
	}
	return [...changed];
}

/** A section's middle point (halfway along it) and heading from end to end. */
function sectionShape(coords, meters) {
	const half = meters / 2;
	let walked = 0;
	let mid = coords[0];
	for (let k = 1; k < coords.length; k++) {
		const step = localDistance(coords[k - 1], coords[k]);
		if (walked + step >= half) {
			const t = step ? (half - walked) / step : 0;
			mid = [coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * t, coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * t];
			break;
		}
		walked += step;
		mid = coords[k];
	}
	return { mid, bearing: localBearing(coords[0], coords[coords.length - 1]), meters };
}

/** Whether a grade is flat enough for one best to serve both directions. */
function isFlat(grade) {
	return Number.isFinite(grade) && Math.abs(grade) <= FLAT_GRADE;
}

/**
 * The stored section that is the same stretch of road ridden the same way,
 * or ridden either way when it's flat, if any.
 */
function findSame(lookup, shape, activity, kind) {
	// Matched by where it lies rather than by its middle, since its ends follow the ride.
	const byLine = kind !== "road";
	const reach = kind === "offNetwork" ? SAME_OFF_NETWORK_M : kind === "partial" ? SAME_PARTIAL_M : Math.min(SAME_MIDDLE_M, shape.meters * SAME_MIDDLE_SHARE);
	// Its middle may sit up to half a section from the stored one's, so its
	// cells are searched further out.
	const span = byLine ? Math.ceil(SECTION_SEARCH_M / CELL_M) + 1 : 1;
	const [row, col] = cellOf(shape.mid);
	let best = null;
	let bestDistance = reach;
	for (let r = row - span; r <= row + span; r++) {
		for (let c = col - span; c <= col + span; c++) {
			for (const record of lookup.get(`${r}:${c}`) ?? []) {
				if (record.activity !== activity) continue;
				// A partial piece matches a stored piece or the whole section it's part of.
				if (kind === "partial" ? record.offNetwork : Boolean(record.offNetwork) !== (kind === "offNetwork") || record.partial) continue;
				const ratio = record.meters / shape.meters;
				if (!byLine && (ratio > SAME_LENGTH_RATIO || ratio < 1 / SAME_LENGTH_RATIO)) continue;
				const turn = headingDifference(record.bearing, shape.bearing);
				if (turn > SAME_HEADING_DEG && !(record.bothWays && turn >= 180 - SAME_HEADING_DEG)) continue;
				const distance = byLine ? distanceToLine(shape.mid, record.coords) : localDistance(record.mid, shape.mid);
				// A whole section wins over a piece, so pieces stop collecting under it.
				if (distance <= bestDistance || (distance <= reach && best?.partial && !record.partial)) {
					best = record;
					bestDistance = distance;
				}
			}
		}
	}
	return best;
}

/** Meters from a point to the nearest point of a line, flat-earth. */
function distanceToLine([lng, lat], coords) {
	const mx = metersPerDegLng(lat);
	let nearest = Infinity;
	for (let k = 1; k < coords.length; k++) {
		const ax = (coords[k - 1][0] - lng) * mx;
		const ay = (coords[k - 1][1] - lat) * M_PER_DEG_LAT;
		const dx = (coords[k][0] - lng) * mx - ax;
		const dy = (coords[k][1] - lat) * M_PER_DEG_LAT - ay;
		const lengthSq = dx * dx + dy * dy;
		const t = lengthSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
		nearest = Math.min(nearest, Math.hypot(ax + dx * t, ay + dy * t));
	}
	return nearest;
}

/**
 * Merges the two directions of each flat section stored before flat
 * sections were shared by both (or before FLAT_GRADE was raised), once per
 * FLAT_GRADE: the merged section keeps the faster
 * best and the passes of both. A flat section ridden only one way so far
 * is just marked as serving both.
 *
 * @returns {Promise<void>}
 */
async function mergeFlatDirectionsOnce() {
	if ((await getPref(FLAT_MERGED_PREF, null)) === FLAT_GRADE) return;
	const lookup = new Map();
	const flat = [];
	for (const section of await getAllPaceSections()) {
		if (section.bothWays || !isFlat(section.grade)) continue;
		flat.push(section);
		addToLookup(lookup, section);
	}

	const changed = new Set();
	const removed = new Set();
	for (const section of flat) {
		if (removed.has(section.id)) continue;
		section.bothWays = true;
		changed.add(section);
		const [row, col] = cellOf(section.mid);
		const reach = Math.min(SAME_MIDDLE_M, section.meters * SAME_MIDDLE_SHARE);
		for (let r = row - 1; r <= row + 1; r++) {
			for (let c = col - 1; c <= col + 1; c++) {
				for (const twin of lookup.get(`${r}:${c}`) ?? []) {
					if (twin === section || removed.has(twin.id) || changed.has(twin) || twin.activity !== section.activity) continue;
					if (headingDifference(twin.bearing, section.bearing) < 180 - SAME_HEADING_DEG) continue;
					if (localDistance(twin.mid, section.mid) > reach) continue;
					absorb(section, twin);
					removed.add(twin.id);
				}
			}
		}
	}
	await replacePaceSections([...changed], [...removed]);
	await setPref(FLAT_MERGED_PREF, FLAT_GRADE);
}

/** Folds another stored section's passes and best into `record`. */
function absorb(record, other) {
	record.passes += other.passes;
	if (new Date(other.firstDate) < new Date(record.firstDate)) record.firstDate = other.firstDate;
	if (new Date(other.lastDate) > new Date(record.lastDate)) record.lastDate = other.lastDate;
	if (Number.isFinite(other.best) && !(record.best >= other.best)) {
		record.best = other.best;
		record.bestRideId = other.bestRideId;
		record.bestDate = other.bestDate;
	}
}

function addToLookup(lookup, record) {
	const key = cellOf(record.mid).join(":");
	const list = lookup.get(key);
	if (list) list.push(record);
	else lookup.set(key, [record]);
}

function cellOf([lng, lat]) {
	return [Math.floor((lat * M_PER_DEG_LAT) / CELL_M), Math.floor((lng * metersPerDegLng(lat)) / CELL_M)];
}

function notify(progress) {
	for (const fn of listeners) fn(progress);
}

function metersPerDegLng(lat) {
	return M_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

function localDistance([lngA, latA], [lngB, latB]) {
	return Math.hypot((lngB - lngA) * metersPerDegLng((latA + latB) / 2), (latB - latA) * M_PER_DEG_LAT);
}

function localBearing([lngA, latA], [lngB, latB]) {
	const dx = (lngB - lngA) * metersPerDegLng((latA + latB) / 2);
	const dy = (latB - latA) * M_PER_DEG_LAT;
	return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function headingDifference(a, b) {
	const diff = Math.abs(a - b) % 360;
	return diff > 180 ? 360 - diff : diff;
}
