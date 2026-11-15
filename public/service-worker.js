const CACHE='qr-attendance-shell-v1';
const SHELL=['/','/index.html','/student.html','/teacher.html','/projector.html','/scan.html','/offline.html','/style.css','/common.js'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(request.mode==='navigate'){
    const cachePage=!url.pathname.startsWith('/a/');
    event.respondWith(fetch(request).then(response=>{
      if(response.ok&&cachePage)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));
      return response;
    }).catch(async()=>{
      const cached=await caches.match(request);
      return cached||caches.match('/offline.html');
    }));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));
    return response;
  })));
});
