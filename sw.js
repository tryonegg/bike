/**
 * The app's service worker: precaches the app shell (HTML/CSS/JS modules +
 * vendored libraries) for offline use, serves map tiles/styles/fonts with
 * caching strategies tuned per data type, and notifies the page when a
 * newer shell is available so it can prompt the rider to reload (see
 * js/pwa.js's `setupServiceWorkerUpdateChecks`, which is the page-side half
 * of that handshake).
 */

const CACHE_VERSION = "v1.11.5";
const CACHE_PREFIX = "bike-tracker-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const RUNTIME_CACHE = "bike-tracker-runtime-v1";
const STADIA_CACHE = "bike-tracker-stadia-v1";
const STADIA_CACHE_MAX = 500;
// OpenFreeMap vector tiles plus the elevation tiles behind topo mode. Vector
// tiles are small and each covers every zoom from 14 in, so this spans a lot
// of riding.
const MAP_DATA_CACHE = "bike-tracker-mapdata-v1";
const MAP_DATA_CACHE_MAX = 1500;
// Styles, fonts and sprites are few but the map is blank or unlabelled without
// them, so they live apart from the tiles where eviction cannot reach them.
const MAP_STYLE_CACHE = "bike-tracker-mapstyle-v1";
const MAP_DATA_HOSTS = ["tiles.openfreemap.org", "elevation-tiles-prod.s3.amazonaws.com"];

// The app's logic, split across js/*.js ES modules and imported from app.js.
const APP_MODULES = [
  "./js/constants.js",
  "./js/state.js",
  "./js/format.js",
  "./js/colors.js",
  "./js/pace-index.js",
  "./js/db.js",
  "./js/modal.js",
  "./js/map-visuals.js",
  "./js/pwa.js",
  "./js/navigation.js",
  "./js/history-view.js",
  "./js/ride-setup.js",
  "./js/live-session.js",
  "./js/live-map.js",
  "./js/pace.js",
  "./js/post-session.js",
  "./js/chart.js",
  "./js/data-io.js",
  "./js/gpx.js",
  // Route home: the worker and what it imports load separately from app.js,
  // so they are listed here to work offline too.
  "./js/route-home.js",
  "./js/route-follow.js",
  "./js/ride-plan.js",
  "./js/route-plan.js",
  "./js/route-share.js",
  "./js/route-worker.js",
  "./js/route-graph.js",
  "./js/mvt.js",
];

// Precached on install, and served cache-first (revalidated in the background) below.
const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  ...APP_MODULES,
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/settings.svg",
  "./icons/flag.svg",
  "./vendor/maplibre/maplibre-gl.css",
  "./vendor/maplibre/maplibre-gl.js",
  "./vendor/maplibre-contour/maplibre-contour.min.js",
  "./vendor/archivo/archivo-latin-wght-normal.woff2",
];

// Path suffixes (not full paths) so these match regardless of the app's
// deployed base path. Checked by isShellAsset for every same-origin fetch.
const SHELL_ASSET_SUFFIXES = [
  "/index.html",
  "/app.css",
  "/app.js",
  ...APP_MODULES.map((path) => path.slice(1)),
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/settings.svg",
  "/icons/flag.svg",
  "/vendor/maplibre/maplibre-gl.css",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre-contour/maplibre-contour.min.js",
  "/vendor/archivo/archivo-latin-wght-normal.woff2",
];

// The subset of shell assets worth diffing against the network response to
// detect an update (icons/CSS-adjacent assets changing isn't worth a reload prompt).
const UPDATE_WATCH_SUFFIXES = [
  "/index.html",
  "/app.css",
  "/app.js",
  ...APP_MODULES.map((path) => path.slice(1)),
  "/manifest.webmanifest",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre-contour/maplibre-contour.min.js",
];

// Set once an update notification has been sent, so a burst of changed shell
// files (a whole new deploy) only prompts the rider once, not per file.
let updateNotified = false;

/**
 * Precaches every app-shell asset. Each is fetched past the browser's HTTP
 * cache: a copy left there from the previous version would otherwise be
 * precached alongside new files, and the app's modules only work with
 * matching versions of each other.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((asset) => new Request(asset, { cache: "reload" })))),
  );
});

/**
 * Drops every cache from a previous version/deploy (matched by prefix,
 * per cache family) once the new worker takes over, and claims existing
 * open tabs immediately rather than waiting for their next navigation.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .concat(keys.filter((key) => key.startsWith("bike-tracker-runtime-") && key !== RUNTIME_CACHE))
          // The OpenStreetMap raster cache from the Leaflet maps, which nothing uses now.
          .concat(keys.filter((key) => key.startsWith("bike-tracker-tiles-")))
          .concat(keys.filter((key) => key.startsWith("bike-tracker-stadia-") && key !== STADIA_CACHE))
          .concat(keys.filter((key) => key.startsWith("bike-tracker-mapdata-") && key !== MAP_DATA_CACHE))
          .concat(keys.filter((key) => key.startsWith("bike-tracker-mapstyle-") && key !== MAP_STYLE_CACHE))
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

/** Lets the page (via js/pwa.js) tell a waiting worker to activate immediately instead of waiting for all tabs to close. */
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/**
 * Routes every GET request to the right caching strategy: map data/style/
 * tile hosts get their own strategies (see the `MAP_DATA_HOSTS` branch and
 * the Stadia branch below), a same-origin navigation or shell asset is
 * served cache-first with the network fetched in the background to refresh
 * the cache (diffed for update notifications where `shouldWatchForUpdates`
 * applies), and anything else same-origin is plain cache-first (fetched
 * from the network only on a cache miss, with no background refresh).
 * Non-GET requests and unrecognized cross-origin requests are left to the
 * browser's default handling.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (MAP_DATA_HOSTS.includes(url.hostname)) {
      // Style JSON and the TileJSON change when OpenFreeMap publishes new data, so
      // they're served cache-first but revalidated in the background on every load.
      // Fonts, sprites and tiles live under versioned paths and never change, so
      // those are served cache-first with no revalidation at all.
      const { pathname } = url;
      if (pathname.startsWith("/styles/") || pathname === "/planet") {
        event.respondWith(cacheFirstWithRevalidate(event, request, MAP_STYLE_CACHE));
      } else if (pathname.startsWith("/fonts/") || pathname.startsWith("/sprites/")) {
        event.respondWith(cacheFirst(request, MAP_STYLE_CACHE));
      } else {
        event.respondWith(tileFirst(request, MAP_DATA_CACHE, MAP_DATA_CACHE_MAX));
      }
      return;
    }
    if (request.url.includes("tiles.stadiamaps.com")) {
      event.respondWith(stadiaFirst(request));
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(cacheFirstWithRevalidate(event, request, CACHE_NAME, true));
    return;
  }

  if (isShellAsset(url.pathname)) {
    event.respondWith(cacheFirstWithRevalidate(event, request, CACHE_NAME, shouldWatchForUpdates(url.pathname)));
    return;
  }

  event.respondWith(cacheFirst(request, RUNTIME_CACHE));
});

/** @param {string} pathname @returns {boolean} Whether this path is one of the precached app-shell assets. */
function isShellAsset(pathname) {
  return SHELL_ASSET_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

/** @param {string} pathname @returns {boolean} Whether a change to this shell asset should trigger an update prompt. */
function shouldWatchForUpdates(pathname) {
  return UPDATE_WATCH_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

/**
 * Cache-first fetch with background revalidation: serves the cached
 * response immediately when one exists, so the shell/style is never
 * blocked on the network — unlike a network-first strategy, a slow or
 * flaky connection can't make this hang, since the network is never on the
 * critical path for a cache hit. A network fetch (bypassing the HTTP cache
 * via `{cache: "no-cache"}`, so a conditional GET still revalidates) always
 * runs alongside it to refresh the cache for next time and, optionally,
 * diff the response against whatever was cached to detect a shell update.
 * Registered with `event.waitUntil` so the worker stays alive to finish
 * that background fetch even though it outlives the response already sent.
 * Only waits on the network directly when there's nothing cached yet.
 *
 * @param {FetchEvent} event
 * @param {Request} request
 * @param {string} cacheName
 * @param {boolean} [notifyOnChange] - When true (used for the shell's
 *   update-watched assets), compares the new response against the cached one
 *   and fires an update notification if they differ.
 * @returns {Promise<Response>}
 * @throws {Error} If nothing is cached and the network fails too.
 */
async function cacheFirstWithRevalidate(event, request, cacheName, notifyOnChange = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const revalidate = fetch(request, { cache: "no-cache" })
    .then(async (response) => {
      if (notifyOnChange && cached && response && response.ok) {
        const changed = await hasResponseChanged(cached, response);
        if (changed) {
          notifyUpdateAvailable(request.url);
        }
      }
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  event.waitUntil(revalidate);

  if (cached) return cached;

  const response = await revalidate;
  if (!response) throw new Error("Network unavailable and no cached response");
  return response;
}

/**
 * Cache-first fetch for Stadia map tiles, with an LRU-ish eviction cap.
 * Serves a cached tile immediately if present; otherwise fetches, caches
 * (evicting old entries first if at capacity), and returns it. Serves the
 * stale cached copy on a network failure rather than throwing, since a
 * slightly outdated tile is far better than a blank one.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 * @throws {Error} If the network fails and nothing is cached.
 */
async function stadiaFirst(request) {
  const cache = await caches.open(STADIA_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await limitTileCache(cache, STADIA_CACHE_MAX);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (cached) return cached; // serve stale on network failure
    throw new Error("Stadia tile unavailable offline and not cached");
  }
}

/**
 * Cache-first fetch for OpenFreeMap/elevation tiles, with the same
 * eviction-cap behavior as `stadiaFirst` but without a stale-on-failure
 * fallback (there is none to fall back to on a cache miss + network failure).
 *
 * @param {Request} request
 * @param {string} cacheName
 * @param {number} maxEntries
 * @returns {Promise<Response>}
 * @throws {Error} If the network fails and nothing is cached.
 */
async function tileFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await limitTileCache(cache, maxEntries);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    throw new Error("Tile unavailable offline and not cached");
  }
}

/**
 * Evicts the oldest entries from a tile cache once it's about to exceed
 * `maxEntries`, making room for the one about to be added. Cache iteration
 * order approximates insertion order, so the oldest entries are simply the
 * first ones `cache.keys()` returns.
 *
 * @param {Cache} cache
 * @param {number} maxEntries
 * @returns {Promise<void>}
 */
async function limitTileCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length < maxEntries) return;
  const overflow = keys.length - maxEntries + 1;
  for (let i = 0; i < overflow; i += 1) {
    await cache.delete(keys[i]);
  }
}

/**
 * Cache-first fetch: serves a cached response if present, otherwise fetches
 * and caches it. Used for everything that isn't the app shell or map data —
 * i.e. runtime assets that rarely if ever change.
 *
 * @param {Request} request
 * @param {string} cacheName
 * @returns {Promise<Response>}
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Decides whether a freshly-fetched shell asset actually differs from what
 * was cached — first cheaply, via caching-related headers, then (only if
 * those are inconclusive) by comparing the response bodies as text.
 *
 * @param {Response} cachedResponse
 * @param {Response} networkResponse
 * @returns {Promise<boolean>}
 */
async function hasResponseChanged(cachedResponse, networkResponse) {
  const headerKeys = ["etag", "last-modified", "content-length"];
  for (const key of headerKeys) {
    const oldValue = cachedResponse.headers.get(key);
    const newValue = networkResponse.headers.get(key);
    if (oldValue && newValue && oldValue !== newValue) {
      return true;
    }
  }

  const cachedText = await safeReadText(cachedResponse.clone());
  const networkText = await safeReadText(networkResponse.clone());
  if (cachedText != null && networkText != null) {
    return cachedText !== networkText;
  }

  return false;
}

/**
 * Reads a response body as text, swallowing any error (e.g. a binary asset
 * that can't be decoded as text) rather than letting it propagate.
 * @param {Response} response
 * @returns {Promise<string|null>} `null` on failure.
 */
async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Tells every open tab (including ones not currently controlled by this
 * worker) that a shell update is available, so each can offer the rider a
 * reload — see the `APP_SHELL_UPDATE_AVAILABLE` handler in
 * js/pwa.js's `setupServiceWorkerUpdateChecks`. Only fires once per worker
 * lifetime (`updateNotified`), so a whole new deploy's worth of changed
 * files doesn't prompt the rider once per file.
 *
 * @param {string} changedUrl - The URL whose response changed; informational only.
 * @returns {Promise<void>}
 */
async function notifyUpdateAvailable(changedUrl) {
  if (updateNotified) return;
  updateNotified = true;

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: "APP_SHELL_UPDATE_AVAILABLE",
      changedUrl,
    });
  }
}
