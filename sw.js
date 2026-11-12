/* Резервная касса: офлайн-оболочка.
   Если меняете файлы приложения, поменяйте номер ниже (kassa-v5 -> kassa-v6), и телефоны обновятся. */
const CACHE = 'kassa-v5';
const SHELL = ['./', 'index.html', 'app.js', 'prep.html', 'html5-qrcode.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;     // чужие адреса (например, Google Таблицы) не трогаем
  if (/\/prices\.(csv|xlsx)$/.test(url.pathname)) return;                        // прайс всегда идёт напрямую в приложение
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    // Сразу отдаём то, что есть на телефоне; в фоне проверяем новую версию. Сеть никогда не задерживает запуск.
    const net = fetch(url.href, { cache: 'no-cache' })
      .then(r => { if (r && r.ok) cache.put(req, r.clone()); return r; })
      .catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net;
    if (r) return r;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    return new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
