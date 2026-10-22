/**
 * What a planned route's points are: each can have an icon (a water stop,
 * the start, …) and a title, both optional. A route keeps them in `marks`,
 * one per waypoint in the same order, each {icon, title, stop} or null for a
 * plain point (an older route may have no `marks`, or fewer than its
 * waypoints: the rest are plain).
 *
 * Each point is also either a stop or a via point. Stops are announced when
 * reached and shown as the next stop; via points only keep the route on the
 * way planned, in order, and are passed quietly. The start and end are
 * always stops; in between, a point with an icon or title is a stop and a
 * plain one is a via point, unless its mark's `stop` (true or false, left
 * out when it agrees) says otherwise. They're picked in the planner
 * (route-plan.js), drawn on the planner and ride maps, carried in share links
 * (route-share.js), named in directions, and written to GPX exports (gpx.js).
 */

/** Longest title a point may have. */
export const MAX_POINT_TITLE_LENGTH = 40;

/**
 * The icons a point can have, in picker order: each with its name, a line
 * drawing in a 24-unit box, and the GPX symbol (Garmin's names, which other
 * apps tend to follow) it's exported with.
 */
export const POINT_ICONS = {
	start: { label: "Start", gpx: "Flag, Green", svg: '<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>' },
	end: {
		label: "End",
		gpx: "Flag, Red",
		svg: '<path d="M5 21V4"/><path d="M5 4h14v9H5"/><path d="M5 8.5h14"/><path d="M9.7 4v9"/><path d="M14.3 4v9"/>',
	},
	water: { label: "Water", gpx: "Drinking Water", svg: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>' },
	food: {
		label: "Food",
		gpx: "Restaurant",
		svg: '<path d="M7 3v7a2 2 0 0 0 4 0V3"/><path d="M9 3v18"/><path d="M17 21V3c-2 1.5-3 4-3 8h3"/>',
	},
	rest: {
		label: "Rest stop",
		gpx: "Picnic Area",
		svg: '<path d="M4 9h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M4 21h12"/>',
	},
	restroom: {
		label: "Restroom",
		gpx: "Restroom",
		svg: '<circle cx="7.5" cy="4.5" r="1.5"/><circle cx="16.5" cy="4.5" r="1.5"/><path d="M6 8h3l.5 6H8.5V21h-2v-7h-1z"/><path d="M16.5 8 13 16h2v5h3v-5h2z"/>',
	},
	view: { label: "Viewpoint", gpx: "Scenic Area", svg: '<path d="m3 20 6-10 4 6 3-4 5 8z"/><circle cx="17" cy="6" r="2"/>' },
	shop: {
		label: "Bike shop",
		gpx: "Shopping Center",
		svg: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
	},
	parking: { label: "Parking", gpx: "Parking Area", svg: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 17V7h3a3 3 0 0 1 0 6h-3"/>' },
	firstaid: { label: "First aid", gpx: "Medical Facility", svg: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8"/><path d="M8 12h8"/>' },
	caution: { label: "Caution", gpx: "Danger Area", svg: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4"/><path d="M12 17v.01"/>' },
};

/**
 * A mark as stored or received, made safe to use: a known icon (or none) and
 * a trimmed title of at most MAX_POINT_TITLE_LENGTH, or null when it has
 * neither. Anything else (a damaged record, a link from a newer version with
 * icons this one doesn't know) loses what it can't use.
 *
 * @param {*} mark
 * A `stop` that agrees with what the icon and title make the point anyway
 * is dropped.
 *
 * @returns {{icon: string|null, title: string, stop?: boolean}|null}
 */
export function normalizeMark(mark) {
	if (!mark || typeof mark !== "object") return null;
	const icon = typeof mark.icon === "string" && Object.hasOwn(POINT_ICONS, mark.icon) ? mark.icon : null;
	const title = typeof mark.title === "string" ? mark.title.trim().slice(0, MAX_POINT_TITLE_LENGTH) : "";
	const labelled = Boolean(icon || title);
	if (typeof mark.stop === "boolean" && mark.stop !== labelled) return { icon, title, stop: mark.stop };
	return labelled ? { icon, title } : null;
}

/**
 * Whether a route's waypoint `index` is a stop rather than a via point (see
 * above). A route with no waypoints in between has only stops.
 * @param {{waypoints?: Array, marks?: Array}|null|undefined} route
 * @param {number} index
 */
export function isStop(route, index) {
	const count = route?.waypoints?.length ?? 0;
	if (index <= 0 || index >= count - 1) return true;
	const mark = markAt(route, index);
	return mark?.stop ?? Boolean(mark);
}

/** A stop's number among the route's stops, counting from 1. */
function stopNumber(route, index) {
	let number = 0;
	for (let i = 0; i <= index; i++) if (isStop(route, i)) number++;
	return number;
}

/**
 * The mark of a route's waypoint `index`, or null.
 * @param {{marks?: Array}|null|undefined} route
 * @param {number} index
 */
export function markAt(route, index) {
	return normalizeMark(route?.marks?.[index]);
}

/**
 * What to call a route's waypoint `index`: its title, else its icon's name,
 * else "Point N" (N counting stops only), or "Via point".
 * @returns {string}
 */
export function pointName(route, index) {
	const mark = markAt(route, index);
	if (mark?.title) return mark.title;
	if (mark?.icon) return POINT_ICONS[mark.icon].label;
	return isStop(route, index) ? `Point ${stopNumber(route, index)}` : "Via point";
}

/** An icon's line drawing as an SVG element's markup. */
export function pointIconSvg(icon) {
	const drawing = POINT_ICONS[icon]?.svg ?? "";
	return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${drawing}</svg>`;
}

/**
 * The inside of a waypoint's map marker: its icon, or else its number among
 * the stops; a via point without an icon is a small plain dot. The start and
 * end are coloured like the start and end of a ride.
 * @returns {{html: string, className: string}}
 */
export function pointMarkerContent(route, index) {
	const mark = markAt(route, index);
	const via = isStop(route, index) ? "" : " via";
	if (mark?.icon) return { html: pointIconSvg(mark.icon), className: `has-icon point-${mark.icon}${via}` };
	return via ? { html: "", className: "via" } : { html: String(stopNumber(route, index)), className: "" };
}
