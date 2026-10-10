/**
 * AzollaSense Service Worker
 *
 * Cache-first for static assets, network-first for navigation,
 * with an offline fallback to the app shell.
 */

const CACHE_NAME = "azollasense-v12";
const APP_BASE = new URL("./", self.registration.scope);
const appPath = (path) => new URL(path.replace(/^\//, ""), APP_BASE).href;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./login.html",
  "./css/style.css?v=21",
  "./js/app.js?v=27",
  "./js/auth.js?v=2",
  "./manifest.json",
  "./assets/logo.png",
  "./assets/tank.png",
  "./assets/pond.jpg",
  "./assets/welcome_bg.png",
];

// Never cache: live streams, socket polling and API calls
const NETWORK_ONLY = ["/video_feed", "/socket.io/", "/api/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Cache each asset individually so one missing file (e.g. an
      // optional image) can never fail the whole installation.
      await Promise.allSettled(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn(`[SW] Cache failed: ${url}`, err))
        )
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (NETWORK_ONLY.some((path) => url.href.startsWith(appPath(path)))) return;

  // Navigation requests: network first, fall back to the cached app shell
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(appPath("login.html"))));
    return;
  }

  // Everything else: cache first, then network + dynamic caching
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            if (response && response.status === 200 && response.type === "basic") {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => {
            if (request.destination === "image") {
              return caches.match(appPath("assets/logo.png"));
            }
          })
    )
  );
});
