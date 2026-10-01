/**
 * The Map style picker on the settings screen. Each option is a small live
 * map of the same place in the riding view — heading-up and tilted like the
 * ride screen — circling a loop as if a ride were under way, so the styles
 * can be compared by how they look rather than by name.
 *
 * The place is a fixed default until the device gives a GPS fix, then the
 * rider's own surroundings. The maps only exist while the settings screen is
 * showing: seven WebGL contexts and a render loop are too much to keep around.
 */

import { LIVE_MAP_PITCH, MAP_STYLE_NAMES } from "./constants.js";
import { state, el } from "./state.js";
import { mapStyleUrl, addTopoLayers, mapTypeNeedsStadiaKey, createPointMarker, lineData, styleGuideLabel, planLineStyle, rideLineStyle, addBuildings3d } from "./live-map.js";
import { getGuideLineStyle, distanceUnitLabel } from "./map-visuals.js";
import { haversineMeters, formatDistance } from "./format.js";

const MAP_TYPES = [
	["road", "Road"],
	["topo", "Topo"],
	["bright", "Bright"],
	["fiord", "Fiord"],
	["classic", "Classic"],
	["toner", "Toner"],
	["terrain", "Terrain"],
];

// Boulder, Colorado: a street grid beside foothills, so Topo has relief to show.
const DEFAULT_CENTER = { lat: 40.015, lng: -105.2705 };
// Wider than the ride screen's zoom: the cards are small, and the start and
// destination have to fit in them.
const PREVIEW_ZOOM = 14.9;
// A loop, so the preview never drifts away from tiles it has already loaded.
const LOOP_RADIUS_M = 190;
const LOOP_SPEED_MPS = 12;
const FRAME_MS = 50;
const METERS_PER_DEG_LAT = 111320;
const TRAIL_SOURCE = "preview-trail";
const GUIDE_SOURCE = "preview-guide";
const ROUTE_SOURCE = "preview-route";
// The destination sits off the loop, so the route to it is always a real trip.
const DESTINATION_OFFSET_M = { north: 130, east: 110 };
const FLAG_SVG =
	'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/></svg>';

let center = { ...DEFAULT_CENTER };
let gotFix = false;
let cards = null;
let previews = [];
let frameId = 0;
let lastFrame = 0;
let started = 0;
let onSelect = null;
let previewsUseStadia = false;

/**
 * Builds the picker and wires its taps. Call once at startup.
 *
 * @param {(mapType: string) => void} select - Saves the chosen map style.
 */
export function wireMapPreviews(select) {
	onSelect = select;
	cards = new Map();
	for (const [type, label] of MAP_TYPES) {
		const card = document.createElement("button");
		card.type = "button";
		card.className = "map-style-card";
		card.dataset.mapType = type;
		card.setAttribute("role", "radio");
		card.innerHTML =
			'<span class="map-style-view"></span>' +
			`<span class="map-style-name">${label}</span>` +
			'<span class="map-style-lock">Needs Stadia key</span>';
		card.addEventListener("click", () => {
			if (card.getAttribute("aria-disabled") === "true") return;
			onSelect(type);
		});
		el.mapStyleGrid.append(card);
		cards.set(type, card);
	}
	syncMapPreviewSelection();
}

/** Marks the chosen card, and greys out the styles that need a Stadia key. */
export function syncMapPreviewSelection() {
	if (!cards) return;
	const locked = !state.prefs.stadiaKey;
	for (const [type, card] of cards) {
		const needsKey = locked && mapTypeNeedsStadiaKey(type);
		card.setAttribute("aria-checked", String(type === state.prefs.mapType));
		card.setAttribute("aria-disabled", String(needsKey));
		card.classList.toggle("selected", type === state.prefs.mapType);
		card.classList.toggle("locked", needsKey);
	}
	// A key being saved or cleared changes which cards have a map to show.
	if (previews.length && previewsUseStadia !== Boolean(state.prefs.stadiaKey)) restartMapPreviews();
}

/** Starts the previews, if they aren't running. Called when settings opens. */
export function startMapPreviews() {
	if (!cards || previews.length || typeof maplibregl === "undefined") return;
	const useStadia = Boolean(state.prefs.stadiaKey);
	previewsUseStadia = useStadia;
	for (const [type, card] of cards) {
		if (!useStadia && MAP_STYLE_NAMES[type]?.free === null) continue;
		previews.push(createPreview(type, card.querySelector(".map-style-view"), useStadia));
	}
	started = performance.now();
	lastFrame = 0;
	frameId = requestAnimationFrame(tick);
	if (!gotFix) requestFix();
}

/** Tears the previews down. Called when settings closes. */
export function stopMapPreviews() {
	cancelAnimationFrame(frameId);
	frameId = 0;
	for (const preview of previews) preview.map.remove();
	previews = [];
}

/** Rebuilds the previews, after a theme or key change alters every style. */
export function restartMapPreviews() {
	if (!previews.length) return;
	stopMapPreviews();
	startMapPreviews();
}

/** One GPS fix replaces the default place, if the device will give one. */
function requestFix() {
	if (!navigator.geolocation) return;
	navigator.geolocation.getCurrentPosition(
		(position) => {
			gotFix = true;
			center = { lat: position.coords.latitude, lng: position.coords.longitude };
			// The trail is part of each style, so a new place means new previews.
			restartMapPreviews();
		},
		() => {},
		{ enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 10000 },
	);
}

function createPreview(type, container, useStadia) {
	const map = new maplibregl.Map({
		container,
		style: mapStyleUrl(useStadia, type),
		center: [center.lng, center.lat],
		zoom: PREVIEW_ZOOM,
		pitch: LIVE_MAP_PITCH,
		interactive: false,
		attributionControl: false,
		fadeDuration: 0,
	});
	const marker = createPointMarker(map, "rider-dot", [center.lng, center.lat]);
	const start = loopPosition(0);
	const startMarker = createPointMarker(map, "preview-start", [start.lng, start.lat]);
	startMarker.getElement().innerHTML = FLAG_SVG;
	const destination = destinationPosition();
	const pinElement = document.createElement("div");
	pinElement.className = "destination-pin";
	pinElement.innerHTML = `<span class="destination-pin-drop">${FLAG_SVG}</span>`;
	pinElement.style.pointerEvents = "none";
	// A pin's point is its bottom, not its middle.
	new maplibregl.Marker({ element: pinElement, anchor: "bottom" }).setLngLat([destination.lng, destination.lat]).addTo(map);

	const chipElement = document.createElement("div");
	chipElement.className = "guide-distance-label small";
	chipElement.append(document.createElement("span"));
	styleGuideLabel(chipElement, state.prefs.guideContrast, "small", type);
	const chip = new maplibregl.Marker({ element: chipElement }).setLngLat([center.lng, center.lat]).addTo(map);

	map.on("style.load", () => {
		addTopoLayers(map, type);
		if (state.prefs.buildings3d) addBuildings3d(map, type);
		const round = { "line-cap": "round", "line-join": "round" };
		const plan = planLineStyle(type);
		map.addSource(ROUTE_SOURCE, { type: "geojson", data: lineData([]) });
		map.addLayer({ id: `${ROUTE_SOURCE}-casing`, type: "line", source: ROUTE_SOURCE, layout: round, paint: { "line-color": "#ffffff", "line-width": plan.casingWidth - 2, "line-opacity": plan.opacity } });
		map.addLayer({ id: ROUTE_SOURCE, type: "line", source: ROUTE_SOURCE, layout: round, paint: { "line-color": plan.color, "line-width": plan.width - 1.5, "line-opacity": plan.opacity } });
		const guideStyle = getGuideLineStyle(state.prefs.guideContrast, type);
		const dash = guideStyle.dashArray.split(" ").map((px) => Number(px) / guideStyle.lineWeight);
		map.addSource(GUIDE_SOURCE, { type: "geojson", data: lineData([]) });
		map.addLayer({ id: `${GUIDE_SOURCE}-halo`, type: "line", source: GUIDE_SOURCE, layout: round, paint: { "line-color": guideStyle.haloColor, "line-width": guideStyle.haloWeight, "line-opacity": guideStyle.haloOpacity, "line-dasharray": dash } });
		map.addLayer({ id: GUIDE_SOURCE, type: "line", source: GUIDE_SOURCE, layout: round, paint: { "line-color": guideStyle.lineColor, "line-width": guideStyle.lineWeight, "line-opacity": guideStyle.lineOpacity, "line-dasharray": dash } });
		map.addSource(TRAIL_SOURCE, { type: "geojson", data: lineData(loopCoords()) });
		const ride = rideLineStyle(type);
		const trail = { type: "line", source: TRAIL_SOURCE, layout: { "line-cap": "round", "line-join": "round" } };
		if (ride.casingWidth) {
			map.addLayer({ ...trail, id: `${TRAIL_SOURCE}-casing`, paint: { "line-color": "#ffffff", "line-width": ride.casingWidth - 1 } });
		}
		map.addLayer({ ...trail, id: TRAIL_SOURCE, paint: { "line-color": ride.color, "line-width": 4, "line-opacity": 0.85 } });
	});
	return { map, marker, chip };
}

/** Where a rider on the loop is, `meters` along it, and which way they face. */
function loopPosition(meters) {
	const angle = meters / LOOP_RADIUS_M;
	const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
	// The loop's middle is the centre, so the rider starts at its south edge.
	return {
		lat: center.lat + (-Math.cos(angle) * LOOP_RADIUS_M) / METERS_PER_DEG_LAT,
		lng: center.lng + (Math.sin(angle) * LOOP_RADIUS_M) / metersPerDegLng,
		heading: ((angle * 180) / Math.PI) % 360,
	};
}

function destinationPosition() {
	const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
	return {
		lat: center.lat + DESTINATION_OFFSET_M.north / METERS_PER_DEG_LAT,
		lng: center.lng + DESTINATION_OFFSET_M.east / metersPerDegLng,
	};
}

function loopCoords() {
	const coords = [];
	for (let i = 0; i <= 72; i++) {
		const { lat, lng } = loopPosition((i / 72) * 2 * Math.PI * LOOP_RADIUS_M);
		coords.push([lng, lat]);
	}
	return coords;
}

function tick(now) {
	frameId = requestAnimationFrame(tick);
	if (now - lastFrame < FRAME_MS || document.hidden) return;
	lastFrame = now;
	const { lat, lng, heading } = loopPosition(((now - started) / 1000) * LOOP_SPEED_MPS);
	const start = loopPosition(0);
	const destination = destinationPosition();
	const toStart = [[lng, lat], [start.lng, start.lat]];
	// Streets run in a grid, so the route to the destination turns a corner.
	const toDestination = [[lng, lat], [destination.lng, lat], [destination.lng, destination.lat]];
	const unit = state.prefs.unit;
	const chipText = `${formatDistance(haversineMeters(lat, lng, start.lat, start.lng), unit)} ${distanceUnitLabel(unit)}`;
	for (const { map, marker, chip } of previews) {
		const height = map.getContainer().clientHeight;
		map.jumpTo({ center: [lng, lat], bearing: heading, padding: { top: height / 3, bottom: 0, left: 0, right: 0 } });
		marker.setLngLat([lng, lat]);
		chip.setLngLat([(lng + start.lng) / 2, (lat + start.lat) / 2]);
		chip.getElement().firstChild.textContent = chipText;
		map.getSource(GUIDE_SOURCE)?.setData(lineData(toStart));
		map.getSource(ROUTE_SOURCE)?.setData(lineData(toDestination));
	}
}
