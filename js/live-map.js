/**
 * The live (in-ride) MapLibre map: creating it, the heading-up follow
 * camera, the route/guide-line sources, topo (hillshade + contour) layers
 * shared with the post-ride map, distance-marker and accuracy-marker
 * rendering, and the guide-line "distance to start" label. `initLiveMap`,
 * `updateLiveMap`/`followLiveMap`/`recenterLiveMap` are this module's main
 * entry points from live-session.js and ride-setup.js.
 */

import {
	LIVE_MAP_PITCH,
	LIVE_CAMERA_EASE_MS,
	HEADING_GPS_MIN_SPEED_MPS,
	HEADING_MIN_MOVE_M,
	LIVE_ROUTE_SOURCE,
	LIVE_GUIDE_SOURCE,
	GUIDE_LABEL_OFFSET_PX,
	GUIDE_LABEL_MIN_LINE_PX,
	WORLD_SIZE_AT_ZOOM_0,
	DEM_TILE_URL,
	DEM_MAX_ZOOM,
	DEM_ATTRIBUTION,
	FEET_PER_METER,
	TOPO_LAYER_IDS,
	TOPO_SOURCE_IDS,
	BEST_PACE_LAYER,
	BEST_PACE_SLOTS,
	CLEAR_LINE_GRADIENT,
} from "./constants.js";
import { state, el } from "./state.js";
import { haversineMeters, bearingDegrees, formatDistance, escapeHtml, formatElevation } from "./format.js";
import { getGuideLineStyle, getMarkerSizeConfig, distanceUnitLabel } from "./map-visuals.js";
import { setPref } from "./db.js";
import { updateBestPace, createBestPaceChip } from "./pace.js";

/**
 * Called on every live GPS fix: extends the route and guide lines, moves the
 * rider marker, works out the new map heading, and hands off to the follow
 * camera and the best-pace overlay.
 *
 * @param {{lat: number, lng: number}} point - The new fix.
 * @param {number} heading - The device/GPS-reported heading, in degrees
 *   (may be non-finite if the device doesn't supply one).
 * @param {number} speedMps - Current speed, in meters/second.
 */
export function updateLiveMap(point, heading, speedMps) {
	if (!state.liveMap) return;

	state.liveRouteCoords.push([point.lng, point.lat]);
	setLiveLineData(LIVE_ROUTE_SOURCE, state.liveRouteCoords);
	animateMarkerTo(state.riderMarker, [point.lng, point.lat]);

	if (state.currentSession?.points?.length) {
		const startPoint = state.currentSession.points[0];
		state.liveGuideCoords = [
			[startPoint.lng, startPoint.lat],
			[point.lng, point.lat],
		];
		setLiveLineData(LIVE_GUIDE_SOURCE, state.liveGuideCoords);
		updateGuideLabel();
	}

	const session = state.currentSession;

	// Until the rider has moved enough to tell, the last heading is held.
	// Resetting to north whipped the map round at every traffic light and back
	// again on moving off. See HEADING_MIN_MOVE_M for how slow riding is handled.
	let nextHeading = session?.currentHeading ?? 0;

	if (session) {
		const anchor = session.headingAnchor;
		if (speedMps >= HEADING_GPS_MIN_SPEED_MPS && Number.isFinite(heading)) {
			nextHeading = heading;
			session.headingAnchor = point;
		} else if (!anchor) {
			session.headingAnchor = point;
		} else if (haversineMeters(anchor.lat, anchor.lng, point.lat, point.lng) >= HEADING_MIN_MOVE_M) {
			nextHeading = bearingDegrees(anchor.lat, anchor.lng, point.lat, point.lng);
			session.headingAnchor = point;
		}
		session.currentHeading = nextHeading;
	}
	followLiveMap(point, nextHeading);
	updateBestPace(point, nextHeading);
}

/**
 * Eases the live map's camera to follow the rider: heading-up bearing,
 * fixed riding pitch/padding, and (while `shouldRecenter` is on) centred on
 * the rider. MapLibre rotates the map itself, so road names are re-laid out
 * upright at every bearing instead of turning with the tiles.
 *
 * A fix that lands mid-gesture (pan/zoom/pinch already in progress) is
 * skipped rather than yanking the map out from under the rider's finger.
 *
 * @param {{lat: number, lng: number}} point
 * @param {number} heading - Degrees.
 */
export function followLiveMap(point, heading) {
	const map = state.liveMap;

	// Easing the camera cancels any gesture in progress, so a fix that lands
	// mid-pan or mid-zoom is skipped rather than yanking the map from the finger.
	if (map.isZooming() || map.dragPan.isActive() || map.touchZoomRotate.isActive()) return;

	// Also reasserted here, not just once in finishRideSetup: the first fix from
	// the real ride watch usually lands while that initial ease is still
	// mid-flight, and an easeTo that omits pitch/padding would otherwise cancel
	// it partway and leave the camera stuck flat.
	const camera = { bearing: heading, pitch: LIVE_MAP_PITCH, padding: ridePadding(map), duration: LIVE_CAMERA_EASE_MS, easing: (t) => t };
	if (state.currentSession?.shouldRecenter) camera.center = [point.lng, point.lat];
	map.easeTo(camera);
}

/**
 * The "Re-center" button's handler: turns following back on and eases the
 * camera back to the rider at their preferred riding zoom, dropping any
 * zoom/pan picked up while looking around. Pitch/padding are reasserted for
 * the same reason as in `followLiveMap` — a tap right as the ride starts
 * could otherwise cancel `finishRideSetup`'s tilt-in partway through.
 */
export function recenterLiveMap() {
	const session = state.currentSession;
	if (!session || !session.lastPoint || !state.liveMap) return;
	session.shouldRecenter = true;
	setLiveZoomAnchor(state.liveMap, true);
	// Back to the rider's picked riding zoom as well as the rider, dropping any
	// zoom from looking around. Pitch/padding are reasserted for the same reason
	// as in followLiveMap: a tap right as the ride starts could otherwise cancel
	// finishRideSetup's tilt-in partway through.
	state.liveMap.easeTo({
		center: [session.lastPoint.lng, session.lastPoint.lat],
		zoom: state.prefs.liveMapZoom,
		bearing: session.currentHeading ?? 0,
		pitch: LIVE_MAP_PITCH,
		padding: ridePadding(state.liveMap),
	});
}

/**
 * Creates (replacing any existing one) the live MapLibre map: base style,
 * route/guide overlays, marker layer, guide label, rider dot, and best-pace
 * chip, plus the gesture handlers that decide whether the camera is
 * following the rider or has been panned away, and that persist the rider's
 * chosen riding zoom.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Object} [options]
 * @param {boolean} [options.overhead] - `true` for the flat, top-down
 *   pre-ride preview (see `beginRideSetup` in ride-setup.js); `false` for the
 *   normal tilted riding camera.
 */
export function initLiveMap(lat, lng, { overhead = false } = {}) {
	if (state.liveMap) {
		state.liveMap.remove();
		state.liveMap = null;
	}

	state.liveRouteCoords = [];
	state.liveGuideCoords = [];

	const map = createVectorMap(
		{
			container: "liveMap",
			center: [lng, lat],
			zoom: state.prefs.liveMapZoom,
			bearing: state.currentSession?.currentHeading ?? 0,
			// The pre-ride preview starts flat and tilts into the riding view once
			// the countdown finishes; see finishRideSetup.
			pitch: overhead ? 0 : LIVE_MAP_PITCH,
		},
		addLiveOverlayLayers,
	);
	state.liveMap = map;
	state.markerLayer = createMarkerLayer(map);
	state.guideLabelMarker = createGuideLabelMarker(map);
	state.riderMarker = createPointMarker(map, "rider-dot", [lng, lat]);
	state.bestPaceChip = createBestPaceChip(map, [lng, lat]);
	state.bestPaceBand = null;
	// Its offset is in pixels, so its ground position depends on the zoom.
	map.on("zoom", updateGuideLabel);

	// Once riding, the rider sits two-thirds of the way down, leaving the larger
	// share of the tilted map for the road ahead — see ridePadding. Before that,
	// while the pre-ride setup bar and panel are the only chrome on screen, the
	// rider instead sits centred in whatever map area they leave uncovered.
	// Padding moves the camera's centre, so the follow camera, rotation,
	// Re-center and rider-anchored zooms all aim wherever it points.
	const placeRider = () => {
		if (state.rideFlowPhase === "setup") {
			map.setPadding({
				top: el.setupTopBar.offsetHeight,
				bottom: el.setupBottomPanel.offsetHeight,
				left: 0,
				right: 0,
			});
		} else {
			map.setPadding(ridePadding(map));
		}
	};
	placeRider();
	map.on("resize", placeRider);
	setLiveZoomAnchor(map, true);

	// A one-finger or mouse drag means the rider wants to look around, so the
	// camera stops following. Zooming, a two-finger pinch included, keeps it
	// following at the new zoom. Only gestures carry an originalEvent; the follow
	// camera's own moves do not.
	map.on("dragstart", (event) => {
		const gesture = event.originalEvent;
		if (!gesture || !state.currentSession) return;
		if (gesture.touches && gesture.touches.length > 1) return;
		state.currentSession.shouldRecenter = false;
		setLiveZoomAnchor(map, false);
	});

	// A zoom made while following is the rider picking their riding zoom, so it
	// is kept for this and future rides. A zoom after panning away is just a look
	// around, and Re-center undoes it.
	let pickingZoom = false;
	map.on("zoomstart", (event) => {
		pickingZoom = Boolean(event.originalEvent && state.currentSession?.shouldRecenter);
	});
	map.on("zoomend", () => {
		if (!pickingZoom) return;
		pickingZoom = false;
		saveLiveMapZoom(map.getZoom());
	});
}

/**
 * Persists the rider's chosen riding zoom as a preference, so the next ride
 * (and the live map's initial zoom) starts there.
 * @param {number} zoom
 */
async function saveLiveMapZoom(zoom) {
	state.prefs.liveMapZoom = zoom;
	await setPref("liveMapZoom", zoom);
}

/**
 * The riding camera's padding: leaves the top third of the map for chrome
 * (or just visual headroom), so the rider sits two-thirds of the way down
 * and the larger share of the tilted map shows the road ahead. See
 * `placeRider` in `initLiveMap` for why, and `finishRideSetup` in
 * ride-setup.js for where the pre-ride preview eases into this.
 *
 * @param {maplibregl.Map} map
 * @returns {{top: number, bottom: number, left: number, right: number}}
 */
export function ridePadding(map) {
	return { top: map.getContainer().clientHeight / 3, bottom: 0, left: 0, right: 0 };
}

/**
 * Sets whether pinch/scroll zooms pivot on the rider (while following) or on
 * the finger/cursor (once the map has been panned away).
 *
 * @param {maplibregl.Map} map
 * @param {boolean} aroundRider
 */
export function setLiveZoomAnchor(map, aroundRider) {
	const options = aroundRider ? { around: "center" } : undefined;
	map.touchZoomRotate.enable(options);
	// The scroll handler ignores enable() while it is already enabled.
	map.scrollZoom.disable();
	map.scrollZoom.enable(options);
}

/**
 * Creates a MapLibre map configured the way both the live and post-ride maps
 * need it: provider/theme base style, rotate/tilt gestures disabled (heading
 * owns the live map's bearing; the ride summary stays north-up), no zoom
 * buttons (both are pinch-to-zoom), topo layers added automatically, a
 * Stadia-key-invalid fallback, and re-adding the map's own overlays whenever
 * its style is swapped out from under it.
 *
 * @param {Object} options - MapLibre `Map` constructor options (container,
 *   center, zoom, bearing, pitch, bounds, etc.) — `style` is filled in here.
 * @param {(map: maplibregl.Map) => void} addOverlays - Called after the base
 *   style (and any topo layers) load, to add the caller's own
 *   sources/layers/markers. Re-invoked after every `setStyle` too, since a
 *   style swap discards everything that isn't part of the new style.
 * @returns {maplibregl.Map}
 */
export function createVectorMap(options, addOverlays) {
	const usesStadia = Boolean(state.prefs.stadiaKey);
	const map = new maplibregl.Map({
		...options,
		style: mapStyleUrl(usesStadia),
		// Heading owns the live map's bearing and the ride summary stays north-up,
		// so rotate and tilt gestures have no job on either map.
		dragRotate: false,
		pitchWithRotate: false,
		touchPitch: false,
		attributionControl: { compact: true },
	});
	// No zoom buttons: both maps are pinch-to-zoom, and the stats strip sits
	// where the buttons would go.
	map.touchZoomRotate.disableRotation();
	state.mapStatus.set(map, { usesStadia, styleReady: false });

	// Fires for the first style and again after every setStyle, which discards
	// the overlays along with the old style.
	map.on("style.load", () => {
		state.mapStatus.get(map).styleReady = true;
		addTopoLayers(map);
		addOverlays(map);
	});
	map.on("error", (event) => handleMapError(map, event));
	return map;
}

/**
 * Whether a map's current style has finished loading (and so it's safe to
 * add/query layers on it).
 *
 * @param {maplibregl.Map|null|undefined} map
 * @returns {boolean}
 */
export function isMapStyleReady(map) {
	return Boolean(map && state.mapStatus.get(map)?.styleReady);
}

/**
 * Resolves the current theme/map-type prefs to a style URL, for either
 * provider. Vector styles only — raster tiles bake their labels in, and
 * those would turn upside down as the live map rotates. Both providers use
 * the OpenMapTiles schema, so the topo layers this module adds slot into
 * either one.
 *
 * @param {boolean} useStadia - `true` for Stadia Maps (requires
 *   `state.prefs.stadiaKey`), `false` for the OpenFreeMap fallback.
 * @returns {string} Style URL.
 */
function mapStyleUrl(useStadia) {
	const dark = state.prefs.theme === "dark";
	const topo = state.prefs.mapType === "topo";

	if (useStadia) {
		const styleName = dark ? "alidade_smooth_dark" : topo ? "outdoors" : "alidade_smooth";
		return `https://tiles.stadiamaps.com/styles/${styleName}.json?api_key=${encodeURIComponent(state.prefs.stadiaKey)}`;
	}

	const styleName = dark ? "dark" : topo ? "liberty" : "positron";
	return `https://tiles.openfreemap.org/styles/${styleName}`;
}

/**
 * Swaps a map's base style (theme, provider, or map-type change).
 *
 * @param {maplibregl.Map} map
 * @param {boolean} useStadia
 */
function setMapStyle(map, useStadia) {
	const status = state.mapStatus.get(map);
	status.usesStadia = useStadia;
	status.styleReady = false;
	// A diffed swap keeps the old style object and never fires style.load, which
	// would silently drop the overlays and topo layers.
	map.setStyle(mapStyleUrl(useStadia), { diff: false });
}

/**
 * Re-applies the current theme/provider/map-type prefs to whichever of the
 * live and post-ride maps currently exist. Called after a theme, map-type,
 * or Stadia-key change.
 */
export function rebuildMapStyles() {
	for (const map of [state.liveMap, state.postMap]) {
		if (map) setMapStyle(map, Boolean(state.prefs.stadiaKey));
	}
}

/**
 * MapLibre `error` handler: logs the error, and — specifically for a Stadia
 * map that fails before its style ever loads (or fails with 401/403) — falls
 * back to the free OpenFreeMap style, so a rejected or mistyped Stadia key
 * doesn't leave the map blank for the whole ride. An offline tile miss after
 * the style has already loaded is not treated as a key problem and is left
 * alone.
 *
 * @param {maplibregl.Map} map
 * @param {{error?: {status?: number}}} event
 */
function handleMapError(map, event) {
	console.warn("Map error", event.error || event);
	const status = state.mapStatus.get(map);
	if (!status.usesStadia) return;

	// A rejected or mistyped Stadia key would otherwise leave the map blank for
	// the whole ride. Offline tile misses are not a key problem, so they stay put.
	const httpStatus = event.error?.status;
	if (!status.styleReady || httpStatus === 401 || httpStatus === 403) {
		setMapStyle(map, false);
	}
}

/**
 * Wraps a list of `[lng, lat]` coordinates as GeoJSON for a MapLibre source.
 *
 * @param {Array<[number, number]>} coords
 * @returns {Object} An empty `FeatureCollection` for fewer than 2 points
 *   (MapLibre can't draw a line from one point), otherwise a `LineString` Feature.
 */
export function lineData(coords) {
	if (coords.length < 2) return { type: "FeatureCollection", features: [] };
	return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
}

/**
 * Updates a live-map line source's data. A no-op until the style is ready —
 * `style.load` (via `addLiveOverlayLayers`) then builds the source fresh
 * from whatever coordinates have accumulated by that point.
 *
 * @param {string} sourceId
 * @param {Array<[number, number]>} coords
 */
export function setLiveLineData(sourceId, coords) {
	state.liveMap?.getSource(sourceId)?.setData(lineData(coords));
}

/**
 * Adds the live map's own overlay sources/layers: the route line, the guide
 * line (with halo), and one pre-allocated line layer per best-pace-band slot.
 * Passed to `createVectorMap` as its `addOverlays` callback, so it also runs
 * again after every style swap.
 *
 * @param {maplibregl.Map} map
 */
function addLiveOverlayLayers(map) {
	const guideStyle = getGuideLineStyle(state.prefs.guideContrast);
	const round = { "line-cap": "round", "line-join": "round" };

	map.addSource(LIVE_ROUTE_SOURCE, { type: "geojson", data: lineData(state.liveRouteCoords) });
	map.addSource(LIVE_GUIDE_SOURCE, { type: "geojson", data: lineData(state.liveGuideCoords) });

	// The best-pace band sits under the road names, like a highlighter on the
	// roads, while the route and guide line stay on top of everything.
	const labelBeforeId = styleLayerAnchors(map).labelBeforeId;
	for (let slot = 0; slot < BEST_PACE_SLOTS; slot++) {
		const id = `${BEST_PACE_LAYER}-${slot}`;
		const path = state.bestPaceBand?.[slot];
		map.addSource(id, { type: "geojson", data: lineData(path?.coords ?? []), lineMetrics: true });
		map.addLayer(
			{
				id,
				type: "line",
				source: id,
				layout: round,
				paint: {
					"line-width": ["interpolate", ["linear"], ["zoom"], 13, 6, 16, 20, 19, 46],
					"line-blur": 1,
					"line-gradient": path?.gradient ?? CLEAR_LINE_GRADIENT,
				},
			},
			labelBeforeId,
		);
	}

	map.addLayer({
		id: "live-route",
		type: "line",
		source: LIVE_ROUTE_SOURCE,
		layout: round,
		paint: { "line-color": "#0b5d3b", "line-width": 5 },
	});
	map.addLayer({
		id: "live-guide-halo",
		type: "line",
		source: LIVE_GUIDE_SOURCE,
		layout: round,
		paint: guideHaloPaint(guideStyle),
	});
	map.addLayer({
		id: "live-guide",
		type: "line",
		source: LIVE_GUIDE_SOURCE,
		layout: round,
		paint: guideLinePaint(guideStyle),
	});
}

/** @param {ReturnType<typeof import("./map-visuals.js").getGuideLineStyle>} guideStyle @returns {Object} MapLibre line-paint properties for the guide line's halo. */
function guideHaloPaint(guideStyle) {
	return linePaint(guideStyle.haloColor, guideStyle.haloWeight, guideStyle.haloOpacity, guideStyle.dashArray);
}

/** @param {ReturnType<typeof import("./map-visuals.js").getGuideLineStyle>} guideStyle @returns {Object} MapLibre line-paint properties for the guide line itself. */
function guideLinePaint(guideStyle) {
	return linePaint(guideStyle.lineColor, guideStyle.lineWeight, guideStyle.lineOpacity, guideStyle.dashArray);
}

/**
 * Builds a MapLibre line-layer `paint` object.
 *
 * @param {string} color
 * @param {number} width
 * @param {number} opacity
 * @param {string} dashArray - Space-separated dash lengths in pixels (as
 *   given by `getGuideLineStyle`); converted here to MapLibre's
 *   line-width-relative units.
 * @returns {Object}
 */
function linePaint(color, width, opacity, dashArray) {
	return {
		"line-color": color,
		"line-width": width,
		"line-opacity": opacity,
		// The guide styles give dashes in pixels; MapLibre measures them in line widths.
		"line-dasharray": dashArray.split(" ").map((px) => Number(px) / width),
	};
}

/**
 * Re-applies a guide-line style to the live map's already-added guide/halo
 * layers in place (as opposed to `addLiveOverlayLayers`, which creates them).
 * A no-op if the style isn't loaded yet — the next `style.load` will add the
 * layers with the current style anyway.
 *
 * @param {ReturnType<typeof import("./map-visuals.js").getGuideLineStyle>} guideStyle
 */
export function applyLiveGuideStyle(guideStyle) {
	const map = state.liveMap;
	if (!isMapStyleReady(map)) return;
	for (const [layerId, paint] of [
		["live-guide-halo", guideHaloPaint(guideStyle)],
		["live-guide", guideLinePaint(guideStyle)],
	]) {
		if (!map.getLayer(layerId)) continue;
		for (const [property, value] of Object.entries(paint)) map.setPaintProperty(layerId, property, value);
	}
}

/**
 * Lazily creates (once, shared by every map) the maplibre-contour DEM source
 * that both the hillshade and the contour lines are derived from. Contours
 * are computed in a worker from the elevation tiles, so topo mode needs no
 * tile server of its own — just this one shared, cached tile source.
 *
 * @returns {Object|undefined} The `mlcontour.DemSource`, or `undefined` if
 *   the `mlcontour` library hasn't loaded.
 */
function getDemSource() {
	if (!state.demSource && typeof mlcontour !== "undefined") {
		state.demSource = new mlcontour.DemSource({
			url: DEM_TILE_URL,
			encoding: "terrarium",
			maxzoom: DEM_MAX_ZOOM,
			worker: true,
		});
		state.demSource.setupMaplibre(maplibregl);
	}
	return state.demSource;
}

/**
 * Finds where in a base style's layer stack the topo relief and label
 * layers should be inserted. Relief goes under roads and buildings so it
 * shades the land without dimming them. Anything labelled or highlighted
 * goes under the road names and place labels, so those stay on top. Some
 * styles put water names first, which is why the first symbol layer alone is
 * not used as a safe anchor for labels.
 *
 * @param {maplibregl.Map} map
 * @returns {{reliefBeforeId: string|undefined, labelBeforeId: string|undefined}} -
 *   Layer ids to pass as the `beforeId` argument to `map.addLayer`.
 */
function styleLayerAnchors(map) {
	const layers = map.getStyle().layers;
	const firstSymbolId = layers.find((layer) => layer.type === "symbol")?.id;
	return {
		reliefBeforeId:
			layers.find((layer) => ["transportation", "building", "aeroway"].includes(layer["source-layer"]))?.id ??
			firstSymbolId,
		labelBeforeId:
			layers.find((layer) => ["transportation_name", "place"].includes(layer["source-layer"]))?.id ?? firstSymbolId,
	};
}

/**
 * Adds the topo-mode hillshade and contour-line/label layers to a map, if
 * "Topo" is the current map-type preference. A no-op (and safe to call
 * unconditionally) when map type is "road", or when the DEM source isn't
 * available yet.
 *
 * @param {maplibregl.Map} map
 */
function addTopoLayers(map) {
	if (state.prefs.mapType !== "topo") return;
	const demSource = getDemSource();
	if (!demSource) return;

	const dark = state.prefs.theme === "dark";
	const imperial = state.prefs.unit === "imperial";
	const layers = map.getStyle().layers;
	const { reliefBeforeId, labelBeforeId } = styleLayerAnchors(map);

	// Contour labels have to use a font the style's glyph server actually has.
	// Styles often lead with an italic for water names, so a regular face wins.
	const styleFonts = layers
		.map((layer) => layer.layout?.["text-font"])
		.filter((font) => Array.isArray(font) && font.every((name) => typeof name === "string"));
	const textFont = styleFonts.find((font) => /regular/i.test(font[0])) ?? styleFonts[0] ?? ["Noto Sans Regular"];

	const contourColor = dark ? "rgba(214, 196, 160, 0.4)" : "rgba(128, 88, 40, 0.5)";
	const contourTextColor = dark ? "#d6c4a0" : "#6b4a22";

	map.addSource("topo-dem", {
		type: "raster-dem",
		encoding: "terrarium",
		tiles: [demSource.sharedDemProtocolUrl],
		tileSize: 256,
		maxzoom: DEM_MAX_ZOOM,
		attribution: DEM_ATTRIBUTION,
	});
	map.addLayer(
		{
			id: "topo-hillshade",
			type: "hillshade",
			source: "topo-dem",
			paint: dark
				? {
					"hillshade-exaggeration": 0.35,
					"hillshade-shadow-color": "rgba(0, 0, 0, 0.6)",
					"hillshade-highlight-color": "rgba(255, 255, 255, 0.2)",
					"hillshade-accent-color": "rgba(0, 0, 0, 0.3)",
				}
				: {
					"hillshade-exaggeration": 0.4,
					"hillshade-shadow-color": "rgba(71, 59, 36, 0.55)",
					"hillshade-highlight-color": "rgba(255, 255, 255, 0.35)",
					"hillshade-accent-color": "rgba(71, 59, 36, 0.25)",
				},
		},
		reliefBeforeId,
	);

	map.addSource("topo-contours", {
		type: "vector",
		tiles: [
			demSource.contourProtocolUrl({
				multiplier: imperial ? FEET_PER_METER : 1,
				// zoom: [minor, major] interval, in the display unit.
				thresholds: imperial
					? { 11: [200, 1000], 12: [100, 500], 14: [50, 200], 15: [20, 100] }
					: { 11: [50, 250], 12: [25, 100], 14: [10, 50], 15: [5, 25] },
				contourLayer: "contours",
				elevationKey: "ele",
				levelKey: "level",
			}),
		],
		maxzoom: 15,
	});
	map.addLayer(
		{
			id: "topo-contour-lines",
			type: "line",
			source: "topo-contours",
			"source-layer": "contours",
			paint: {
				"line-color": contourColor,
				// level is 1 for major lines and 0 for minor ones.
				"line-width": ["match", ["get", "level"], 1, 1.1, 0.5],
			},
		},
		reliefBeforeId,
	);
	map.addLayer(
		{
			id: "topo-contour-labels",
			type: "symbol",
			source: "topo-contours",
			"source-layer": "contours",
			filter: [">", ["get", "level"], 0],
			layout: {
				"symbol-placement": "line",
				"text-size": 10,
				"text-field": ["concat", ["number-format", ["get", "ele"], {}], imperial ? " ft" : " m"],
				"text-font": textFont,
			},
			paint: {
				"text-color": contourTextColor,
				"text-halo-color": dark ? "rgba(0, 0, 0, 0.75)" : "rgba(255, 255, 255, 0.85)",
				"text-halo-width": 1,
			},
		},
		labelBeforeId,
	);
}

/**
 * Rebuilds the topo layers on both maps in place, without reloading the
 * whole base style. Needed because contour intervals and labels are drawn in
 * the display unit, so a unit change has to redraw them.
 */
export function refreshTopoLayers() {
	for (const map of [state.liveMap, state.postMap]) {
		if (!isMapStyleReady(map)) continue;
		for (const layerId of TOPO_LAYER_IDS) {
			if (map.getLayer(layerId)) map.removeLayer(layerId);
		}
		for (const sourceId of TOPO_SOURCE_IDS) {
			if (map.getSource(sourceId)) map.removeSource(sourceId);
		}
		// Topo layers go under everything else, so re-adding them after the
		// overlays still leaves the route on top.
		addTopoLayers(map);
	}
}

/**
 * Creates a small helper for managing a set of DOM-element markers (distance
 * flags) on a map as a group — add them one at a time, then clear them all
 * at once. MapLibre markers sit in screen space, so they stay upright as the
 * live map rotates underneath them.
 *
 * @param {maplibregl.Map} map
 * @returns {{add: (lat: number, lng: number, element: HTMLElement) => void,
 *   clearLayers: () => void}}
 */
export function createMarkerLayer(map) {
	let markers = [];
	return {
		add(lat, lng, element) {
			markers.push(new maplibregl.Marker({ element }).setLngLat([lng, lat]).addTo(map));
		},
		clearLayers() {
			for (const marker of markers) marker.remove();
			markers = [];
		},
	};
}

/**
 * Creates a simple styled-dot marker pinned to one spot — used for the
 * rider dot and the post-ride route's start/finish markers.
 *
 * @param {maplibregl.Map} map
 * @param {string} className - CSS class identifying which dot style to use.
 * @param {[number, number]} lngLat
 * @returns {maplibregl.Marker}
 */
export function createPointMarker(map, className, lngLat) {
	const element = document.createElement("div");
	element.className = className;
	return new maplibregl.Marker({ element }).setLngLat(lngLat).addTo(map);
}

/**
 * Debug GPS-accuracy overlay: flags the single best (lowest-error) and
 * worst (highest-error) fixes on the route, so a kink in the line has an
 * obvious point to go inspect.
 *
 * @param {maplibregl.Map} map
 * @param {Array<{lat: number, lng: number, accuracy: number}>} points
 * @param {number} [clipIndex] - Points before this index (the warm-up, when
 *   "clip GPS warm-up" is on) are excluded, so the opening fix doesn't just
 *   always win "worst" for being first.
 */
export function addAccuracyExtremeMarkers(map, points, clipIndex = 0) {
	const known = points.filter((p, i) => i >= clipIndex && Number.isFinite(p.accuracy));
	if (known.length < 2) return;

	let best = known[0];
	let worst = known[0];
	for (const point of known) {
		if (point.accuracy < best.accuracy) best = point;
		if (point.accuracy > worst.accuracy) worst = point;
	}
	// Every fix carried the same accuracy: nothing to single out as best/worst.
	if (best.accuracy === worst.accuracy) return;

	createAccuracyMarker(map, "best", best);
	createAccuracyMarker(map, "worst", worst);
}

/**
 * Creates one "Best"/"Worst" accuracy-callout marker for the debug overlay.
 *
 * @param {maplibregl.Map} map
 * @param {"best"|"worst"} kind
 * @param {{lng: number, lat: number, accuracy: number}} point
 * @returns {maplibregl.Marker}
 */
function createAccuracyMarker(map, kind, point) {
	const element = document.createElement("div");
	element.className = `accuracy-marker accuracy-marker-${kind}`;
	const label = kind === "best" ? "Best" : "Worst";
	element.innerHTML = `<span>${label} ${escapeHtml(formatElevation(point.accuracy, state.prefs.unit))}</span>`;
	return new maplibregl.Marker({ element }).setLngLat([point.lng, point.lat]).addTo(map);
}

/**
 * Glides a marker to a new position over `durationMs` instead of snapping
 * there, which read as a jump every time a fix landed. Restarts easing from
 * wherever the marker currently sits (rather than its last target), so a run
 * of fast-arriving fixes stays smooth instead of stacking up queued jumps.
 *
 * @param {maplibregl.Marker|null|undefined} marker - No-op if falsy (some
 *   callers pass a marker that may not exist yet).
 * @param {[number, number]} lngLat - Target position.
 * @param {number} [durationMs]
 */
export function animateMarkerTo(marker, lngLat, durationMs = LIVE_CAMERA_EASE_MS) {
	if (!marker) return;

	const from = marker.getLngLat();
	const toLng = lngLat[0];
	const toLat = lngLat[1];
	if (marker._moveFrame) cancelAnimationFrame(marker._moveFrame);

	const start = performance.now();
	const step = (now) => {
		const t = Math.min(1, (now - start) / durationMs);
		const eased = 1 - (1 - t) * (1 - t);
		marker.setLngLat([from.lng + (toLng - from.lng) * eased, from.lat + (toLat - from.lat) * eased]);
		marker._moveFrame = t < 1 ? requestAnimationFrame(step) : null;
	};
	marker._moveFrame = requestAnimationFrame(step);
}

/**
 * Creates the "distance to start" chip marker on the guide line, hidden
 * until `updateGuideLabel` first has something to show. It takes the guide
 * line's colors so the two read as one, and the current distance-marker size.
 *
 * @param {maplibregl.Map} map
 * @returns {maplibregl.Marker}
 */
function createGuideLabelMarker(map) {
	const element = document.createElement("div");
	element.className = "guide-distance-label";
	element.append(document.createElement("span"));
	element.style.visibility = "hidden";
	styleGuideLabel(element, state.prefs.guideContrast, state.prefs.markerSize);
	return new maplibregl.Marker({ element }).setLngLat([0, 0]).addTo(map);
}

/**
 * Applies the guide line's colors and the current marker-size class to the
 * guide-label chip's element.
 *
 * @param {HTMLElement} element
 * @param {"low"|"medium"|"high"} guideContrast
 * @param {"small"|"medium"|"large"} markerSize
 */
export function styleGuideLabel(element, guideContrast, markerSize) {
	const guideStyle = getGuideLineStyle(guideContrast);
	element.style.setProperty("--guide-label-bg", guideStyle.haloColor);
	element.style.setProperty("--guide-label-fg", guideStyle.lineColor);
	// classList, not className: MapLibre keeps its own marker classes on it.
	element.classList.remove("small", "medium", "large");
	element.classList.add(getMarkerSizeConfig(markerSize).className);
}

/**
 * Repositions and re-labels the "distance to start" chip along the guide
 * line, or hides it when there's nothing useful to show. Placed a fixed
 * pixel distance from the rider rather than at the line's midpoint (which
 * would be off the map on a long ride), worked out along the line in
 * Mercator space — where the guide line is drawn straight — because a start
 * far behind the tilted camera can't be reliably projected to screen space.
 * Called on every live fix and on every map zoom (the pixel offset's ground
 * distance depends on zoom).
 */
export function updateGuideLabel() {
	const map = state.liveMap;
	const marker = state.guideLabelMarker;
	if (!map || !marker) return;
	const element = marker.getElement();

	if (state.liveGuideCoords.length < 2) {
		element.style.visibility = "hidden";
		return;
	}

	const [origin, rider] = state.liveGuideCoords;
	const from = maplibregl.MercatorCoordinate.fromLngLat(rider);
	const to = maplibregl.MercatorCoordinate.fromLngLat(origin);
	const linePixels = Math.hypot(to.x - from.x, to.y - from.y) * WORLD_SIZE_AT_ZOOM_0 * 2 ** map.getZoom();

	// Too short to hold the chip without covering the rider and the start.
	if (linePixels < GUIDE_LABEL_MIN_LINE_PX) {
		element.style.visibility = "hidden";
		return;
	}

	const fraction = Math.min(GUIDE_LABEL_OFFSET_PX / linePixels, 0.5);
	const at = new maplibregl.MercatorCoordinate(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction);
	marker.setLngLat(at.toLngLat());

	const meters = haversineMeters(rider[1], rider[0], origin[1], origin[0]);
	element.firstChild.textContent = `${formatDistance(meters, state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)} to start`;
	element.style.visibility = "visible";
}
