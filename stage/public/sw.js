// Service worker for Regatta.
//
// Strategy:
//   - HTML (navigations): network-first, so deploys land immediately; falls
//     back to cache offline.
//   - Hashed build assets (/assets/*): cache-first — the hash in the filename
//     makes them immutable.
//   - Big static models + icons (.glb, /icons/): stale-while-revalidate so
//     the 2 MB board doesn't re-download every visit but still updates.
//   - Everything else (including /api/ and WebSocket upgrades): untouched.
const CACHE = "regatta-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(["/", "/manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // realtime — never cache

  // Navigations: network-first.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Immutable hashed bundles: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Models + icons: stale-while-revalidate.
  if (url.pathname.endsWith(".glb") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        const refresh = fetch(event.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
            return res;
          })
          .catch(() => hit);
        return hit ?? refresh;
      }),
    );
  }
});
