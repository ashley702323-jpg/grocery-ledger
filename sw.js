const CACHE = "grocery-ledger-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// app shell (html/css/js/manifest): network-first, so an update deployed to
// GitHub Pages is picked up on the next load instead of being stuck on
// whatever was cached before — falls back to cache only when offline.
// everything else (icons, the OCR library/language data from the CDN):
// cache-first, since those rarely change and benefit from being reused
// without a network round trip, and this is what makes offline OCR possible
// after the first run.
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isShell = url.origin === location.origin && SHELL_PATHS.has(url.pathname);

  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => {
            try { cache.put(e.request, copy); } catch (err) { /* opaque/cross-origin: best effort */ }
          });
          return res;
        })
        .catch(() => cached);
    })
  );
});
