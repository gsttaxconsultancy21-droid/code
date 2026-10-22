// Network-first service worker: always fresh when online, fully playable offline.
const CACHE = 'inkland-v2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'src/engine/util.js',
  'src/engine/constants.js',
  'src/engine/arena.js',
  'src/engine/bot.js',
  'src/engine/game.js',
  'src/client/palette.js',
  'src/client/storage.js',
  'src/client/missions.js',
  'src/client/replay.js',
  'src/client/haptics.js',
  'src/client/audio.js',
  'src/client/input.js',
  'src/client/renderer.js',
  'src/client/net.js',
  'src/client/ui.js',
  'src/client/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
