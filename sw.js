const CACHE_VERSION = "v1.5.0";
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

const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./pace-index.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/settings.svg",
  "./vendor/maplibre/maplibre-gl.css",
  "./vendor/maplibre/maplibre-gl.js",
  "./vendor/maplibre-contour/maplibre-contour.min.js",
  "./vendor/archivo/archivo-latin-wght-normal.woff2",
];

const SHELL_ASSET_SUFFIXES = [
  "/index.html",
  "/app.css",
  "/app.js",
  "/pace-index.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/settings.svg",
  "/vendor/maplibre/maplibre-gl.css",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre-contour/maplibre-contour.min.js",
  "/vendor/archivo/archivo-latin-wght-normal.woff2",
];

const UPDATE_WATCH_SUFFIXES = [
  "/index.html",
  "/app.css",
  "/app.js",
  "/pace-index.js",
  "/manifest.webmanifest",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre-contour/maplibre-contour.min.js",
];

let updateNotified = false;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

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

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (MAP_DATA_HOSTS.includes(url.hostname)) {
      // Style JSON and the TileJSON change when OpenFreeMap publishes new data, so
      // they are refreshed when online. Fonts, sprites and tiles live under
      // versioned paths and never change, so those are served from cache first.
      const { pathname } = url;
      if (pathname.startsWith("/styles/") || pathname === "/planet") {
        event.respondWith(networkFirst(request, MAP_STYLE_CACHE));
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
    event.respondWith(networkFirst(request, CACHE_NAME, true));
    return;
  }

  if (isShellAsset(url.pathname)) {
    event.respondWith(networkFirst(request, CACHE_NAME, shouldWatchForUpdates(url.pathname)));
    return;
  }

  event.respondWith(cacheFirst(request, RUNTIME_CACHE));
});

function isShellAsset(pathname) {
  return SHELL_ASSET_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

function shouldWatchForUpdates(pathname) {
  return UPDATE_WATCH_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

async function networkFirst(request, cacheName, notifyOnChange = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  try {
    const response = await fetch(request, { cache: "no-cache" });
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
  } catch {
    if (cached) return cached;
    throw new Error("Network unavailable and no cached response");
  }
}

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

async function limitTileCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length < maxEntries) return;
  const overflow = keys.length - maxEntries + 1;
  for (let i = 0; i < overflow; i += 1) {
    await cache.delete(keys[i]);
  }
}

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

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

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
