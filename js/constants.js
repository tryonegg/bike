/**
 * App-wide configuration constants: storage keys, unit conversion factors,
 * GPS/sensor tuning, map/camera behavior, and static display data (activity
 * types, pace-gradient colors, calendar-color descriptions). Grouped by
 * feature area in the order the rest of the app uses them, not alphabetized.
 */

export const DB_NAME = "bike-tracker-db";
export const DB_VERSION = 1;
export const SESSION_STORE = "sessions";
export const PREF_STORE = "preferences";

export const METERS_PER_MILE = 1609.344;
export const METERS_PER_KM = 1000;
export const MPS_TO_MPH = 2.236936;
export const MPS_TO_KPH = 3.6;

// watchPosition normally delivers roughly one fix per second, so the dropout
// threshold must sit well clear of that interval.
export const GPS_OUTAGE_THRESHOLD_MS = 3500;
export const DEAD_RECKONING_STEP_MS = 250;
export const MAX_DEAD_RECKONING_DRIFT_METERS = 50;

// An in-progress ride lives in memory, so it is checkpointed to IndexedDB and
// recovered on the next launch if the tab is evicted or the app is reloaded.
export const ACTIVE_SESSION_KEY = "activeSession";
export const CHECKPOINT_INTERVAL_MS = 10000;

// Number of discrete colors in the speed ramp used by the route line and chart.
export const SPEED_BANDS = 16;

// Debug GPS accuracy overlay: same idea as the speed ramp, but a point with no
// accuracy reading (dead-reckoned during a GPS gap, or a GPX import) draws in
// this neutral gray instead of guessing at a color.
export const ACCURACY_BANDS = 16;
export const ACCURACY_UNKNOWN_COLOR = "#9aa39a";

// Debug "clip GPS warm-up": a receiver is usually noisiest on its first few
// fixes and then locks on, but how long that takes varies ride to ride (open
// sky vs. tree cover or downtown), so "settled" is judged against this ride's
// own best fix rather than a fixed number. It's the first run of
// WARMUP_CONFIRM_COUNT consecutive fixes all within WARMUP_STABLE_FACTOR of
// that best accuracy; one lucky good fix alone doesn't count.
export const WARMUP_STABLE_FACTOR = 2;
export const WARMUP_CONFIRM_COUNT = 3;

// The pre-ride countdown, which also bounds how long the initial GPS fix gets.
export const COUNTDOWN_SECONDS = 5;

// Live map camera. Fixes land about once a second, so each follow move is eased
// over a little less than that to glide between fixes rather than jump. The
// zoom is only the starting default; the rider's own pick is saved as a pref.
export const LIVE_MAP_ZOOM = 16;
export const LIVE_CAMERA_EASE_MS = 900;
// A three-quarter view that tilts the road ahead into sight. It stays fixed for
// the ride: the tilt gestures are off and the follow camera never changes it.
export const LIVE_MAP_PITCH = 55;
// Which way the map points. At or above HEADING_GPS_MIN_SPEED_MPS the phone's
// own GPS heading is used: accurate when moving briskly, but unreliable when
// slow. Below it, or when the phone gives no heading, the map turns once the
// rider has moved HEADING_MIN_MOVE_M from where it last turned, pointing along
// that movement. That works at walking pace, and holds still at a stop, where
// GPS jitter rarely adds up to the distance. A shorter distance turns sooner but
// wobbles more; GPS positions are only good to a few meters.
export const HEADING_GPS_MIN_SPEED_MPS = 2 / MPS_TO_MPH;
export const HEADING_MIN_MOVE_M = 12;
export const LIVE_ROUTE_SOURCE = "live-route";
export const LIVE_GUIDE_SOURCE = "live-guide";
// The distance-to-start chip sits this far from the rider along the guide line,
// measured as if the map were flat; tilt shortens it on screen toward the
// horizon. It hides when the whole line is shorter than the minimum.
export const GUIDE_LABEL_OFFSET_PX = 90;
export const GUIDE_LABEL_MIN_LINE_PX = 70;
// Width of the whole world in pixels at zoom 0, which MapLibre doubles per zoom.
export const WORLD_SIZE_AT_ZOOM_0 = 512;

// Topo relief and contours are drawn from AWS's open terrain tiles. Zoom 13 is
// fine enough for riding-scale contours and keeps the download per view small.
export const DEM_TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
export const DEM_MAX_ZOOM = 13;
export const DEM_ATTRIBUTION = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain Tiles</a>';
export const FEET_PER_METER = 3.28084;
export const TOPO_LAYER_IDS = ["topo-hillshade", "topo-contour-lines", "topo-contour-labels"];
export const TOPO_SOURCE_IDS = ["topo-dem", "topo-contours"];

// Best past pace: the band colours the known paths within this distance ahead,
// fading out, and a stretch at least this steep gets a climb tag in the readout.
// Each path is a line layer of its own, since a line gradient is set per layer;
// the longest paths get the slots.
export const BEST_PACE_LAYER = "live-best-pace";
export const BEST_PACE_SLOTS = 12;
export const BEST_PACE_BAND_M = 500;
export const BEST_PACE_BAND_OPACITY = 0.6;
export const BEST_PACE_CLIMB_GRADE = 0.03;
export const CLEAR_LINE_GRADIENT = ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0, 0, 0, 0)", 1, "rgba(0, 0, 0, 0)"];

// noun names one outing in a title ("Morning walk"); plural heads the home count.
export const ACTIVITIES = {
	bike: { label: "Bike", icon: "🚴", noun: "ride", plural: "Rides" },
	walk: { label: "Walk", icon: "🚶", noun: "walk", plural: "Walks" },
	hike: { label: "Hike", icon: "🥾", noun: "hike", plural: "Hikes" },
	kayak: { label: "Kayak", icon: "🛶", noun: "paddle", plural: "Paddles" },
};

// Slow to fast, evenly spaced. Shared by the route, the elevation line, the
// segment bars and the calendar so one colour means one pace everywhere.
export const PACE_STOPS = ["#e05a3a", "#e07a3a", "#e0a63a", "#c9d63a", "#8fc93a", "#2f9c4f"];

// The settings note under the calendar colour choice, one per option.
export const CALENDAR_COLOR_NOTES = {
	distance: "Longer bars and green mark your longest rides and days, red your shortest.",
	time: "Longer bars and green mark the rides and days with the most moving time, red the least.",
	pace: "Longer bars and green mark your fastest rides and days for that activity, red your slowest.",
};

// This distance (in meters) determines which points are rejected for recording in processPoint
export const POINT_REJECTION_THRESHOLD = 1.0;
