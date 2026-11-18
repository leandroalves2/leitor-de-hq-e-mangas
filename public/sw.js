const VERSION = 'comicstream-v5';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'assets/css/app.css',
  'assets/js/app.js',
  'assets/js/api.js',
  'assets/js/library.js',
  'assets/js/mobile.js',
  'assets/js/panels.js',
  'assets/js/reader.js',
  'assets/js/sources.js',
  'assets/js/state.js',
  'assets/js/stats.js',
  'assets/js/thumbs.js',
  'assets/js/upload.js',
  'assets/js/util.js',
  'assets/img/icon.svg',
  'assets/img/icon-192.png',
  'assets/img/icon-512.png',
  'assets/vendor/pdfjs/pdf.min.js',
  'assets/vendor/pdfjs/pdf.worker.min.js',
  'assets/vendor/page-flip/page-flip.browser.js',
  'assets/fonts/bangers-latin-400-normal.woff2',
  'assets/fonts/nunito-latin-wght-normal.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const stable = (path) => /\/assets\/(vendor|fonts|img)\//.test(path);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('api.php')) return;

  if (stable(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(VERSION).then((cache) => cache.put(req, res.clone()));
        return res;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
