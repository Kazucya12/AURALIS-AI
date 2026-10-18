// Service worker Auralis AI: cangkang aplikasi tersimpan agar bisa dibuka offline. Permintaan /api/* tidak pernah disimpan.
const V = 'auralis-v3';
const SHELL = ['/', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin === location.origin && u.pathname.startsWith('/api/')) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put('/', c)); } return res; }).catch(() => caches.match('/')));
    return;
  }
  const ext = /(^|\.)(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname);
  if (u.origin !== location.origin && !ext) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r);
    const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(l => l.length ? l[0].focus() : self.clients.openWindow('/')));
});
