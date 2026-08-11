// sw.js — Service worker minimal : mise en cache de l'app shell (HTML/CSS/JS)
// pour permettre l'installation (PWA) et un premier affichage plus rapide.
// Ne met JAMAIS en cache les appels /api/ — les données restent toujours à jour.
const CACHE_NAME = 'atlas-shell-v2';
const SHELL_FILES = ['/', '/css/style.css', '/js/app.js', '/js/i18n.js', '/manifest.json'];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Jamais de cache pour l'API : toujours des données fraîches.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;
  // Réseau d'abord : on essaie toujours de récupérer la dernière version en
  // ligne, et on ne retombe sur le cache que si la requête échoue (hors
  // ligne). Avant, le cache était servi en priorité, ce qui pouvait figer
  // les visiteurs sur une ancienne version après un déploiement, même après
  // un rafraîchissement (F5) classique.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
