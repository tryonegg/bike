/**
 * The Path Lab screen: pick a saved ride, run it through every path
 * reduction algorithm in path-reduction.js at the same point budget, compare
 * how much each loses, and see the points each one keeps on a map, colored by
 * the speed they carry. Nothing here changes the saved ride.
 */

import { state, el } from "./state.js";
import { getAllSessions, getSessionById } from "./db.js";
import { createVectorMap, isMapStyleReady } from "./live-map.js";
import { navigateToScreen } from "./navigation.js";
import { prepareRide, compareAll } from "./path-reduction.js";
import { formatSpeed, formatDistance, escapeHtml } from "./format.js";
import { speedBand, speedBandColor } from "./colors.js";
import { speedUnitLabel } from "./map-visuals.js";

const FEET_PER_METER = 3.28084;

// Snapping to roads: how much farther than the nearest way a point will stay on
// the road it was already on. How far a point may move to reach a road is the
// lab's Snap distance slider.
const SNAP_STICKY_M = 6;

// What the lab is showing. `geo` is kept apart from the map so the overlay can
// be rebuilt after a style swap, which discards every layer.
const lab = {
	session: null,
	// The last snap of the ride: { sessionId, maxRoad, maxPath, working, snappedShare, meanMove, stats }.
	snap: null,
	ride: null,
	results: [],
	selectedId: "matt-shipped",
	map: null,
	geo: { original: emptyCollection(), route: emptyCollection(), points: emptyCollection() },
	maxSpeed: 1,
};

function emptyCollection() {
	return { type: "FeatureCollection", features: [] };
}

/**
 * Opens the lab, filling the ride picker from the saved rides and loading the
 * most recent one. Creates the map once the screen is visible, since MapLibre
 * measures its container when it is made.
 *
 * @param {"push"|"replace"|string} [mode] - History mode, as `navigateToScreen`.
 * @returns {Promise<void>}
 */
export async function openPathLab(mode = "push") {
	navigateToScreen("pathlab", mode);

	const sessions = (await getAllSessions()).filter((s) => Array.isArray(s.points) && s.points.length > 2);
	sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	const unit = state.prefs.unit;
	el.pathLabRideSelect.innerHTML = sessions
		.map((s) => {
			const when = new Date(s.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
			const label = `${when} · ${formatDistance(s.totalDistance || 0, unit)} ${unit === "imperial" ? "mi" : "km"} · ${s.points.length} pts`;
			return `<option value="${s.id}">${escapeHtml(label)}</option>`;
		})
		.join("");

	if (!sessions.length) {
		el.pathLabStatus.textContent = "No saved rides with enough points to reduce.";
		el.pathLabTable.innerHTML = "";
		return;
	}

	if (lab.map) lab.map.remove();
	lab.map = createVectorMap({ container: "pathLabMap", center: [0, 0], zoom: 2 }, addLabLayers);
	lab.map.on("click", "lab-points", (event) => inspectPoint(event.features?.[0]));
	await loadRide(sessions[0].id);
}

async function loadRide(id) {
	const session = await getSessionById(Number(id));
	if (!session) return;
	lab.session = session;
	lab.snap = null;
	lab.maxSpeed = session.points.reduce((top, p) => Math.max(top, Number.isFinite(p.speed) ? p.speed : 0), 0.0001);
	lab.geo.original = {
		type: "FeatureCollection",
		features: [line(session.points.map((p) => [p.lng, p.lat]), {})],
	};
	el.pathLabReadout.textContent = "Tap a kept point to inspect it.";
	fitToRide(session.points);
	await rebuildRide();
}

/**
 * Prepares the ride for the algorithms, snapping its points to roads first
 * when that box is ticked (once per ride; unticking and re-ticking reuses it).
 */
async function rebuildRide() {
	const session = lab.session;
	if (!session) return;
	let working = null;
	if (el.pathLabSnap.checked) {
		const maxRoad = Number(el.pathLabSnapDistance.value);
		const maxPath = Number(el.pathLabPathSnapDistance.value);
		if (lab.snap?.sessionId !== session.id || lab.snap.maxRoad !== maxRoad || lab.snap.maxPath !== maxPath) {
			el.pathLabStatus.textContent = "Snapping to roads…";
			try {
				lab.snap = { sessionId: session.id, maxRoad, maxPath, ...(await snapRide(session.points, maxRoad, maxPath)) };
			} catch (error) {
				console.warn("Snap to roads failed", error);
				lab.snap = null;
				el.pathLabSnap.checked = false;
				el.pathLabStatus.textContent = "Couldn't snap to roads (map tiles unavailable?). Showing the ride as recorded.";
			}
		}
		working = lab.snap?.working ?? null;
	}
	lab.ride = prepareRide(session.points, session.pauses || [], working);
	recompute();
}

/**
 * Asks the routing worker to snap every point to the road network. Points
 * with no road in reach stay where they were recorded.
 */
function snapRide(points, maxRoad, maxPath) {
	const worker = new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
	return new Promise((resolve, reject) => {
		worker.addEventListener("message", ({ data }) => {
			worker.terminate();
			if (data.error) return reject(new Error(data.error));
			let snappedCount = 0;
			let moved = 0;
			const working = points.map((p, i) => {
				const to = data.snapped[i];
				if (!to) return p;
				snappedCount++;
				moved += data.meters[i];
				return { lat: to[1], lng: to[0] };
			});
			resolve({
				working,
				snappedShare: snappedCount / points.length,
				meanMove: snappedCount ? moved / snappedCount : 0,
				stats: data.stats,
			});
		});
		worker.addEventListener("error", (event) => {
			worker.terminate();
			reject(new Error(event.message || "worker failed"));
		});
		worker.postMessage({
			id: 1,
			type: "snapTrack",
			points: points.map((p) => [p.lng, p.lat]),
			profile: lab.session.activityType === "bike" ? "bike" : "foot",
			maxRoad,
			maxPath,
			sticky: SNAP_STICKY_M,
		});
	});
}

/** Runs every algorithm at the current budget, then redraws the table and map. */
function recompute() {
	if (!lab.ride) return;
	const percent = Number(el.pathLabBudget.value);
	el.pathLabBudgetValue.textContent = `${percent}%`;
	el.pathLabStatus.textContent = "Working…";
	// Let "Working…" paint before the (synchronous) algorithms run.
	setTimeout(() => {
		lab.results = compareAll(lab.ride, percent / 100, { pinPauses: el.pathLabPinPauses.checked });
		if (!lab.results.some((r) => r.id === lab.selectedId)) lab.selectedId = lab.results[0].id;
		const original = lab.results[0].metrics;
		const snap = el.pathLabSnap.checked && lab.snap;
		el.pathLabStatus.textContent =
			`${original.original} points, ${formatBytes(original.originalBytes)} as recorded.` +
			(snap
				? ` Snapped ${(snap.snappedShare * 100).toFixed(0)}% of points to roads (moved ${formatMeters(snap.meanMove)} on average, ${snap.stats.fetched} tiles fetched);` +
					" path errors below are measured against where GPS put you, so they include that move."
				: "");
		renderTable();
		renderSelection();
	}, 20);
}

function renderTable() {
	const unit = state.prefs.unit;
	const columns = [
		["Algorithm", null],
		["Points", (m) => m.kept],
		["Size", (m) => m.bytes],
		["Path off (avg)", (m) => m.posMean],
		["Path off (worst)", (m) => m.posMax],
		["Speed off (avg)", (m) => m.speedMean],
		["Segment speed off", (m) => m.segSpeedMean],
		["Length change", (m) => Math.abs(m.lengthChange)],
		["Top speed kept", (m) => -m.peakKept],
	];
	// The best (lowest) value in each column, for highlighting. Points is left out:
	// every algorithm is aimed at the same count, so it isn't a contest.
	const best = columns.map(([, pick], c) => (pick && c !== 1 ? Math.min(...lab.results.map((r) => pick(r.metrics))) : null));

	const speedText = (mps) => `${formatSpeed(mps, unit)} ${speedUnitLabel(unit)}`;
	const cells = (r) => {
		const m = r.metrics;
		return [
			escapeHtml(r.label),
			m.kept,
			formatBytes(m.bytes),
			formatMeters(m.posMean),
			formatMeters(m.posMax),
			speedText(m.speedMean),
			speedText(m.segSpeedMean),
			`${(m.lengthChange * 100).toFixed(1)}%`,
			`${(m.peakKept * 100).toFixed(0)}%`,
		];
	};

	const head = columns.map(([name]) => `<th>${name}</th>`).join("");
	const rows = lab.results
		.map((r) => {
			const tds = cells(r)
				.map((text, c) => {
					const pick = columns[c][1];
					const isBest = pick && best[c] !== null && pick(r.metrics) === best[c];
					return `<td${isBest ? ' class="best"' : ""}>${text}</td>`;
				})
				.join("");
			return `<tr data-id="${r.id}"${r.id === lab.selectedId ? ' class="selected"' : ""}>${tds}</tr>`;
		})
		.join("");
	el.pathLabTable.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody>`;
}

function renderSelection() {
	const result = lab.results.find((r) => r.id === lab.selectedId);
	if (!result) return;
	el.pathLabTable.querySelectorAll("tbody tr").forEach((row) => row.classList.toggle("selected", row.dataset.id === lab.selectedId));

	const { kept } = result;
	const routeFeatures = [];
	for (let i = 1; i < kept.length; i++) {
		const color = speedBandColor(speedBand(kept[i - 1].segSpeed ?? kept[i - 1].speed, lab.maxSpeed));
		routeFeatures.push(line([[kept[i - 1].lng, kept[i - 1].lat], [kept[i].lng, kept[i].lat]], { color }));
	}
	lab.geo.route = { type: "FeatureCollection", features: routeFeatures };
	lab.geo.points = {
		type: "FeatureCollection",
		features: kept.map((p, k) => ({
			type: "Feature",
			properties: {
				color: speedBandColor(speedBand(p.speed, lab.maxSpeed)),
				k,
			},
			geometry: { type: "Point", coordinates: [p.lng, p.lat] },
		})),
	};
	pushGeo();
}

function line(coordinates, properties) {
	return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}

function addLabLayers(map) {
	const dark = state.prefs.theme === "dark";
	map.addSource("lab-original", { type: "geojson", data: lab.geo.original });
	map.addSource("lab-route", { type: "geojson", data: lab.geo.route });
	map.addSource("lab-points", { type: "geojson", data: lab.geo.points });
	map.addLayer({
		id: "lab-original",
		type: "line",
		source: "lab-original",
		layout: { "line-cap": "round", "line-join": "round" },
		paint: { "line-color": dark ? "#ffffff" : "#333333", "line-width": 2, "line-opacity": 0.55 },
	});
	map.addLayer({
		id: "lab-route",
		type: "line",
		source: "lab-route",
		layout: { "line-cap": "round", "line-join": "round" },
		paint: { "line-color": ["get", "color"], "line-width": 4 },
	});
	map.addLayer({
		id: "lab-points",
		type: "circle",
		source: "lab-points",
		paint: {
			"circle-radius": 4.5,
			"circle-color": ["get", "color"],
			"circle-stroke-color": "#ffffff",
			"circle-stroke-width": 1.5,
		},
	});
	applyLayerToggles();
}

function pushGeo() {
	const map = lab.map;
	if (!isMapStyleReady(map) || !map.getSource("lab-route")) return;
	map.getSource("lab-original").setData(lab.geo.original);
	map.getSource("lab-route").setData(lab.geo.route);
	map.getSource("lab-points").setData(lab.geo.points);
}

function applyLayerToggles() {
	const map = lab.map;
	if (!isMapStyleReady(map) || !map.getLayer("lab-points")) return;
	map.setLayoutProperty("lab-original", "visibility", el.pathLabShowOriginal.checked ? "visible" : "none");
	map.setLayoutProperty("lab-points", "visibility", el.pathLabShowPoints.checked ? "visible" : "none");
}

function fitToRide(points) {
	if (!lab.map || !points.length) return;
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const p of points) {
		west = Math.min(west, p.lng);
		east = Math.max(east, p.lng);
		south = Math.min(south, p.lat);
		north = Math.max(north, p.lat);
	}
	lab.map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 17, duration: 0 });
}

function inspectPoint(feature) {
	const result = lab.results.find((r) => r.id === lab.selectedId);
	const point = result?.kept[feature?.properties?.k];
	if (!point) return;
	const unit = state.prefs.unit;
	const speed = (mps) => `${formatSpeed(mps, unit)} ${speedUnitLabel(unit)}`;
	const when = new Date(point.timestamp).toLocaleTimeString();
	el.pathLabReadout.textContent =
		`Original point ${point.index + 1} of ${lab.ride.n}, ${when}. Saved speed ${speed(point.speed)}` +
		` (its own reading was ${speed(point.rawSpeed)}` +
		(point.segSpeed == null ? ")." : `; the span to the next point averaged ${speed(point.segSpeed)}).`);
}

function showSnapDistance() {
	el.pathLabSnapDistanceValue.textContent = formatMeters(Number(el.pathLabSnapDistance.value));
	el.pathLabPathSnapDistanceValue.textContent = formatMeters(Number(el.pathLabPathSnapDistance.value));
}

function formatMeters(m) {
	if (state.prefs.unit === "imperial") {
		const ft = m * FEET_PER_METER;
		return `${ft.toFixed(ft < 10 ? 1 : 0)} ft`;
	}
	return `${m.toFixed(m < 10 ? 1 : 0)} m`;
}

function formatBytes(bytes) {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** Hooks up the lab's controls. Called once from `wireEvents`. */
export function wirePathLab() {
	el.openPathLabBtn.addEventListener("click", () => openPathLab());
	el.pathLabBackBtn.addEventListener("click", () => history.back());
	el.pathLabRideSelect.addEventListener("change", () => loadRide(el.pathLabRideSelect.value));
	el.pathLabBudget.addEventListener("input", () => {
		el.pathLabBudgetValue.textContent = `${el.pathLabBudget.value}%`;
	});
	el.pathLabBudget.addEventListener("change", recompute);
	el.pathLabPinPauses.addEventListener("change", recompute);
	el.pathLabSnap.addEventListener("change", () => {
		el.pathLabSnapDistance.disabled = el.pathLabPathSnapDistance.disabled = !el.pathLabSnap.checked;
		rebuildRide();
	});
	for (const slider of [el.pathLabSnapDistance, el.pathLabPathSnapDistance]) {
		slider.addEventListener("input", showSnapDistance);
		slider.addEventListener("change", () => {
			if (el.pathLabSnap.checked) rebuildRide();
		});
	}
	showSnapDistance();
	el.pathLabShowOriginal.addEventListener("change", applyLayerToggles);
	el.pathLabShowPoints.addEventListener("change", applyLayerToggles);
	el.pathLabTable.addEventListener("click", (event) => {
		const row = event.target.closest("tbody tr");
		if (!row) return;
		lab.selectedId = row.dataset.id;
		renderSelection();
	});
}
