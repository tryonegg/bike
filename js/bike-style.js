/**
 * The "Bike" map style: Topo (OpenFreeMap's Liberty plus relief and
 * contours, see addTopoLayers in live-map.js) redrawn for riding. Nothing
 * here is its own style file: the stock style loads as usual and its layers
 * are repainted and added to once it has, so it keeps using the tiles, fonts
 * and icons the app already caches and saves for offline areas.
 *
 * What a line's look means:
 *   black            a road
 *   grey             a road bikes are kept off, or that is no place to ride
 *                    (motorways, trunk highways, no-bike, private)
 *   brown            unpaved (as a road's color, a path's dashes, or the
 *                    casing of a bike path)
 *   solid green      a car-free bike path
 *   green dashes     a street signed for bikes, drawn along the black road
 *   dark dashes      a path or trail with nothing said about bikes
 *   pale dashes      a footpath; tight ticks are steps
 *
 * It also turns the one-way arrows white, and swaps the general
 * points of interest for the ones a rider stops at.
 */

import { state } from "./state.js";
import { addFarBikePathLayers } from "./bike-far-paths.js";

const ROAD_COLOR = "#333333";
const TUNNEL_COLOR = "#5a5a5a";
const NO_BIKES_COLOR = "#a9a9a9";
const UNPAVED_COLOR = "#8a5a2b";
const BIKE_COLOR = "#00b34a";
const PATH_COLOR = "#4a4a4a";
const FOOT_COLOR = "#b3b3b3";
const STEPS_COLOR = "#6b6b6b";

const ARROW_IMAGE = "bike-oneway-arrow";

// The tile properties these expressions read are OpenMapTiles' own.
const get = (key) => ["get", key];
const oneOf = (key, values) => ["match", get(key), values, true, false];
const IS_PATH = ["==", get("class"), "path"];
const BIKES_WELCOME = oneOf("bicycle", ["yes", "designated", "permissive"]);
const UNPAVED = ["==", get("surface"), "unpaved"];
// A path kept for bikes: a cycleway, or any path signed for them.
const BIKE_PATH = ["all", IS_PATH, ["any", ["==", get("subclass"), "cycleway"], ["==", get("bicycle"), "designated"]]];
// A street with traffic that is signed for bikes: a lane, or a marked route.
const BIKE_STREET = ["all", ["!", IS_PATH], ["!=", get("class"), "motorway"], ["==", get("bicycle"), "designated"]];
// Trunk roads count as well: bikes are often legal on them, but in practice
// they are multilane highways, and no one's idea of a road to ride. One
// tagged as open to bikes stays black.
const NO_BIKES = [
	"all",
	["!", BIKES_WELCOME],
	["any", oneOf("class", ["motorway", "trunk"]), oneOf("bicycle", ["no", "use_sidepath"]), oneOf("access", ["no", "private"])],
];
const FOOT_ONLY = [
	"all",
	["!", BIKES_WELCOME],
	["any", oneOf("subclass", ["footway", "steps", "platform", "corridor"]), oneOf("bicycle", ["no", "dismount"])],
];
const LINES_ONLY = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];

// The stops shown from far out, and the food stops that join them closer in.
const STOP_CLASSES = ["bicycle", "bicycle_rental", "drinking_water", "toilets"];
const FOOD_CLASSES = ["cafe", "bakery", "grocery"];

/**
 * Turns the Liberty base style into the Bike style, if "Bike" is the map
 * type. A no-op for every other map type, and safe to call again on a style
 * that has already been converted. Called after every style load, since a
 * style swap throws all of this away.
 *
 * @param {maplibregl.Map} map
 * @param {string} [mapType] - Defaults to the saved map style.
 */
export function applyBikeStyle(map, mapType = state.prefs.mapType) {
	if (mapType !== "bike" || map.getLayer("bike-routes")) return;
	const layers = map.getStyle().layers;
	const roads = layers.filter(
		(layer) => layer.type === "line" && layer["source-layer"] === "transportation" && !/rail|transit/.test(layer.id),
	);
	if (!roads.length) return;
	const source = roads[0].source;
	// Under the road names and place labels, over everything drawn on the ground.
	const labelBeforeId = layers.find((layer) => ["transportation_name", "place"].includes(layer["source-layer"]))?.id;

	repaintRoads(map, roads);
	repaintRoadNames(map, layers);
	addBikeWays(map, source, labelBeforeId);
	// The tiles hold no paths further out than zoom 13; these are fetched apart.
	addFarBikePathLayers(map, labelBeforeId);
	whitenOneWayArrows(map, layers);
	addRiderStops(map, layers, source);
}

/**
 * Roads go black on a white casing, grey where bikes are kept off, brown
 * where unpaved; paths keep their dashes and are colored by who they are for.
 */
function repaintRoads(map, roads) {
	const roadColor = ["case", NO_BIKES, NO_BIKES_COLOR, UNPAVED, UNPAVED_COLOR, ROAD_COLOR];
	const pathColor = ["case", FOOT_ONLY, FOOT_COLOR, UNPAVED, UNPAVED_COLOR, PATH_COLOR];
	for (const layer of roads) {
		const tunnel = layer.id.startsWith("tunnel");
		if (layer.id.includes("casing")) {
			map.setPaintProperty(layer.id, "line-color", tunnel ? "#bdbdbd" : "#ffffff");
		} else if (layer.id.includes("path")) {
			map.setPaintProperty(layer.id, "line-color", pathColor);
			map.setPaintProperty(layer.id, "line-width", ["interpolate", ["exponential", 1.2], ["zoom"], 13, 1.2, 14, 1.6, 20, 10]);
			// The stock style holds trails back until zoom 14, too late to plan around them.
			if (!tunnel) map.setLayerZoomRange(layer.id, 13, 24);
		} else {
			map.setPaintProperty(layer.id, "line-color", tunnel ? TUNNEL_COLOR : roadColor);
		}
	}
}

/**
 * The style's grey street names sit on the road line itself, where they
 * vanish into black. White on a solid black halo reads on the road, on the
 * dashes of a path, and on the ground where a name overhangs a narrow road.
 */
function repaintRoadNames(map, layers) {
	for (const layer of layers) {
		if (layer.type !== "symbol" || layer["source-layer"] !== "transportation_name" || !layer.id.startsWith("highway-name")) continue;
		map.setPaintProperty(layer.id, "text-color", "#ffffff");
		map.setPaintProperty(layer.id, "text-halo-color", ROAD_COLOR);
		map.setPaintProperty(layer.id, "text-halo-width", 2);
		map.setPaintProperty(layer.id, "text-halo-blur", 0);
	}
}

/**
 * Draws the bike network over the roads: solid green for car-free bike
 * paths, green dashes along the streets signed for bikes, and ticks for
 * steps so they aren't taken for a path.
 */
function addBikeWays(map, source, beforeId) {
	const width = (scale) => ["interpolate", ["exponential", 1.2], ["zoom"], 10, 1 * scale, 14, 2.5 * scale, 20, 9 * scale];
	const way = { type: "line", source, "source-layer": "transportation" };
	const round = { "line-cap": "round", "line-join": "round" };

	map.addLayer(
		{
			...way,
			id: "bike-steps",
			minzoom: 15,
			filter: ["all", LINES_ONLY, ["==", get("subclass"), "steps"]],
			paint: { "line-color": STEPS_COLOR, "line-width": width(1.3), "line-dasharray": [0.25, 0.25] },
		},
		beforeId,
	);
	map.addLayer(
		{
			...way,
			id: "bike-streets",
			filter: ["all", LINES_ONLY, BIKE_STREET],
			layout: { "line-join": "round" },
			// Narrower than the road, so its black still shows down both sides.
			paint: { "line-color": BIKE_COLOR, "line-width": width(0.8), "line-dasharray": [2.5, 2] },
		},
		beforeId,
	);
	map.addLayer(
		{
			...way,
			id: "bike-routes-casing",
			filter: ["all", LINES_ONLY, BIKE_PATH],
			layout: round,
			paint: { "line-color": ["case", UNPAVED, UNPAVED_COLOR, "#ffffff"], "line-width": width(1.9) },
		},
		beforeId,
	);
	map.addLayer(
		{ ...way, id: "bike-routes", filter: ["all", LINES_ONLY, BIKE_PATH], layout: round, paint: { "line-color": BIKE_COLOR, "line-width": width(2) } },
		beforeId,
	);
}

/**
 * The style's one-way arrows are a grey image, lost on a black road and not
 * one that can be tinted, so a white one is drawn and swapped in.
 */
function whitenOneWayArrows(map, layers) {
	if (!map.hasImage(ARROW_IMAGE)) {
		// Drawn at twice its size, for sharp edges on dense screens.
		const [width, height] = [16, 12];
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		context.strokeStyle = "#ffffff";
		context.lineWidth = 2.5;
		context.lineCap = "round";
		context.lineJoin = "round";
		// Points along the line's direction, as the style's own arrow does.
		context.beginPath();
		context.moveTo(2, height / 2);
		context.lineTo(width - 2, height / 2);
		context.moveTo(width - 6.5, 2);
		context.lineTo(width - 2, height / 2);
		context.lineTo(width - 6.5, height - 2);
		context.stroke();
		map.addImage(ARROW_IMAGE, context.getImageData(0, 0, width, height), { pixelRatio: 2 });
	}
	for (const layer of layers) {
		if (!layer.id.startsWith("road_one_way_arrow")) continue;
		map.setLayoutProperty(layer.id, "icon-image", ARROW_IMAGE);
		// Roads are narrow at the zoom the arrows first appear, and grow.
		map.setLayoutProperty(layer.id, "icon-size", ["interpolate", ["linear"], ["zoom"], 16, 0.8, 19, 1.6]);
		map.setLayoutProperty(layer.id, "symbol-spacing", 120);
	}
}

/**
 * Clears away the shops, banks and bus stops, and marks what a rider looks
 * for instead: bike shops and rental docks, water and toilets, and, closer
 * in, somewhere to eat. Railway stations stay.
 */
function addRiderStops(map, layers, source) {
	const stock = layers.filter((layer) => layer.type === "symbol" && layer["source-layer"] === "poi");
	for (const layer of stock) {
		if (layer.id === "poi_transit") map.setFilter(layer.id, ["==", get("class"), "rail"]);
		else map.setLayoutProperty(layer.id, "visibility", "none");
	}
	const beforeId = stock[0]?.id;
	const name = ["coalesce", get("name_en"), get("name"), ""];
	const stop = {
		type: "symbol",
		source,
		"source-layer": "poi",
		paint: { "text-color": "#1d1d1d", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
	};
	const layout = {
		"text-font": ["Noto Sans Regular"],
		"text-size": 11,
		"text-anchor": "top",
		"text-offset": [0, 0.7],
		"text-max-width": 8,
		// An icon is worth showing even where there's no room for its name.
		"text-optional": true,
	};
	const convenience = ["all", ["==", get("class"), "shop"], ["==", get("subclass"), "convenience"]];

	map.addLayer(
		{
			...stop,
			id: "bike-stops-food",
			minzoom: 15,
			filter: ["any", oneOf("class", FOOD_CLASSES), convenience],
			layout: {
				...layout,
				"icon-image": ["match", get("class"), "shop", "grocery", get("class")],
				"icon-size": 0.9,
				"text-field": ["step", ["zoom"], "", 17, name],
			},
		},
		beforeId,
	);
	map.addLayer(
		{
			...stop,
			id: "bike-stops",
			minzoom: 13,
			filter: oneOf("class", STOP_CLASSES),
			layout: {
				...layout,
				"icon-image": get("class"),
				// Bike shops first where they crowd, then water, toilets, rental docks.
				"symbol-sort-key": ["match", get("class"), "bicycle", 0, "drinking_water", 1, "toilets", 2, 3],
				"text-field": ["step", ["zoom"], "", 15, ["match", get("class"), "bicycle", name, ""], 17, name],
			},
		},
		beforeId,
	);
}
