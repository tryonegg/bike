const CACHE_VERSION = "v1.2.2";
const CACHE_PREFIX = "bike-tracker-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const RUNTIME_CACHE = "bike-tracker-runtime-v1";
const TILE_CACHE = "bike-tracker-tiles-v1";
const TILE_CACHE_MAX = 500;
const STADIA_CACHE = "bike-tracker-stadia-v1";

const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/marker-icon.png",
  "./vendor/leaflet/marker-icon-2x.png",
  "./vendor/leaflet/marker-shadow.png",
  "./vendor/maplibre/maplibre-gl.css",
  "./vendor/maplibre/maplibre-gl.js",
  "./vendor/maplibre/leaflet-maplibre-gl.js",
];

const SHELL_ASSET_SUFFIXES = [
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/marker-icon.png",
  "/vendor/leaflet/marker-icon-2x.png",
  "/vendor/leaflet/marker-shadow.png",
  "/vendor/maplibre/maplibre-gl.css",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre/leaflet-maplibre-gl.js",
];

const UPDATE_WATCH_SUFFIXES = [
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre/leaflet-maplibre-gl.js",
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
          .concat(keys.filter((key) => key.startsWith("bike-tracker-tiles-") && key !== TILE_CACHE))
          .concat(keys.filter((key) => key.startsWith("bike-tracker-stadia-") && key !== STADIA_CACHE))
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
    if (request.url.includes("tile.openstreetmap.org") || request.url.includes("tiles.stadiamaps.com")) {
      if (request.url.includes("tiles.stadiamaps.com")) {
        event.respondWith(stadiaFirst(request));
      } else {
        event.respondWith(tileFirst(request));
      }
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
      await limitTileCache(cache);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (cached) return cached; // serve stale on network failure
    throw new Error("Stadia tile unavailable offline and not cached");
  }
}

async function tileFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await limitTileCache(cache);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    throw new Error("Tile unavailable offline and not cached");
  }
}

async function limitTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length < TILE_CACHE_MAX) return;
  const overflow = keys.length - TILE_CACHE_MAX + 1;
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
