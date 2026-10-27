/**
 * Cuts a recorded ride into road sections and times each one, for the best
 * pace map (pace-map.js). Runs inside the routing worker (route-worker.js)
 * on a graph from route-graph.js, but has no worker or DOM dependencies of
 * its own.
 *
 * A section is a stretch of road about SECTION_M long. Roads are first
 * joined into chains running from one junction to the next, then each chain
 * is cut into sections, at a side junction (a path, a driveway) where one
 * lies near a cut, so a rider turning off there covers the section up to it.
 * Where the cuts fall depends only on the map, never on the ride (a chain is
 * always cut from the same end), so every ride along a road times exactly
 * the same sections. A chain only stops where ways of its own rank or higher meet
 * (see `wayRule` in route-graph.js): a street runs on past driveways,
 * service roads and sidewalks, which would otherwise chop it into scraps a
 * few meters long, while a path stops wherever anything meets it.
 *
 * The ride is matched onto the chains point by point, with the stretch
 * between two points found along the network, so a sparse track (data
 * saver keeps no points along a straight road, however long) still crosses
 * every junction it passed. A fix or two too far from any way is stepped
 * over. A section counts once the ride has covered most of it in one
 * direction without a pause, and is timed over the part covered.
 *
 * Where the ride leaves the mapped ways altogether (a field, a beach, a trail
 * the map doesn't have), the recorded track itself is cut into sections of
 * about SECTION_M, marked `offNetwork`. Those cuts do follow the ride, so a
 * later ride there is matched to them by where they lie (see pace-map.js).
 */

import { toLngLat, toUnits } from "./route-graph.js";

const SECTION_M = 100;
// A section is never shorter than this unless its whole chain is, nor
// longer than this.
const MIN_SECTION_M = 40;
const MAX_SECTION_M = 150;
// Sections shorter than this are kept (they show the road was ridden) but
// not timed: a few meters between two fixes says nothing about pace.
const MIN_TIMED_M = 20;

// How far a fix may be from a road, or from a path, to be matched onto it, and
// how much farther a fix stays on the chain it was already on rather than
// hopping to a nearer parallel one (a trail beside a road).
const SNAP_ROAD_M = 25;
const SNAP_PATH_M = 20;
const STICKY_M = 10;

// Two fixes further apart than this in time aren't joined. Pauses are known
// and break the ride on their own, and data saver drops every point along a
// straight road, so a long gap between fixes is usually just a straight road.
const MAX_STEP_MS = 5 * 60000;
// Fixes matched to no way are stepped over while the recorded track between
// the matched fixes either side is no longer than this (GPS drifting off a
// trail); a longer stretch left the mapped ways.
const MAX_BRIDGE_M = 75;
// Where a road crosses from one map tile to the next, the two tiles' copies
// of it can stop up to this far apart; the gap is hopped.
const SEAM_M = 8;
// A section counts once the ride has covered this share of it. Less than
// that, but at least MIN_PARTIAL_M, is kept as a `partial` piece of it (a
// short jog along a street between two turns), so the map shows the ride
// went there.
const MIN_COVERED_SHARE = 0.5;
const MIN_PARTIAL_M = 10;
// Stretches off the mapped ways shorter than this aren't kept.
const MIN_OFF_NETWORK_M = 50;
// Faster than this between two fixes is a GPS jump, not riding.
const MAX_PLAUSIBLE_MPS = 30;
// The way between two fixes along the network may be at most this many times
// the straight line between them, plus this much; past that the match is wrong.
const DETOUR_FACTOR = 3;
const DETOUR_EXTRA_M = 60;
// A run along a chain takes its direction once the rider is this far from
// where it began, and has turned back once they're this far behind the
// furthest they got. Less than that is GPS noise: fixes a second apart, each
// a few meters out, often land behind the one before.
const DIRECTION_M = 10;
const UTURN_M = 25;

/**
 * Every section the ride covered, with how fast.
 *
 * @param {Object} graph - From `buildGraph`, built with no track.
 * @param {Array<[number, number, number, boolean]>} points - [lng, lat,
 *   timestamp, estimated] per fix, in order.
 * @param {Array<{start: number, end: number}>} pauses
 * @returns {Array<{coords: Array<[number, number]>, meters: number, speed: number|null, offNetwork?: boolean, partial?: boolean}>}
 *   Each section's line in the direction ridden, its length, the speed it
 *   was ridden at (m/s; null for a section too short to time), and whether
 *   it's off the mapped ways or only the part of a section ridden.
 */
export function rideSections(graph, points, pauses = []) {
	const net = buildChains(graph);
	const matched = matchPoints(graph, net, points);
	const sections = [];
	let run = null;
	const close = () => {
		if (run) sections.push(...coveredSections(net, run));
		run = null;
	};

	let last = -1;
	for (let i = 0; i < points.length; i++) {
		if (!matched[i]) continue;
		if (last >= 0) {
			const t1 = points[last][2];
			const t2 = points[i][2];
			const paused = pauses.some((pause) => pause.start < t2 && pause.end > t1);
			const joined = !paused && t2 > t1 && t2 - t1 <= MAX_STEP_MS && (i === last + 1 || trackMeters(points, last, i) <= MAX_BRIDGE_M);
			const pieces = joined ? wayBetween(net, matched[last], matched[i], straightMeters(points[last], points[i])) : null;
			const meters = pieces?.reduce((sum, piece) => sum + Math.abs(piece.to - piece.from), 0);
			if (!pieces || meters / ((t2 - t1) / 1000) > MAX_PLAUSIBLE_MPS) {
				close();
			} else {
				let along = 0;
				for (const piece of pieces) {
					const length = Math.abs(piece.to - piece.from);
					const start = meters ? t1 + ((t2 - t1) * along) / meters : t1;
					along += length;
					const end = meters ? t1 + ((t2 - t1) * along) / meters : t2;
					// A hop across a tile seam takes time but lies on no chain.
					if (piece.chain >= 0) run = extendRun(run, piece, start, end, close);
				}
			}
		}
		last = i;
	}
	close();
	sections.push(...offNetworkSections(points, pauses, matched));
	return sections;
}

/** Meters along the recorded track from fix `from` to fix `to`. */
function trackMeters(points, from, to) {
	let meters = 0;
	for (let k = from + 1; k <= to; k++) meters += straightMeters(points[k - 1], points[k]);
	return meters;
}

/**
 * The stretches of the ride on no mapped way, cut into sections along the
 * recorded track. A stretch runs from the last matched fix before it to the
 * first after it, and ends at a pause, a dropout or an estimated fix.
 *
 * @returns {Array<{coords: Array<[number, number]>, meters: number, speed: number|null, offNetwork: true}>}
 */
function offNetworkSections(points, pauses, matched) {
	const stretches = [];
	let current = null;
	// The last matched fix, while the ride hasn't broken off since.
	let anchor = null;
	const finish = () => {
		if (current?.length > 1) stretches.push(current);
		current = null;
	};
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		const previous = points[i - 1];
		const broken =
			point[3] ||
			(previous && (point[2] <= previous[2] || point[2] - previous[2] > MAX_STEP_MS || pauses.some((pause) => pause.start < point[2] && pause.end > previous[2])));
		if (broken) {
			finish();
			anchor = null;
			if (point[3]) continue;
		}
		if (matched[i]) {
			current?.push(point);
			finish();
			anchor = point;
		} else {
			current ??= anchor ? [anchor] : [];
			current.push(point);
		}
	}
	finish();

	const found = [];
	for (const stretch of stretches) {
		const along = [0];
		for (let k = 1; k < stretch.length; k++) along.push(along[k - 1] + straightMeters(stretch[k - 1], stretch[k]));
		const total = along[along.length - 1];
		if (total < Math.max(MIN_OFF_NETWORK_M, MAX_BRIDGE_M)) continue;
		const count = Math.max(1, Math.round(total / SECTION_M));
		const length = total / count;
		for (let s = 0; s < count; s++) {
			const from = s * length;
			const to = (s + 1) * length;
			const at = (distance) => {
				let k = 1;
				while (k < along.length - 1 && along[k] < distance) k++;
				const span = along[k] - along[k - 1];
				const t = span ? (distance - along[k - 1]) / span : 0;
				const a = stretch[k - 1];
				const b = stretch[k];
				return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
			};
			const start = at(from);
			const finish = at(to);
			const coords = [start, ...stretch.filter((_, k) => along[k] > from && along[k] < to), finish].map(([lng, lat]) => [
				Math.round(lng * 1e6) / 1e6,
				Math.round(lat * 1e6) / 1e6,
			]);
			const seconds = (finish[2] - start[2]) / 1000;
			const speed = length >= MIN_TIMED_M && seconds > 0 ? length / seconds : null;
			if (speed !== null && speed > MAX_PLAUSIBLE_MPS) continue;
			found.push({ coords, meters: length, speed, offNetwork: true });
		}
	}
	return found;
}

/**
 * Adds one piece of the way ridden to the current run along a chain, or ends
 * that run and starts another when the piece is on a different chain, picks
 * up somewhere else on it, or turns back.
 *
 * @returns {Object} The run the piece now belongs to.
 */
function extendRun(run, piece, start, end, close) {
	if (run && run.chain === piece.chain && Math.abs(run.at - piece.from) < 1) {
		run.at = piece.to;
		run.min = Math.min(run.min, piece.to);
		run.max = Math.max(run.max, piece.to);
		if (!run.dir && Math.abs(run.at - run.pos[0]) >= DIRECTION_M) run.dir = Math.sign(run.at - run.pos[0]);
		const behind = run.dir > 0 ? run.max - run.at : run.dir < 0 ? run.at - run.min : 0;
		if (behind <= UTURN_M) {
			run.pos.push(piece.to);
			run.time.push(end);
			return run;
		}
	}
	close();
	const next = { chain: piece.chain, dir: 0, pos: [piece.from, piece.to], time: [start, end], at: piece.to };
	next.min = Math.min(piece.from, piece.to);
	next.max = Math.max(piece.from, piece.to);
	if (Math.abs(piece.to - piece.from) >= DIRECTION_M) next.dir = Math.sign(piece.to - piece.from);
	return next;
}

/**
 * The sections of a run's chain that the run covered most of, each timed
 * over the part covered.
 * @returns {Array<{coords: Array<[number, number]>, meters: number, speed: number|null}>}
 */
function coveredSections(net, run) {
	if (!run.dir) return [];
	const chain = net.chains[run.chain];
	const total = chain.along[chain.along.length - 1];
	// Progress: meters along the chain in the direction ridden, held at the
	// furthest reached so far, so noise falling back a little doesn't count.
	let furthest = -Infinity;
	const progress = run.pos.map((pos) => (furthest = Math.max(furthest, run.dir > 0 ? pos : total - pos)));
	const first = progress[0];
	const last = progress[progress.length - 1];

	// The cuts in progress terms, so sections run in the direction ridden.
	const cuts = run.dir > 0 ? chain.cuts : chain.cuts.map((cut) => total - cut).reverse();
	const found = [];
	for (let k = 1; k < cuts.length; k++) {
		const enter = cuts[k - 1];
		const exit = cuts[k];
		const length = exit - enter;
		const from = Math.max(enter, first);
		const to = Math.min(exit, last);
		const partial = to - from < length * MIN_COVERED_SHARE;
		if (partial && to - from < MIN_PARTIAL_M) continue;
		const seconds = (timeLeaving(progress, run.time, to) - timeEntering(progress, run.time, from)) / 1000;
		const speed = to - from >= MIN_TIMED_M && seconds > 0 ? (to - from) / seconds : null;
		if (speed !== null && speed > MAX_PLAUSIBLE_MPS) continue;
		const [start, end] = partial ? [from, to] : [enter, exit];
		const a = run.dir > 0 ? start : total - end;
		const coords = chainSlice(net.graph, chain, a, a + end - start);
		found.push({ coords: run.dir > 0 ? coords : coords.reverse(), meters: end - start, speed, ...(partial && { partial: true }) });
	}
	return found;
}

/**
 * When the run last left `at` behind: the last moment it was at or before
 * it. A rider waiting at a junction before a section starts isn't charged
 * for the wait.
 */
function timeEntering(progress, time, at) {
	let i = progress.length - 1;
	while (i > 0 && progress[i] > at) i--;
	if (i === progress.length - 1) return time[i];
	return interpolate(progress[i], time[i], progress[i + 1], time[i + 1], at);
}

/** When the run first reached `at`. */
function timeLeaving(progress, time, at) {
	let j = 0;
	while (j < progress.length - 1 && progress[j] < at) j++;
	if (j === 0) return time[0];
	return interpolate(progress[j - 1], time[j - 1], progress[j], time[j], at);
}

function interpolate(p1, t1, p2, t2, at) {
	return p2 === p1 ? t2 : t1 + ((t2 - t1) * (at - p1)) / (p2 - p1);
}

/**
 * Joins the graph's road edges into chains, from one junction (or dead end)
 * to the next. Each edge learns its chain, where along the chain its first
 * end lies, and whether it runs a→b along the chain.
 *
 * @param {Object} graph
 * @returns {Object} The chains and per-edge lookups.
 */
function buildChains(graph) {
	const edgeCount = graph.roadEdgeCount;
	const incident = new Map();
	const add = (node, edge) => {
		const list = incident.get(node);
		if (list) list.push(edge);
		else incident.set(node, [edge]);
	};
	for (let e = 0; e < edgeCount; e++) {
		if (graph.edgeDead[e]) continue;
		add(graph.edgeA[e], e);
		add(graph.edgeB[e], e);
	}

	// The edge a chain carries on along past `node`, or -1 where it ends there:
	// where anything but one other way of its rank meets it, ignoring lesser ways.
	const next = (node, edge) => {
		const rank = graph.edgeRank[edge];
		const kin = incident.get(node).filter((other) => graph.edgeRank[other] <= rank);
		if (kin.length !== 2) return -1;
		const other = kin[0] === edge ? kin[1] : kin[0];
		return graph.edgeRank[other] === rank ? other : -1;
	};

	const chainOf = new Int32Array(edgeCount).fill(-1);
	const chainPos = new Float64Array(edgeCount);
	const chainForward = new Uint8Array(edgeCount);
	const chains = [];
	const walk = (startNode, firstEdge) => {
		const id = chains.length;
		const chain = { nodes: [startNode], along: [0] };
		let node = startNode;
		let edge = firstEdge;
		while (edge >= 0 && chainOf[edge] < 0) {
			const forward = graph.edgeA[edge] === node;
			const other = forward ? graph.edgeB[edge] : graph.edgeA[edge];
			const here = chain.along[chain.along.length - 1];
			chainOf[edge] = id;
			chainPos[edge] = here;
			chainForward[edge] = forward ? 1 : 0;
			chain.nodes.push(other);
			chain.along.push(here + Math.hypot(graph.x[other] - graph.x[node], graph.y[other] - graph.y[node]) * graph.metersPerUnit);
			node = other;
			edge = next(node, edge);
		}
		chain.cuts = sectionCuts(graph, chain, (k) => incident.get(chain.nodes[k]).length > 2);
		chains.push(chain);
	};

	for (const [node, list] of incident) {
		for (const edge of list) if (chainOf[edge] < 0 && next(node, edge) < 0) walk(node, edge);
	}
	// What's left are loops with no junction on them at all.
	for (let e = 0; e < edgeCount; e++) if (!graph.edgeDead[e] && chainOf[e] < 0) walk(graph.edgeA[e], e);

	// Every chain each node lies on, and where along it, for finding the way
	// between two fixes. A path or side street usually joins a street partway
	// along the street's chain, so the way on can't wait for a chain's end.
	const members = new Map();
	chains.forEach((chain, id) => {
		chain.nodes.forEach((node, k) => {
			const list = members.get(node);
			if (list) list.push({ id, k });
			else members.set(node, [{ id, k }]);
		});
	});

	// Dead ends, by grid cell: where a tile's copy of a road stops just short of
	// the next tile's, the two are joined by a hop (see `wayBetween`).
	const seamUnits = SEAM_M / graph.metersPerUnit;
	const deadEnds = new Map();
	for (const [node, list] of incident) {
		if (list.length !== 1) continue;
		const key = `${Math.floor(graph.x[node] / seamUnits)}:${Math.floor(graph.y[node] / seamUnits)}`;
		const cell = deadEnds.get(key);
		if (cell) cell.push(node);
		else deadEnds.set(key, [node]);
	}
	const hopsFrom = (node) => {
		if (incident.get(node)?.length !== 1) return [];
		const cx = Math.floor(graph.x[node] / seamUnits);
		const cy = Math.floor(graph.y[node] / seamUnits);
		const hops = [];
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const other of deadEnds.get(`${cx + dx}:${cy + dy}`) ?? []) {
					const meters = Math.hypot(graph.x[other] - graph.x[node], graph.y[other] - graph.y[node]) * graph.metersPerUnit;
					if (other !== node && meters <= SEAM_M) hops.push({ node: other, meters });
				}
			}
		}
		return hops;
	};

	return { graph, chains, chainOf, chainPos, chainForward, members, hopsFrom };
}

/**
 * Where a chain is cut into sections, as distances along it from its first
 * node, starting at 0 and ending at its length. Each cut aims SECTION_M on
 * from the last, but lands on a side junction instead where one is within
 * reach, and no section is left shorter than MIN_SECTION_M. The cuts are
 * worked out from whichever end of the chain lies further west (then
 * south), so they come out the same however the chain was walked.
 *
 * @param {Object} graph
 * @param {{nodes: number[], along: number[]}} chain
 * @param {(k: number) => boolean} isJunction - Whether the chain's k-th node
 *   is where another way meets it.
 * @returns {number[]}
 */
function sectionCuts(graph, chain, isJunction) {
	const { nodes, along } = chain;
	const total = along[along.length - 1];
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	const flip = graph.x[last] < graph.x[first] || (graph.x[last] === graph.x[first] && graph.y[last] > graph.y[first]);
	const at = (distance) => (flip ? total - distance : distance);

	const junctions = [];
	for (let k = 1; k < nodes.length - 1; k++) if (isJunction(k)) junctions.push(at(along[k]));
	junctions.sort((a, b) => a - b);

	const cuts = [0];
	let pos = 0;
	for (;;) {
		const left = total - pos;
		let next = null;
		for (const junction of junctions) {
			if (junction < pos + MIN_SECTION_M || junction > Math.min(pos + MAX_SECTION_M, total - MIN_SECTION_M)) continue;
			if (next === null || Math.abs(junction - pos - SECTION_M) < Math.abs(next - pos - SECTION_M)) next = junction;
		}
		// No junction to cut at: plain cuts, evenly, once what's left is too long for one section.
		if (next === null && left > MAX_SECTION_M) next = pos + left / Math.round(left / SECTION_M);
		if (next === null) break;
		cuts.push(next);
		pos = next;
	}
	cuts.push(total);
	return flip ? cuts.map((cut) => total - cut).reverse() : cuts;
}

/**
 * Matches each fix to a position on a chain: the nearest road or path in
 * reach, but staying on the chain it was already on when that's nearly as
 * near. Estimated fixes (dead reckoning through a GPS dropout) aren't matched.
 *
 * @returns {Array<{chain: number, pos: number}|null>}
 */
function matchPoints(graph, net, points) {
	const roadReach = SNAP_ROAD_M / graph.metersPerUnit;
	const pathReach = SNAP_PATH_M / graph.metersPerUnit;
	const sticky = STICKY_M / graph.metersPerUnit;
	const usable = (edge) => edge < graph.roadEdgeCount && net.chainOf[edge] >= 0;
	const reachOf = (edge) => (graph.edgePath[edge] ? pathReach : roadReach);

	let previous = -1;
	return points.map(([lng, lat, , estimated]) => {
		if (estimated) {
			previous = -1;
			return null;
		}
		const [x, y] = toUnits([lng, lat]);
		const road = graph.nearestEdge(x, y, roadReach, (edge) => usable(edge) && !graph.edgePath[edge]);
		const path = graph.nearestEdge(x, y, pathReach, (edge) => usable(edge) && graph.edgePath[edge]);
		let best = road && path ? (path.distance < road.distance ? path : road) : (road ?? path);
		if (best && previous >= 0 && net.chainOf[best.edge] !== previous) {
			const stay = graph.nearestEdge(x, y, best.distance + sticky, (edge) => usable(edge) && net.chainOf[edge] === previous);
			if (stay && stay.distance <= reachOf(stay.edge)) best = stay;
		}
		if (!best) {
			previous = -1;
			return null;
		}
		const edge = best.edge;
		const a = graph.edgeA[edge];
		const b = graph.edgeB[edge];
		const length = Math.hypot(graph.x[b] - graph.x[a], graph.y[b] - graph.y[a]) * graph.metersPerUnit;
		const pos = net.chainPos[edge] + (net.chainForward[edge] ? best.t : 1 - best.t) * length;
		previous = net.chainOf[edge];
		return { chain: previous, pos };
	});
}

/**
 * The way along the network from one matched fix to the next, as pieces of
 * chains in the order ridden: the shortest way, within a detour limit. A hop
 * across a tile seam is a piece with chain -1, which only takes up time.
 *
 * @param {Object} net
 * @param {{chain: number, pos: number}} from
 * @param {{chain: number, pos: number}} to
 * @param {number} straight - Meters between the two fixes as the crow flies.
 * @returns {Array<{chain: number, from: number, to: number}>|null} Null when
 *   there's no way within the limit (the match jumped somewhere wrong).
 */
function wayBetween(net, from, to, straight) {
	const limit = straight * DETOUR_FACTOR + DETOUR_EXTRA_M;
	if (from.chain === to.chain && Math.abs(to.pos - from.pos) <= limit) {
		return [{ chain: from.chain, from: from.pos, to: to.pos }];
	}

	// Dijkstra over the nodes along the chains; within a few hundred meters
	// there are few of them.
	const cost = new Map();
	const back = new Map();
	const open = [];
	const reach = (node, value, piece, previous) => {
		if (value > limit || value >= (cost.get(node) ?? Infinity)) return;
		cost.set(node, value);
		back.set(node, { piece, previous });
		open.push(node);
	};
	const start = net.chains[from.chain];
	const k = stepAt(start.along, from.pos);
	reach(start.nodes[k], from.pos - start.along[k], { chain: from.chain, from: from.pos, to: start.along[k] }, null);
	reach(start.nodes[k + 1], start.along[k + 1] - from.pos, { chain: from.chain, from: from.pos, to: start.along[k + 1] }, null);

	const goal = net.chains[to.chain];
	const g = stepAt(goal.along, to.pos);
	const finishes = new Map([
		[goal.nodes[g], { extra: to.pos - goal.along[g], piece: { chain: to.chain, from: goal.along[g], to: to.pos } }],
		[goal.nodes[g + 1], { extra: goal.along[g + 1] - to.pos, piece: { chain: to.chain, from: goal.along[g + 1], to: to.pos } }],
	]);
	let best = null;
	while (open.length) {
		let pick = 0;
		for (let n = 1; n < open.length; n++) if (cost.get(open[n]) < cost.get(open[pick])) pick = n;
		const node = open.splice(pick, 1)[0];
		const here = cost.get(node);
		if (best && here >= best.total) break;
		const finish = finishes.get(node);
		if (finish && (!best || here + finish.extra < best.total)) best = { total: here + finish.extra, node, piece: finish.piece };
		for (const { id, k: at } of net.members.get(node) ?? []) {
			const { nodes, along } = net.chains[id];
			for (const next of [at - 1, at + 1]) {
				if (next < 0 || next >= nodes.length) continue;
				reach(nodes[next], here + Math.abs(along[next] - along[at]), { chain: id, from: along[at], to: along[next] }, node);
			}
		}
		for (const hop of net.hopsFrom(node)) reach(hop.node, here + hop.meters, { chain: -1, from: 0, to: hop.meters }, node);
	}
	if (!best || best.total > limit) return null;

	const pieces = [best.piece];
	for (let node = best.node; node !== null; ) {
		const step = back.get(node);
		pieces.push(step.piece);
		node = step.previous;
	}
	return pieces.reverse();
}

/** The index of the step of a chain a distance along it falls on: along[k] <= at <= along[k + 1]. */
function stepAt(along, at) {
	let low = 0;
	let high = along.length - 2;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (along[mid] <= at) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** The part of a chain's line between two distances along it, as [lng, lat] points. */
function chainSlice(graph, chain, from, to) {
	const { nodes, along } = chain;
	const at = (distance) => {
		let k = 1;
		while (k < along.length - 1 && along[k] < distance) k++;
		const span = along[k] - along[k - 1];
		const t = span ? Math.max(0, Math.min(1, (distance - along[k - 1]) / span)) : 0;
		const a = nodes[k - 1];
		const b = nodes[k];
		return [graph.x[a] + (graph.x[b] - graph.x[a]) * t, graph.y[a] + (graph.y[b] - graph.y[a]) * t];
	};
	const units = [at(from)];
	for (let k = 0; k < along.length; k++) {
		if (along[k] > from && along[k] < to) units.push([graph.x[nodes[k]], graph.y[nodes[k]]]);
	}
	units.push(at(to));
	return units.map((point) => toLngLat(point).map((value) => Math.round(value * 1e6) / 1e6));
}

function straightMeters([lngA, latA], [lngB, latB]) {
	const dx = (lngB - lngA) * 111320 * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
	const dy = (latB - latA) * 110574;
	return Math.hypot(dx, dy);
}
