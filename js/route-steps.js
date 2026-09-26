/**
 * Turn-by-turn steps for a route: where along it the rider has to turn, which
 * way, and onto what. Runs in the routing worker (route-worker.js) on a route
 * line and the road graph it was routed on (or rebuilt around it), plus the
 * street names from the same map tiles.
 *
 * A turn is only ever given at a junction (a graph node where three or more
 * ways meet; see `junctionNear`), so a road that merely bends never reads as
 * one. At each junction the route passes through, the heading in and the
 * heading out (each measured over TURN_WINDOW_M, so small wiggles at the
 * junction itself don't count) give the turn's angle.
 *
 * Junctions closer together than CLUSTER_M (the two sides of a divided
 * road, a wide intersection drawn as several nodes) count as one turn,
 * measured from the heading into the first to the heading out of the last.
 *
 * A step is {index, along, turn, name, kind, stay, point}: `index` is the
 * route point it's at (callers measure distances along the route their own
 * way), `along` the meters from the route's start by this module's
 * reckoning, `turn` one of TURNS or "arrive" for the route's end, `name` the
 * street or trail turned onto (null if unnamed), `kind` what sort of way it
 * is when that's worth saying of an unnamed one ("bike path", "path",
 * "track"), and `stay` whether it's the same street as before the turn
 * ("turn left to stay on …").
 */

import { toUnits, junctionNear } from "./route-graph.js";

// Headings are taken this far before and after a junction.
const TURN_WINDOW_M = 15;
const CLUSTER_M = 20;
// Turn angles, in degrees: under STRAIGHT_DEG is carrying on, not a turn.
// Up to SLIGHT_DEG is bearing left or right, up to SHARP_DEG a plain turn, up
// to UTURN_DEG a sharp one, and beyond that turning back.
const STRAIGHT_DEG = 30;
const SLIGHT_DEG = 60;
const SHARP_DEG = 135;
const UTURN_DEG = 165;
// A slight bend on a road that keeps its name at a junction is the road
// curving, not a turn off it.
const SAME_ROAD_MAX_DEG = 60;
// Street names are looked up this far along the way turned onto, within
// NAME_REACH_M of the route and running within NAME_MAX_DEG of its heading.
const NAME_LOOKAHEAD_M = 20;
const NAME_REACH_M = 12;
const NAME_MAX_DEG = 35;
// Steps closer than this to the route's start are dropped: the rider is
// already there, facing whichever way they are.
const MIN_ALONG_M = 5;
const CELL_UNITS = 64;

export const TURNS = ["slight-left", "left", "sharp-left", "uturn", "sharp-right", "right", "slight-right"];

/**
 * Indexes the street names (the tiles' "transportation_name" lines) and the
 * kinds of way (their "transportation" lines) near a route, for lookups at
 * its turns.
 *
 * @param {Array<{x: number, y: number, extent: number, features: Array, names: Array}>} tiles
 * @returns {Object} An opaque index for `routeSteps`.
 */
export function buildWayIndex(tiles) {
	const cells = new Map();
	const add = (ax, ay, bx, by, label) => {
		const minX = Math.floor(Math.min(ax, bx) / CELL_UNITS);
		const maxX = Math.floor(Math.max(ax, bx) / CELL_UNITS);
		const minY = Math.floor(Math.min(ay, by) / CELL_UNITS);
		const maxY = Math.floor(Math.max(ay, by) / CELL_UNITS);
		const entry = { ax, ay, bx, by, ...label };
		for (let cx = minX; cx <= maxX; cx++) {
			for (let cy = minY; cy <= maxY; cy++) {
				const key = cx * 1e8 + cy;
				let list = cells.get(key);
				if (!list) cells.set(key, (list = []));
				list.push(entry);
			}
		}
	};

	for (const tile of tiles) {
		const scale = 4096 / tile.extent;
		const originX = tile.x * 4096;
		const originY = tile.y * 4096;
		const lines = [
			...(tile.names ?? []).map((feature) => [feature, { name: feature.properties.name || feature.properties.ref || null }]),
			...tile.features.map((feature) => [feature, { kind: wayKind(feature.properties) }]).filter(([, label]) => label.kind),
		];
		for (const [feature, label] of lines) {
			if (label.name === null) continue;
			for (const line of feature.lines) {
				for (let i = 1; i < line.length; i++) {
					add(
						originX + line[i - 1][0] * scale,
						originY + line[i - 1][1] * scale,
						originX + line[i][0] * scale,
						originY + line[i][1] * scale,
						label,
					);
				}
			}
		}
	}
	return { cells };
}

/** What to call an unnamed way, where it's worth saying. */
function wayKind(props) {
	if (props.class === "track") return "track";
	if (props.class !== "path") return null;
	return props.subclass === "cycleway" ? "bike path" : "path";
}

/**
 * The turn-by-turn steps along a route.
 *
 * @param {Object} input
 * @param {Array<[number, number]>} input.coords - The route, [lng, lat], in riding order.
 * @param {Object} input.graph - The road graph (route-graph.js) the route runs on.
 * @param {Object} input.index - From `buildWayIndex`.
 * @param {number} input.junctionReach - How far (meters) a route point may be from a
 *   junction and still be taken to pass through it: tiny for a route routed
 *   on this graph, whose points are its nodes; more for a line from
 *   elsewhere (an imported track) that only runs near them.
 * @returns {Array<Object>} Steps in order, the last one the arrival.
 */
export function routeSteps({ coords, graph, index, junctionReach }) {
	const mpu = graph.metersPerUnit;
	const units = coords.map(toUnits);
	const along = [0];
	for (let i = 1; i < units.length; i++) {
		along.push(along[i - 1] + Math.hypot(units[i][0] - units[i - 1][0], units[i][1] - units[i - 1][1]) * mpu);
	}
	const total = along[along.length - 1];

	// The route's points at junctions: where a run of points passes the same
	// junction, only the one nearest it.
	const atJunctions = [];
	for (let i = 1; i < units.length - 1; i++) {
		const junction = junctionNear(graph, units[i][0], units[i][1], junctionReach / mpu);
		if (!junction) continue;
		const last = atJunctions[atJunctions.length - 1];
		if (last && last.node === junction.node) {
			if (junction.distance < last.distance) Object.assign(last, { i, distance: junction.distance });
		} else {
			atJunctions.push({ i, node: junction.node, distance: junction.distance });
		}
	}

	// Junctions close together make one turn.
	const clusters = [];
	for (const junction of atJunctions) {
		const last = clusters[clusters.length - 1];
		if (last && along[junction.i] - along[last.last] < CLUSTER_M) last.last = junction.i;
		else clusters.push({ first: junction.i, last: junction.i });
	}

	const steps = [];
	for (const { first, last } of clusters) {
		if (along[first] < MIN_ALONG_M) continue;
		const before = pointAt(units, along, along[first] - TURN_WINDOW_M);
		const after = pointAt(units, along, along[last] + TURN_WINDOW_M);
		const headingIn = heading(before, units[first]);
		const headingOut = heading(units[last], after);
		const angle = normalize(headingOut - headingIn);
		const magnitude = Math.abs(angle);
		if (magnitude < STRAIGHT_DEG) continue;

		const onto = lookup(index, pointAt(units, along, along[last] + NAME_LOOKAHEAD_M), headingOut, mpu);
		const from = lookup(index, pointAt(units, along, along[first] - NAME_LOOKAHEAD_M), headingIn, mpu);
		const stay = Boolean(from.name) && from.name === onto.name;
		if (stay && magnitude < SAME_ROAD_MAX_DEG) continue;

		const side = angle > 0 ? "right" : "left";
		const turn =
			magnitude >= UTURN_DEG ? "uturn" : magnitude >= SHARP_DEG ? `sharp-${side}` : magnitude >= SLIGHT_DEG ? side : `slight-${side}`;
		steps.push({ index: first, along: along[first], turn, name: onto.name, kind: onto.kind, stay, point: coords[first] });
	}
	steps.push({ index: coords.length - 1, along: total, turn: "arrive", name: null, kind: null, stay: false, point: coords[coords.length - 1] });
	return steps;
}

/** The point `meters` along the route (clamped to its ends), in units. */
function pointAt(units, along, meters) {
	if (meters <= 0) return units[0];
	for (let i = 1; i < units.length; i++) {
		if (along[i] >= meters) {
			const span = along[i] - along[i - 1];
			const t = span ? (meters - along[i - 1]) / span : 0;
			return [units[i - 1][0] + (units[i][0] - units[i - 1][0]) * t, units[i - 1][1] + (units[i][1] - units[i - 1][1]) * t];
		}
	}
	return units[units.length - 1];
}

/** Compass heading from a to b, in degrees (units run east and south). */
function heading(a, b) {
	return (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
}

/** An angle in degrees, brought into (-180, 180]. */
function normalize(degrees) {
	let d = degrees % 360;
	if (d > 180) d -= 360;
	if (d <= -180) d += 360;
	return d;
}

/**
 * The street name and way kind at a point on the route, from the nearest
 * indexed lines running the route's way (either direction) there.
 * @returns {{name: string|null, kind: string|null}}
 */
function lookup(index, [x, y], routeHeading, mpu) {
	const reach = NAME_REACH_M / mpu;
	const found = { name: null, kind: null };
	let nameDistance = reach;
	let kindDistance = reach;
	const cx = Math.floor(x / CELL_UNITS);
	const cy = Math.floor(y / CELL_UNITS);
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			for (const entry of index.cells.get((cx + dx) * 1e8 + cy + dy) ?? []) {
				const sx = entry.bx - entry.ax;
				const sy = entry.by - entry.ay;
				const lengthSq = sx * sx + sy * sy;
				if (!lengthSq) continue;
				const t = Math.max(0, Math.min(1, ((x - entry.ax) * sx + (y - entry.ay) * sy) / lengthSq));
				const distance = Math.hypot(x - (entry.ax + sx * t), y - (entry.ay + sy * t));
				if (distance > Math.max(nameDistance, kindDistance)) continue;
				// Lines run either way along a road, so only the axis has to match.
				const off = Math.abs(normalize(heading([entry.ax, entry.ay], [entry.bx, entry.by]) - routeHeading));
				if (Math.min(off, 180 - off) > NAME_MAX_DEG) continue;
				if (entry.name && distance < nameDistance) {
					nameDistance = distance;
					found.name = entry.name;
				} else if (entry.kind && distance < kindDistance) {
					kindDistance = distance;
					found.kind = entry.kind;
				}
			}
		}
	}
	return found;
}
