const C='auralis-v1';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['./','icon.svg'])))});
self.addEventListener('fetch',e=>{if(e.request.method!='GET'||new URL(e.request.url).pathname.startsWith('/api')||new URL(e.request.url).origin!=location.origin)return;e.respondWith(fetch(e.request).then(r=>{const k=r.clone();caches.open(C).then(c=>c.put(e.request,k));return r}).catch(()=>caches.match(e.request)))});
