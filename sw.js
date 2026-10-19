/**
 * AzollaSense Service Worker
 *
 * Cache-first for static assets, network-first for navigation,
 * with an offline fallback to the app shell.
 */

const CACHE_NAME = "azollasense-v38";
const APP_BASE = new URL("./", self.registration.scope);
const appPath = (path) => new URL(path.replace(/^\//, ""), APP_BASE).href;

const CORE_ASSETS = [
  "./index.html",
  "./login.html",
  "./css/style.css?v=48",
  "./js/app.js?v=48",
  "./js/auth.js?v=3",
  "./manifest.json",
  "./assets/logo.png",
  "./assets/tank.png",
  "./assets/pond.jpg",
  "./assets/welcome_bg.png",
];

// Always fetch live streams, server status, API responses, and saved captures.
const NETWORK_ONLY = ["/video_feed", "/socket.io/", "/api/", "/health", "/assets/captures/"];
const STATIC_DESTINATIONS = new Set(["font", "image", "manifest", "script", "style"]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache each asset separately so one missing optional asset cannot fail installation.
    await Promise.allSettled(CORE_ASSETS.map((url) =>
      cache.add(url).catch((err) => console.warn(`[SW] Cache failed: ${url}`, err))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith("azollasense-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  const relativePath = url.pathname.startsWith(APP_BASE.pathname)
    ? url.pathname.slice(APP_BASE.pathname.length - 1)
    : url.pathname;
  if (NETWORK_ONLY.some((path) => relativePath === path || relativePath.startsWith(path))) return;

  // Navigation requests: network first, fall back to the cached app shell
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        const cache = await caches.open(CACHE_NAME);
        return await cache.match(appPath("login.html")) || Response.error();
      }
    })());
    return;
  }
  if (!STATIC_DESTINATIONS.has(request.destination)) return;

  // Static resources use the current cache first, then refresh from the network.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.status === 200 && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (request.destination === "image") {
        const fallback = await cache.match(appPath("assets/logo.png"));
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: event.data?.text() || "A system status changed." }; }
  const show = async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const dashboardIsVisible = windows.some((client) => {
      try {
        const url = new URL(client.url);
        return url.origin === self.location.origin && !url.pathname.endsWith("/login") && client.visibilityState === "visible";
      } catch (_) { return false; }
    });
    // The dashboard polls alert transitions and renders an in-page toast while visible.
    if (dashboardIsVisible) return;
    await self.registration.showNotification(payload.title || "AzollaSense system alert", {
      body: payload.body || "A system status changed.",
      icon: appPath("assets/logo.png"),
      badge: appPath("assets/logo.png"),
      tag: payload.tag || "azollasense-system-alert",
      data: { url: appPath("./") }
    });
  };
  event.waitUntil(show());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || appPath("./");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "focus" in client) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
