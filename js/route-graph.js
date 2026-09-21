/**
 * Turns the road lines in cached zoom-14 map tiles into a routable graph and
 * searches it with A*. Runs inside the route-home worker (see
 * route-worker.js), but has no worker or DOM dependencies of its own.
 *
 * Map tiles store roads for drawing, not routing: lines are cut at tile
 * edges, and a junction on a straight road often has no shared vertex. So
 * the graph is built from individual segments: each is clipped to its own
 * tile (dropping the overlap buffer every tile carries), split wherever it
 * meets another segment on the same level (a bridge doesn't meet the road
 * it crosses), and joined to the others by snapping nearby points together.
 *
 * All geometry works in "global units": the zoom-14 tile grid at 4096 units
 * per tile, which is plain Web Mercator. Edge costs are meters multiplied by
 * how much a profile prefers that kind of way, so the search finds the
 * route that is quickest in practice, not merely shortest.
 */

export const TILE_ZOOM = 14;
const TILE_EXTENT = 4096;
const WORLD_UNITS = 2 ** TILE_ZOOM * TILE_EXTENT;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Points this close (in units, about half a meter each) are the same node.
// Where a line was cut at a tile edge the two tiles' cuts can disagree a
// little more, so those points snap from further away.
const SNAP_UNITS = 1.5;
const EDGE_SNAP_UNITS = 4;
// Bucket sizes for the spatial hashes: segments (junction finding and
// nearest-road lookups) and nodes (snapping).
const SEGMENT_CELL_UNITS = 64;
const NODE_CELL_UNITS = 4;

// How far the rider or the start may be from a known road and still be
// routed, in meters. The recorded track usually covers the rider.
const SNAP_RADIUS_M = 200;
// The recorded track is a last resort for gaps in the cached map: it is
// known to be passable, but it follows GPS noise rather than the road, so it
// costs a lot more than a real road. Its points are thinned to this spacing
// and joined to roads within the reach below.
const TRACK_COST = 2.0;
const TRACK_SPACING_M = 20;
const TRACK_LINK_M = 15;
// Going against a one-way (or through a "dismount" way) means walking the
// bike, so it costs this many times more. It is allowed rather than ruled
// out so that one-ways can never strand the rider with no route at all.
const WRONG_WAY_COST = 5;
// Map tiles sometimes leave a path's link to the next way out: most often
// the few meters where a trail crosses a road, which some tile builds drop
// along with other crossings. So a path or track that simply stops is joined
// to the nearest other way within GAP_REACH_M, each meter of the join costing
// GAP_COST meters: enough to hop a crossing, not enough to beat a real route
// that's only a little longer. Roads that dead-end aren't bridged, so a
// cul-de-sac can't cut through the back yards to the next street.
const GAP_REACH_M = 25;
const GAP_COST = 3;
// A dead end never joins a way it already reaches within this far along the
// network: the nearest way to the end of a path is often the path itself.
const GAP_OWN_REACH_M = 50;

// "Avoid Retracing": riding a road back the way the rider came out costs
// this many times more. Heavy, but not a ban, so a dead end or an out-and-back
// trail can still lead home. A road counts as ridden out along when its
// middle lies within RETRACE_REACH_M of the ride's track and it runs within
// about 37° of the track's direction there, so cross streets don't count.
const RETRACE_COST = 6;
const RETRACE_REACH_M = 20;
const RETRACE_MIN_COS = 0.8;
// Per-edge flags: the ride went along the edge from its a end to its b end,
// or from b to a.
const WENT_FORWARD = 1;
const WENT_BACKWARD = 2;

// The rider and the start snap to the nearest road that is part of a
// network at least this big (in nodes), so an isolated scrap of path, cut
// off by the edge of the cached map or by ways the profile can't use,
// doesn't strand either end.
const MIN_NETWORK_NODES = 50;

// Cost multipliers per road class. Missing classes (rail, ferry, anything
// under construction) are never used. Paths go by subclass, which tile
// sources spell differently: OpenFreeMap calls a road crossing or sidewalk a
// "footway", Stadia calls them "crossing" and "sidewalk", and some paths
// have no subclass at all. A subclass not listed costs `otherPath`; a null
// one (steps, on a bike) is never used.
const PROFILES = {
	bike: {
		classes: { trunk: 2.5, primary: 1.35, secondary: 1.2, tertiary: 1.1, minor: 1, service: 1.15, track: 1.5, busway: 1.3 },
		paths: { cycleway: 0.9, path: 1.3, bridleway: 1.6, steps: null },
		otherPath: 1.6,
		tag: "bicycle",
		// A path open to bikes is treated about as well as a cycleway.
		allowedPathCost: 0.95,
		unpavedFactor: 1.35,
		oneway: true,
		minCost: 0.9,
	},
	foot: {
		classes: { trunk: 2, primary: 1.25, secondary: 1.15, tertiary: 1.05, minor: 1, service: 1, track: 1, busway: 1.3 },
		paths: { cycleway: 1, bridleway: 1, platform: 1, steps: 1.1 },
		otherPath: 0.9,
		tag: "foot",
		allowedPathCost: 0.9,
		unpavedFactor: 1,
		oneway: false,
		minCost: 0.9,
	},
};

const ALLOWED_TAG_VALUES = new Set(["yes", "designated", "permissive"]);

/**
 * Converts [lng, lat] to global units.
 * @returns {[number, number]}
 */
export function toUnits([lng, lat]) {
	const latRad = (lat * Math.PI) / 180;
	const x = ((lng + 180) / 360) * WORLD_UNITS;
	const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * WORLD_UNITS;
	return [x, y];
}

/**
 * Converts global units back to [lng, lat].
 * @returns {[number, number]}
 */
export function toLngLat([x, y]) {
	const lng = (x / WORLD_UNITS) * 360 - 180;
	const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD_UNITS))) * 180) / Math.PI;
	return [lng, lat];
}

/**
 * The zoom-14 tile containing a point.
 * @returns {{x: number, y: number}}
 */
export function tileFor(lngLat) {
	const [x, y] = toUnits(lngLat);
	return { x: Math.floor(x / TILE_EXTENT), y: Math.floor(y / TILE_EXTENT) };
}

/**
 * Works out how a way may be ridden or walked under a profile.
 *
 * @param {Object} props - The tile feature's OpenMapTiles properties.
 * @param {Object} profile - One of PROFILES.
 * @returns {{forward: number, backward: number, level: number, path: boolean}|null}
 *   Cost multipliers per direction (a closed direction costs WRONG_WAY_COST
 *   times more), and whether it's a path or track (see GAP_REACH_M); or null
 *   when the way can't be used at all.
 */
function wayRule(props, profile) {
	const tagValue = props[profile.tag];
	if (tagValue === "no") return null;
	const allowed = ALLOWED_TAG_VALUES.has(tagValue);
	if ((props.access === "no" || props.access === "private") && !allowed) return null;

	let cost;
	if (props.class === "path") {
		cost = props.subclass in profile.paths ? profile.paths[props.subclass] : profile.otherPath;
		if (cost === null) return null;
		if (allowed) cost = Math.min(cost, profile.allowedPathCost);
	} else {
		cost = profile.classes[props.class];
		if (cost === undefined) return null;
	}
	if (tagValue === "dismount") cost *= WRONG_WAY_COST;
	if (props.surface === "unpaved" && props.class !== "track" && props.class !== "path") cost *= profile.unpavedFactor;

	const oneway = profile.oneway && props.class !== "path" ? props.oneway : 0;
	let level = Number.isFinite(props.layer) ? props.layer : 0;
	if (props.brunnel === "bridge" && !props.layer) level = 1;
	if (props.brunnel === "tunnel" && !props.layer) level = -1;

	return {
		forward: oneway === -1 ? cost * WRONG_WAY_COST : cost,
		backward: oneway === 1 ? cost * WRONG_WAY_COST : cost,
		level,
		path: props.class === "path" || props.class === "track",
	};
}

/**
 * Clips the segment p→q to the box [0, size]² (Liang–Barsky).
 * @returns {[number, number]|null} The kept part's range along p→q, as
 *   [t0, t1] with 0 ≤ t0 < t1 ≤ 1, or null when none of it is inside.
 */
function clipToBox(px, py, qx, qy, size) {
	let t0 = 0;
	let t1 = 1;
	const dx = qx - px;
	const dy = qy - py;
	const checks = [
		[-dx, px],
		[dx, size - px],
		[-dy, py],
		[dy, size - py],
	];
	for (const [p, q] of checks) {
		if (p === 0) {
			if (q < 0) return null;
			continue;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) return null;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return null;
			if (r < t1) t1 = r;
		}
	}
	return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

/**
 * Builds a routing graph.
 *
 * @param {Object} input
 * @param {Array<{x: number, y: number, extent: number, features: Array}>} input.tiles -
 *   Decoded zoom-14 "transportation" layers (see mvt.js), with each tile's
 *   column and row.
 * @param {[number, number]} input.start - The ride's start, [lng, lat].
 * @param {Array<[number, number]>} [input.track] - The ride so far, [lng, lat] each.
 * @param {"bike"|"foot"} input.profile
 * @returns {Object} An opaque graph for `findRoute`.
 */
export function buildGraph({ tiles, start, track = [], profile: profileName }) {
	const profile = PROFILES[profileName] ?? PROFILES.bike;
	const metersPerUnit = (EARTH_CIRCUMFERENCE_M * Math.cos((start[1] * Math.PI) / 180)) / WORLD_UNITS;

	// ---- 1. Segments, clipped to their own tile ----
	const seg = { ax: [], ay: [], bx: [], by: [], aEdge: [], bEdge: [], forward: [], backward: [], level: [], path: [] };
	const addSegment = (ax, ay, bx, by, aEdge, bEdge, forward, backward, level, path) => {
		seg.ax.push(ax);
		seg.ay.push(ay);
		seg.bx.push(bx);
		seg.by.push(by);
		seg.aEdge.push(aEdge);
		seg.bEdge.push(bEdge);
		seg.forward.push(forward);
		seg.backward.push(backward);
		seg.level.push(level);
		seg.path.push(path);
	};

	for (const tile of tiles) {
		const scale = TILE_EXTENT / tile.extent;
		const originX = tile.x * TILE_EXTENT;
		const originY = tile.y * TILE_EXTENT;
		for (const feature of tile.features) {
			const rule = wayRule(feature.properties, profile);
			if (!rule) continue;
			for (const line of feature.lines) {
				for (let i = 0; i + 1 < line.length; i++) {
					const px = line[i][0] * scale;
					const py = line[i][1] * scale;
					const qx = line[i + 1][0] * scale;
					const qy = line[i + 1][1] * scale;
					const kept = clipToBox(px, py, qx, qy, TILE_EXTENT);
					if (!kept) continue;
					const [t0, t1] = kept;
					addSegment(
						originX + px + (qx - px) * t0,
						originY + py + (qy - py) * t0,
						originX + px + (qx - px) * t1,
						originY + py + (qy - py) * t1,
						t0 > 0,
						t1 < 1,
						rule.forward,
						rule.backward,
						rule.level,
						rule.path,
					);
				}
			}
		}
	}
	const roadSegmentCount = seg.ax.length;

	// ---- 2. Junctions: where segments cross or one ends on another ----
	const splits = findJunctions(seg, roadSegmentCount);

	// ---- 3. Nodes and edges ----
	const graph = createGraphStore(metersPerUnit, profile);
	for (let i = 0; i < roadSegmentCount; i++) {
		const points = [[seg.ax[i], seg.ay[i], seg.aEdge[i]]];
		const cuts = splits.get(i);
		if (cuts) {
			cuts.sort((a, b) => a - b);
			const dx = seg.bx[i] - seg.ax[i];
			const dy = seg.by[i] - seg.ay[i];
			for (const t of cuts) points.push([seg.ax[i] + dx * t, seg.ay[i] + dy * t, false]);
		}
		points.push([seg.bx[i], seg.by[i], seg.bEdge[i]]);

		let prev = graph.node(points[0][0], points[0][1], points[0][2]);
		for (let k = 1; k < points.length; k++) {
			const next = graph.node(points[k][0], points[k][1], points[k][2]);
			graph.link(prev, next, seg.forward[i], seg.backward[i], seg.path[i], seg.level[i]);
			prev = next;
		}
	}

	// ---- 4. Paths that stop short of the way they should meet ----
	bridgeGaps(graph, metersPerUnit);

	// ---- 5. The recorded track, as a costly fallback for map gaps ----
	graph.roadEdgeCount = graph.edgeA.length;
	addTrack(graph, track, metersPerUnit);

	// ---- 6. The goal: a node on the road nearest the start ----
	labelNetworks(graph);
	const startUnits = toUnits(start);
	graph.goal = null;
	const snap = snapToNetwork(graph, startUnits, graph.inBigNetwork);
	if (snap) {
		const goal = graph.addNode(startUnits[0], startUnits[1]);
		const edge = snap.edge;
		const ex = graph.edgeA[edge];
		const eb = graph.edgeB[edge];
		// Reaching the start from one end of its road means riding the part of
		// that road between the end and the start, in the edge's own direction.
		const lengthA = Math.hypot(snap.x - graph.x[ex], snap.y - graph.y[ex]) * metersPerUnit;
		const lengthB = Math.hypot(snap.x - graph.x[eb], snap.y - graph.y[eb]) * metersPerUnit;
		const offRoad = snap.distance * metersPerUnit;
		graph.addArc(ex, goal, lengthA * graph.edgeForward[edge] + offRoad, edge * 2);
		graph.addArc(eb, goal, lengthB * graph.edgeBackward[edge] + offRoad, edge * 2 + 1);
		graph.goal = { node: goal, edge, x: snap.x, y: snap.y, units: startUnits };
	}

	// Filled in by markRetraced, as the ride goes on.
	graph.trackDirection = new Uint8Array(graph.edgeA.length);
	graph.retraceMarkedTo = 0;

	graph.stats = { segments: roadSegmentCount, nodes: graph.x.length, edges: graph.edgeA.length };
	return graph;
}

/**
 * Finds every junction between the road segments: where two cross, or where
 * one ends on (or within snapping distance of) another. Segments on
 * different levels never meet.
 *
 * Each pair is checked in every hash cell the two share, so a junction is
 * only recorded in the cell that contains it, keeping each one to a single
 * entry without tracking which pairs were already checked. Segments go into
 * every cell within snapping reach of them, so the junction's own cell
 * always holds both.
 *
 * @returns {Map<number, number[]>} Segment index → split positions (0..1) along it.
 */
function findJunctions(seg, count) {
	const cells = new Map();
	for (let i = 0; i < count; i++) {
		const minX = Math.floor((Math.min(seg.ax[i], seg.bx[i]) - SNAP_UNITS) / SEGMENT_CELL_UNITS);
		const maxX = Math.floor((Math.max(seg.ax[i], seg.bx[i]) + SNAP_UNITS) / SEGMENT_CELL_UNITS);
		const minY = Math.floor((Math.min(seg.ay[i], seg.by[i]) - SNAP_UNITS) / SEGMENT_CELL_UNITS);
		const maxY = Math.floor((Math.max(seg.ay[i], seg.by[i]) + SNAP_UNITS) / SEGMENT_CELL_UNITS);
		for (let cx = minX; cx <= maxX; cx++) {
			for (let cy = minY; cy <= maxY; cy++) {
				const key = cx * 1e8 + cy;
				let list = cells.get(key);
				if (!list) cells.set(key, (list = []));
				list.push(i);
			}
		}
	}

	const splits = new Map();
	const addSplit = (i, t) => {
		let list = splits.get(i);
		if (!list) splits.set(i, (list = []));
		list.push(t);
	};

	for (const [key, list] of cells) {
		const cellX = Math.floor(key / 1e8);
		const cellY = key - cellX * 1e8;
		const ownsPoint = (x, y) =>
			Math.floor(x / SEGMENT_CELL_UNITS) === cellX && Math.floor(y / SEGMENT_CELL_UNITS) === cellY;

		for (let m = 0; m < list.length; m++) {
			const i = list[m];
			for (let n = m + 1; n < list.length; n++) {
				const j = list[n];
				if (seg.level[i] !== seg.level[j]) continue;
				meetSegments(seg, i, j, ownsPoint, addSplit);
			}
		}
	}
	return splits;
}

/**
 * Records where segments i and j meet, if they do: a proper crossing, or an
 * end of either one lying within snapping distance of the other's middle.
 * Meetings at both segments' ends need no split; snapping joins those.
 */
function meetSegments(seg, i, j, ownsPoint, addSplit) {
	const px = seg.ax[i];
	const py = seg.ay[i];
	const rx = seg.bx[i] - px;
	const ry = seg.by[i] - py;
	const qx = seg.ax[j];
	const qy = seg.ay[j];
	const sx = seg.bx[j] - qx;
	const sy = seg.by[j] - qy;
	const lengthI = Math.hypot(rx, ry);
	const lengthJ = Math.hypot(sx, sy);
	if (lengthI === 0 || lengthJ === 0) return;
	// Split positions within this many units of a segment's end are left to snapping.
	const endI = SNAP_UNITS / lengthI;
	const endJ = SNAP_UNITS / lengthJ;

	const denom = rx * sy - ry * sx;
	if (Math.abs(denom) > 1e-9) {
		const t = ((qx - px) * sy - (qy - py) * sx) / denom;
		const u = ((qx - px) * ry - (qy - py) * rx) / denom;
		if (t >= -endI && t <= 1 + endI && u >= -endJ && u <= 1 + endJ) {
			const x = px + rx * t;
			const y = py + ry * t;
			if (!ownsPoint(x, y)) return;
			if (t > endI && t < 1 - endI) addSplit(i, t);
			if (u > endJ && u < 1 - endJ) addSplit(j, u);
			return;
		}
	}

	// No crossing (or parallel): an end of one may still fall just short of the other.
	nearEnd(seg.ax[i], seg.ay[i], j, qx, qy, sx, sy, lengthJ, ownsPoint, addSplit);
	nearEnd(seg.bx[i], seg.by[i], j, qx, qy, sx, sy, lengthJ, ownsPoint, addSplit);
	nearEnd(seg.ax[j], seg.ay[j], i, px, py, rx, ry, lengthI, ownsPoint, addSplit);
	nearEnd(seg.bx[j], seg.by[j], i, px, py, rx, ry, lengthI, ownsPoint, addSplit);
}

/** Splits segment `k` (from q along s) where point e falls within snapping distance of its middle. */
function nearEnd(ex, ey, k, qx, qy, sx, sy, length, ownsPoint, addSplit) {
	const u = ((ex - qx) * sx + (ey - qy) * sy) / (length * length);
	const end = SNAP_UNITS / length;
	if (u <= end || u >= 1 - end) return;
	const x = qx + sx * u;
	const y = qy + sy * u;
	if (Math.hypot(ex - x, ey - y) > SNAP_UNITS) return;
	if (!ownsPoint(ex, ey)) return;
	addSplit(k, u);
}

/**
 * The graph's storage: node positions with a snapping hash, directed arcs
 * as adjacency lists, and the undirected edges (with a spatial hash) used to
 * find the road nearest a point.
 */
function createGraphStore(metersPerUnit, profile) {
	const graph = {
		metersPerUnit,
		minCost: Math.min(profile.minCost, 1),
		x: [],
		y: [],
		arcsTo: [],
		arcsCost: [],
		// Per arc: its edge's index × 2, plus 1 when it runs from the edge's b
		// end to its a end.
		arcsEdge: [],
		edgeA: [],
		edgeB: [],
		edgeForward: [],
		edgeBackward: [],
		// Per edge: whether it's a path or track, its level (see wayRule), and
		// whether it has been replaced by the two halves it was split into
		// (see splitEdge).
		edgePath: [],
		edgeLevel: [],
		edgeDead: [],
		nodeCells: new Map(),
		edgeCells: new Map(),
	};

	graph.addNode = (x, y) => {
		const id = graph.x.length;
		graph.x.push(x);
		graph.y.push(y);
		graph.arcsTo.push([]);
		graph.arcsCost.push([]);
		graph.arcsEdge.push([]);
		return id;
	};

	/** The node at (x, y): an existing one within snapping distance, or a new one. */
	graph.node = (x, y, onTileEdge = false) => {
		const reach = onTileEdge ? EDGE_SNAP_UNITS : SNAP_UNITS;
		const cx = Math.floor(x / NODE_CELL_UNITS);
		const cy = Math.floor(y / NODE_CELL_UNITS);
		let best = -1;
		let bestDistance = reach;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const list = graph.nodeCells.get((cx + dx) * 1e8 + cy + dy);
				if (!list) continue;
				for (const id of list) {
					const distance = Math.hypot(graph.x[id] - x, graph.y[id] - y);
					if (distance <= bestDistance) {
						best = id;
						bestDistance = distance;
					}
				}
			}
		}
		if (best >= 0) return best;
		const id = graph.addNode(x, y);
		const key = cx * 1e8 + cy;
		let list = graph.nodeCells.get(key);
		if (!list) graph.nodeCells.set(key, (list = []));
		list.push(id);
		return id;
	};

	graph.addArc = (from, to, cost, edgeCode) => {
		graph.arcsTo[from].push(to);
		graph.arcsCost[from].push(cost);
		graph.arcsEdge[from].push(edgeCode);
	};

	/** Joins two nodes with an edge, costed per direction by the multipliers given. */
	graph.link = (a, b, forward, backward, path = false, level = 0) => {
		if (a === b) return;
		const meters = Math.hypot(graph.x[b] - graph.x[a], graph.y[b] - graph.y[a]) * metersPerUnit;
		const edge = graph.edgeA.length;
		graph.addArc(a, b, meters * forward, edge * 2);
		graph.addArc(b, a, meters * backward, edge * 2 + 1);

		graph.edgeA.push(a);
		graph.edgeB.push(b);
		graph.edgeForward.push(forward);
		graph.edgeBackward.push(backward);
		graph.edgePath.push(path);
		graph.edgeLevel.push(level);
		graph.edgeDead.push(false);
		const minX = Math.floor(Math.min(graph.x[a], graph.x[b]) / SEGMENT_CELL_UNITS);
		const maxX = Math.floor(Math.max(graph.x[a], graph.x[b]) / SEGMENT_CELL_UNITS);
		const minY = Math.floor(Math.min(graph.y[a], graph.y[b]) / SEGMENT_CELL_UNITS);
		const maxY = Math.floor(Math.max(graph.y[a], graph.y[b]) / SEGMENT_CELL_UNITS);
		for (let cx = minX; cx <= maxX; cx++) {
			for (let cy = minY; cy <= maxY; cy++) {
				const key = cx * 1e8 + cy;
				let list = graph.edgeCells.get(key);
				if (!list) graph.edgeCells.set(key, (list = []));
				list.push(edge);
			}
		}
	};

	/**
	 * The closest point on any edge to (x, y), within `radius` units.
	 * @param {(edge: number) => boolean} [accept] - Limits which edges count.
	 * @returns {{edge: number, x: number, y: number, t: number, distance: number}|null}
	 */
	graph.nearestEdge = (x, y, radius, accept) => {
		const minX = Math.floor((x - radius) / SEGMENT_CELL_UNITS);
		const maxX = Math.floor((x + radius) / SEGMENT_CELL_UNITS);
		const minY = Math.floor((y - radius) / SEGMENT_CELL_UNITS);
		const maxY = Math.floor((y + radius) / SEGMENT_CELL_UNITS);
		let best = null;
		for (let cx = minX; cx <= maxX; cx++) {
			for (let cy = minY; cy <= maxY; cy++) {
				const list = graph.edgeCells.get(cx * 1e8 + cy);
				if (!list) continue;
				for (const edge of list) {
					if (graph.edgeDead[edge] || (accept && !accept(edge))) continue;
					const a = graph.edgeA[edge];
					const b = graph.edgeB[edge];
					const ax = graph.x[a];
					const ay = graph.y[a];
					const dx = graph.x[b] - ax;
					const dy = graph.y[b] - ay;
					const lengthSq = dx * dx + dy * dy;
					const t = lengthSq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
					const px = ax + dx * t;
					const py = ay + dy * t;
					const distance = Math.hypot(x - px, y - py);
					if (distance <= radius && (!best || distance < best.distance)) {
						best = { edge, x: px, y: py, t, distance };
					}
				}
			}
		}
		return best;
	};

	return graph;
}

/**
 * Joins each path or track that dead-ends to the nearest other way on the
 * same level within GAP_REACH_M, at GAP_COST per meter (see there for why),
 * so a walkway ending on a bridge isn't dropped onto the street below. Ways
 * the dead end already reaches within GAP_OWN_REACH_M don't count. The join
 * lands on the nearest point of that way, which is split to take it.
 */
function bridgeGaps(graph, metersPerUnit) {
	const edgeCount = graph.edgeA.length;
	const degree = new Map();
	for (let edge = 0; edge < edgeCount; edge++) {
		for (const node of [graph.edgeA[edge], graph.edgeB[edge]]) degree.set(node, (degree.get(node) ?? 0) + 1);
	}

	const reach = GAP_REACH_M / metersPerUnit;
	for (let edge = 0; edge < edgeCount; edge++) {
		if (!graph.edgePath[edge]) continue;
		for (const node of [graph.edgeA[edge], graph.edgeB[edge]]) {
			if (degree.get(node) !== 1) continue;
			const x = graph.x[node];
			const y = graph.y[node];
			const level = graph.edgeLevel[edge];
			const own = nodesWithin(graph, node, GAP_OWN_REACH_M);
			const target = graph.nearestEdge(
				x,
				y,
				reach,
				(other) => !own.has(graph.edgeA[other]) && !own.has(graph.edgeB[other]) && graph.edgeLevel[other] === level,
			);
			if (!target) continue;
			const meets = splitEdge(graph, target);
			if (meets === node) continue;
			graph.link(node, meets, GAP_COST, GAP_COST);
			degree.set(node, 2);
		}
	}
}

/**
 * The nodes reachable from `start` within `meters` along the graph, in
 * either direction (a small Dijkstra, by length alone).
 * @returns {Set<number>}
 */
function nodesWithin(graph, start, meters) {
	const best = new Map([[start, 0]]);
	const queue = [[0, start]];
	while (queue.length) {
		queue.sort((a, b) => b[0] - a[0]);
		const [distance, node] = queue.pop();
		if (distance > best.get(node)) continue;
		const to = graph.arcsTo[node];
		for (let k = 0; k < to.length; k++) {
			const next = to[k];
			const step = Math.hypot(graph.x[next] - graph.x[node], graph.y[next] - graph.y[node]) * graph.metersPerUnit;
			const total = distance + step;
			if (total <= meters && total < (best.get(next) ?? Infinity)) {
				best.set(next, total);
				queue.push([total, next]);
			}
		}
	}
	return new Set(best.keys());
}

/**
 * Splits an edge at a point along it (from `nearestEdge`), returning the
 * node there: one of its ends if the point is within snapping distance of
 * it, or a new node, the edge then replaced by its two halves.
 *
 * @param {Object} graph
 * @param {{edge: number, x: number, y: number}} at
 * @returns {number} The node.
 */
function splitEdge(graph, { edge, x, y }) {
	const a = graph.edgeA[edge];
	const b = graph.edgeB[edge];
	if (Math.hypot(graph.x[a] - x, graph.y[a] - y) <= SNAP_UNITS) return a;
	if (Math.hypot(graph.x[b] - x, graph.y[b] - y) <= SNAP_UNITS) return b;

	const removeArc = (from, code) => {
		const k = graph.arcsEdge[from].indexOf(code);
		if (k < 0) return;
		graph.arcsTo[from].splice(k, 1);
		graph.arcsCost[from].splice(k, 1);
		graph.arcsEdge[from].splice(k, 1);
	};
	removeArc(a, edge * 2);
	removeArc(b, edge * 2 + 1);
	graph.edgeDead[edge] = true;

	const middle = graph.addNode(x, y);
	const { edgeForward, edgeBackward, edgePath } = graph;
	const { edgeLevel } = graph;
	graph.link(a, middle, edgeForward[edge], edgeBackward[edge], edgePath[edge], edgeLevel[edge]);
	graph.link(middle, b, edgeForward[edge], edgeBackward[edge], edgePath[edge], edgeLevel[edge]);
	return middle;
}

/**
 * The nearest point to `units` on an edge that passes `accept`, preferring
 * real roads: the recorded track runs through the rider and the start
 * exactly, so it would always be nearest, but leaving along it follows the
 * ride back rather than the roads.
 */
function snapToNetwork(graph, [x, y], accept) {
	const radius = SNAP_RADIUS_M / graph.metersPerUnit;
	return (
		graph.nearestEdge(x, y, radius, (edge) => edge < graph.roadEdgeCount && accept(edge)) ??
		graph.nearestEdge(x, y, radius, accept) ??
		graph.nearestEdge(x, y, radius)
	);
}

/**
 * Labels every node with the connected network it belongs to (ignoring
 * direction, which can't disconnect anything since every edge runs both
 * ways at some cost), and gives the graph an `inBigNetwork(edge)` test for
 * snapping. A network counts as big at MIN_NETWORK_NODES nodes, or when it
 * is the biggest there is.
 */
function labelNetworks(graph) {
	const count = graph.x.length;
	const parent = new Int32Array(count);
	for (let i = 0; i < count; i++) parent[i] = i;
	const root = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	for (let edge = 0; edge < graph.edgeA.length; edge++) {
		const a = root(graph.edgeA[edge]);
		const b = root(graph.edgeB[edge]);
		if (a !== b) parent[a] = b;
	}

	const size = new Int32Array(count);
	let largest = 0;
	for (let i = 0; i < count; i++) largest = Math.max(largest, ++size[root(i)]);
	const bigEnough = Math.min(MIN_NETWORK_NODES, largest);
	graph.network = (node) => root(node);
	graph.inBigNetwork = (edge) => size[root(graph.edgeA[edge])] >= bigEnough;
}

/**
 * Adds the recorded track as expensive two-way edges, each of its points
 * also linked to the nearest road within reach, so a route can cross a gap
 * in the cached map by retracing the ride.
 */
function addTrack(graph, track, metersPerUnit) {
	if (track.length < 2) return;
	const roadEdgeCount = graph.edgeA.length;
	const isRoad = (edge) => edge < roadEdgeCount;
	const spacing = TRACK_SPACING_M / metersPerUnit;
	const linkReach = TRACK_LINK_M / metersPerUnit;

	let prev = -1;
	let prevX = 0;
	let prevY = 0;
	track.forEach((lngLat, index) => {
		const [x, y] = toUnits(lngLat);
		const last = index === track.length - 1;
		if (prev >= 0 && !last && Math.hypot(x - prevX, y - prevY) < spacing) return;

		const id = graph.node(x, y);
		if (prev >= 0) graph.link(prev, id, TRACK_COST, TRACK_COST);

		const road = graph.nearestEdge(x, y, linkReach, isRoad);
		if (road) {
			// Joined to whichever end of that road piece is nearer.
			const end = road.t < 0.5 ? graph.edgeA[road.edge] : graph.edgeB[road.edge];
			graph.link(id, end, TRACK_COST, TRACK_COST);
		}
		prev = id;
		prevX = x;
		prevY = y;
	});
}

/**
 * Flags the edges the ride has gone along, and in which direction, for
 * "Avoid Retracing". Incremental: only the track's new segments are looked
 * at, plus its last one again, since that one ends at wherever the rider
 * was and gets extended as the ride goes on.
 *
 * @param {Object} graph - From `buildGraph`.
 * @param {Array<[number, number]>} track - The ride so far, [lng, lat] each.
 */
export function markRetraced(graph, track) {
	const reach = RETRACE_REACH_M / graph.metersPerUnit;
	const seenFor = new Int32Array(graph.edgeA.length).fill(-1);
	for (let i = graph.retraceMarkedTo; i + 1 < track.length; i++) {
		const [px, py] = toUnits(track[i]);
		const [qx, qy] = toUnits(track[i + 1]);
		const sx = qx - px;
		const sy = qy - py;
		const lengthSq = sx * sx + sy * sy;
		if (!lengthSq) continue;
		const length = Math.sqrt(lengthSq);

		const minX = Math.floor((Math.min(px, qx) - reach) / SEGMENT_CELL_UNITS);
		const maxX = Math.floor((Math.max(px, qx) + reach) / SEGMENT_CELL_UNITS);
		const minY = Math.floor((Math.min(py, qy) - reach) / SEGMENT_CELL_UNITS);
		const maxY = Math.floor((Math.max(py, qy) + reach) / SEGMENT_CELL_UNITS);
		for (let cx = minX; cx <= maxX; cx++) {
			for (let cy = minY; cy <= maxY; cy++) {
				const list = graph.edgeCells.get(cx * 1e8 + cy);
				if (!list) continue;
				for (const edge of list) {
					if (seenFor[edge] === i || graph.edgeDead[edge]) continue;
					seenFor[edge] = i;
					const a = graph.edgeA[edge];
					const b = graph.edgeB[edge];
					const ex = graph.x[b] - graph.x[a];
					const ey = graph.y[b] - graph.y[a];
					const edgeLength = Math.hypot(ex, ey);
					if (!edgeLength) continue;
					const cos = (ex * sx + ey * sy) / (edgeLength * length);
					if (Math.abs(cos) < RETRACE_MIN_COS) continue;

					const mx = (graph.x[a] + graph.x[b]) / 2;
					const my = (graph.y[a] + graph.y[b]) / 2;
					const t = Math.max(0, Math.min(1, ((mx - px) * sx + (my - py) * sy) / lengthSq));
					if (Math.hypot(mx - (px + sx * t), my - (py + sy * t)) > reach) continue;
					graph.trackDirection[edge] |= cos > 0 ? WENT_FORWARD : WENT_BACKWARD;
				}
			}
		}
	}
	graph.retraceMarkedTo = Math.max(0, track.length - 2);
}

/**
 * Finds the cheapest route from the rider to the graph's start.
 *
 * @param {Object} graph - From `buildGraph`.
 * @param {[number, number]} rider - [lng, lat].
 * @param {Object} [options]
 * @param {boolean} [options.avoidRetrace] - Make riding back the way the ride
 *   came out (as flagged by `markRetraced`) cost RETRACE_COST times more.
 * @returns {{coords: Array<[number, number]>, meters: number}|null} The route
 *   as [lng, lat] points from the rider to the start, and its length; null
 *   when either end is too far from any known road or no route connects them.
 */
export function findRoute(graph, rider, { avoidRetrace = false } = {}) {
	const goal = graph.goal;
	if (!goal) return null;
	// Only a road the start's network reaches can lead back to it.
	const goalNetwork = graph.network(graph.edgeA[goal.edge]);
	const snap = snapToNetwork(graph, toUnits(rider), (edge) => graph.network(graph.edgeA[edge]) === goalNetwork);
	if (!snap || graph.network(graph.edgeA[snap.edge]) !== goalNetwork) return null;

	const mpu = graph.metersPerUnit;
	const edge = snap.edge;
	const a = graph.edgeA[edge];
	const b = graph.edgeB[edge];
	const offRoad = snap.distance * mpu;
	const forward = graph.edgeForward[edge];
	const backward = graph.edgeBackward[edge];

	// Rider and start on the same piece of road: just ride along it.
	if (edge === goal.edge) {
		const path = [snap, goal].map((p) => [p.x, p.y]);
		return finishRoute(graph, rider, path, goal.units);
	}

	const nodeCount = graph.x.length;
	const cost = new Float64Array(nodeCount).fill(Infinity);
	const cameFrom = new Int32Array(nodeCount).fill(-1);
	const closed = new Uint8Array(nodeCount);
	const heap = createHeap();
	const gx = goal.x;
	const gy = goal.y;
	const heuristic = (node) => Math.hypot(graph.x[node] - gx, graph.y[node] - gy) * mpu * graph.minCost;
	// An arc goes back the way the ride came when the ride went along its
	// edge the other way.
	const direction = graph.trackDirection;
	const penalty = (edgeCode) => {
		if (!avoidRetrace || edgeCode === undefined) return 1;
		const against = edgeCode & 1 ? WENT_FORWARD : WENT_BACKWARD;
		return direction[edgeCode >> 1] & against ? RETRACE_COST : 1;
	};

	// The rider is part way along an edge, so the search starts from both of
	// its ends, each costed for the stretch of road to reach it.
	const seed = (node, meters) => {
		if (meters < cost[node]) {
			cost[node] = meters;
			heap.push(node, meters + heuristic(node));
		}
	};
	seed(b, offRoad + Math.hypot(graph.x[b] - snap.x, graph.y[b] - snap.y) * mpu * forward * penalty(edge * 2));
	seed(a, offRoad + Math.hypot(graph.x[a] - snap.x, graph.y[a] - snap.y) * mpu * backward * penalty(edge * 2 + 1));

	while (heap.size()) {
		const node = heap.pop();
		if (closed[node]) continue;
		closed[node] = 1;
		if (node === goal.node) break;
		const to = graph.arcsTo[node];
		const arcCost = graph.arcsCost[node];
		const arcEdge = graph.arcsEdge[node];
		for (let k = 0; k < to.length; k++) {
			const next = to[k];
			if (closed[next]) continue;
			const nextCost = cost[node] + arcCost[k] * penalty(arcEdge[k]);
			if (nextCost < cost[next]) {
				cost[next] = nextCost;
				cameFrom[next] = node;
				heap.push(next, nextCost + heuristic(next));
			}
		}
	}
	if (!closed[goal.node]) return null;

	const nodes = [];
	for (let node = cameFrom[goal.node]; node !== -1; node = cameFrom[node]) nodes.push(node);
	nodes.reverse();
	const path = [[snap.x, snap.y], ...nodes.map((node) => [graph.x[node], graph.y[node]]), [goal.x, goal.y]];
	return finishRoute(graph, rider, path, goal.units);
}

/** Wraps a unit-space path with the rider and start at its ends, in [lng, lat], with its length. */
function finishRoute(graph, rider, path, startUnits) {
	const units = [toUnits(rider), ...path, startUnits];
	let length = 0;
	for (let i = 1; i < units.length; i++) {
		length += Math.hypot(units[i][0] - units[i - 1][0], units[i][1] - units[i - 1][1]);
	}
	return { coords: units.map(toLngLat), meters: length * graph.metersPerUnit };
}

/** A binary min-heap of node ids keyed by priority. */
function createHeap() {
	const nodes = [];
	const keys = [];
	return {
		size: () => nodes.length,
		push(node, key) {
			let i = nodes.length;
			nodes.push(node);
			keys.push(key);
			while (i > 0) {
				const parent = (i - 1) >> 1;
				if (keys[parent] <= key) break;
				nodes[i] = nodes[parent];
				keys[i] = keys[parent];
				i = parent;
			}
			nodes[i] = node;
			keys[i] = key;
		},
		pop() {
			const top = nodes[0];
			const lastNode = nodes.pop();
			const lastKey = keys.pop();
			if (nodes.length) {
				let i = 0;
				const length = nodes.length;
				for (;;) {
					let child = 2 * i + 1;
					if (child >= length) break;
					if (child + 1 < length && keys[child + 1] < keys[child]) child++;
					if (keys[child] >= lastKey) break;
					nodes[i] = nodes[child];
					keys[i] = keys[child];
					i = child;
				}
				nodes[i] = lastNode;
				keys[i] = lastKey;
			}
			return top;
		},
	};
}
