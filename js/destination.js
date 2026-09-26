/**
 * A destination for the ride, picked on the map in ride setup: an unsaved,
 * one-point route (see `destinationRoute` in ride-plan.js) that the ride
 * follows point to point, so it gets the same live routing and turn-by-turn
 * directions as a planned route's next point.
 *
 * Picking hides the setup panel and lets the rider tap (then drag) a pin.
 * Once set, the way there is routed from where the rider is, which also
 * downloads and caches the map data along it, so the live route to it works
 * offline mid-ride. A destination and a saved route are either/or.
 */

import { state, el } from "./state.js";
import { formatDistance, haversineMeters } from "./format.js";
import { distanceUnitLabel } from "./map-visuals.js";
import { setLivePlanData } from "./live-map.js";
import { destinationRoute, destinationMarkerElement } from "./ride-plan.js";

// The pin on the setup map, and where it was before picking started (so
// Cancel can put it back).
let marker = null;
let beforePicking = null;
let worker = null;
let requestId = 0;

/** Wires the setup panel's Destination row and the pick bar's buttons. */
export function wireDestination() {
	el.setupDestinationBtn.addEventListener("click", startPicking);
	el.setupDestinationClearBtn.addEventListener("click", clearDestination);
	el.destinationPickCancelBtn.addEventListener("click", cancelPicking);
	el.destinationPickDoneBtn.addEventListener("click", finishPicking);
	// Picking a saved route replaces the destination.
	el.setupRouteSelect.addEventListener("change", () => {
		if (el.setupRouteSelect.value) forgetDestination();
	});
}

/** Forgets any destination and leaves picking: for a new ride setup. */
export function resetDestination() {
	stopPicking();
	forgetDestination();
}

/** Whether the rider is placing a destination pin, when setup shouldn't move the map. */
export function isPickingDestination() {
	return state.destinationPicking;
}

function startPicking() {
	const map = state.liveMap;
	if (!map) return;
	state.destinationPicking = true;
	beforePicking = marker?.getLngLat().toArray() ?? null;
	el.screens.active.dataset.picking = "";
	el.destinationPickBar.hidden = false;
	updatePickBar();
	map.on("click", placePin);
}

function stopPicking() {
	state.destinationPicking = false;
	delete el.screens.active.dataset.picking;
	el.destinationPickBar.hidden = true;
	state.liveMap?.off("click", placePin);
	marker?.setDraggable(false);
}

function placePin(event) {
	const map = state.liveMap;
	if (!map) return;
	if (!marker) {
		marker = new maplibregl.Marker({ element: destinationMarkerElement(), anchor: "bottom", draggable: true });
	}
	marker.setLngLat(event.lngLat).setDraggable(true).addTo(map);
	updatePickBar();
}

function updatePickBar() {
	const placed = Boolean(marker?.getLngLat());
	el.destinationPickHint.textContent = placed
		? "Drag the pin, or tap somewhere else to move it."
		: "Tap the map where you're heading. Pan and zoom to find it.";
	el.destinationPickDoneBtn.disabled = !placed;
}

function cancelPicking() {
	stopPicking();
	if (beforePicking) {
		marker.setLngLat(beforePicking);
	} else {
		marker?.remove();
		marker = null;
	}
	recenterOnRider();
}

function finishPicking() {
	if (!marker) return;
	stopPicking();
	setDestination(marker.getLngLat().toArray());
}

/**
 * Makes `point` the ride's destination: clears any saved route picked, draws
 * a straight line to it until the way there is routed, and frames both.
 *
 * @param {[number, number]} point - [lng, lat].
 */
function setDestination(point) {
	const rider = riderLngLat();
	el.setupRouteSelect.value = "";
	el.setupRouteModeRow.hidden = true;
	const route = destinationRoute(point, rider ? [rider, point] : [point]);
	state.rideRoute = route;
	setLivePlanData();
	showDestination(rider ? `${distanceText(straightMeters(rider, point))} away · finding a route…` : "Set");
	frame(rider, point);
	if (rider) routeThere(route, rider);
}

/** Routes from the rider to the destination, for the setup map and to cache the map data on the way. */
function routeThere(route, rider) {
	const point = route.waypoints[0];
	const id = ++requestId;
	request({ type: "leg", from: rider, to: point, profile: state.selectedActivityType === "bike" ? "bike" : "foot" })
		.then((answer) => {
			if (id !== requestId || state.rideRoute !== route) return;
			if (answer.route) {
				route.coords = answer.route.coords;
				route.meters = answer.route.meters;
				setLivePlanData();
				showDestination(`${distanceText(answer.route.meters)} by road`);
			} else {
				showDestination(`${distanceText(straightMeters(rider, point))} away · no route found yet`);
			}
		})
		.catch((error) => {
			console.warn("Routing to the destination failed", error);
			if (id === requestId && state.rideRoute === route) showDestination(`${distanceText(straightMeters(rider, point))} away`);
		});
}

function clearDestination() {
	forgetDestination();
	recenterOnRider();
}

/** Drops the destination, its pin and its line, leaving the ride with no route. */
function forgetDestination() {
	requestId++;
	marker?.remove();
	marker = null;
	beforePicking = null;
	if (state.rideRoute?.destination) {
		state.rideRoute = null;
		setLivePlanData();
	}
	el.setupDestinationText.hidden = true;
	el.setupDestinationClearBtn.hidden = true;
	el.setupDestinationBtn.textContent = "Set on map";
}

function showDestination(text) {
	el.setupDestinationText.textContent = text;
	el.setupDestinationText.hidden = false;
	el.setupDestinationClearBtn.hidden = false;
	el.setupDestinationBtn.textContent = "Change";
}

/** Fits the setup map to the rider and the destination. */
function frame(rider, point) {
	const map = state.liveMap;
	if (!map || !rider) return;
	const bounds = new maplibregl.LngLatBounds(rider, rider).extend(point);
	map.fitBounds(bounds, { padding: 60, maxZoom: state.prefs.liveMapZoom, duration: 600 });
}

function recenterOnRider() {
	const rider = riderLngLat();
	if (rider) state.liveMap?.easeTo({ center: rider, zoom: state.prefs.liveMapZoom, duration: 450 });
}

function riderLngLat() {
	const coords = state.setupPosition?.coords;
	return coords ? [coords.longitude, coords.latitude] : null;
}

function straightMeters([lngA, latA], [lngB, latB]) {
	return haversineMeters(latA, lngA, latB, lngB);
}

function distanceText(meters) {
	return `${formatDistance(meters, state.prefs.unit)} ${distanceUnitLabel(state.prefs.unit)}`;
}

/** Sends one request to the routing worker (started on first use). */
function request(message) {
	try {
		worker ??= new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
	} catch (error) {
		return Promise.reject(error);
	}
	const id = Date.now() + Math.random();
	return new Promise((resolve, reject) => {
		const handle = (event) => {
			if (event.data.id !== id) return;
			worker.removeEventListener("message", handle);
			if (event.data.error) reject(new Error(event.data.error));
			else resolve(event.data);
		};
		worker.addEventListener("message", handle);
		worker.postMessage({ id, ...message });
	});
}
