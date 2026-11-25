// Service worker "kill switch".
// Aplikasi ini tidak memakai service worker. Berkas ini ada hanya untuk
// menggantikan service worker lama (dari project lain yang pernah berjalan di
// origin yang sama) yang masih terpasang di browser dan menyajikan cache usang:
// ia menghapus semua cache, melepas registrasinya, lalu memuat ulang tab.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
