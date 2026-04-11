// Service worker for The Peak Loyalty PWA.
//
// Responsibilities:
//  1. Handle `push` events and show a native notification.
//  2. Handle `notificationclick` to reopen the customer's card.
//  3. Self-rescue on `pushsubscriptionchange` (Chrome occasionally rotates
//     subscriptions silently).
//
// This file is served from /sw.js so its scope is the whole origin.

self.addEventListener('install', (event) => {
  // Activate immediately on first install.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'The Peak', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'The Peak';
  const options = {
    body: data.body || '',
    icon: '/thePeak_logo_color.png',
    badge: '/thePeak_logo_color.png',
    tag: data.tag || 'default',
    renotify: true,
    data: { url: data.url || '/card.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/card.html';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // If a tab/PWA window is already open, focus it and navigate.
      for (const client of allClients) {
        if ('focus' in client) {
          try {
            if ('navigate' in client && targetUrl !== '/card.html') {
              await client.navigate(targetUrl);
            }
            return client.focus();
          } catch {}
        }
      }
      // Otherwise open a fresh window.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});

// If the browser rotates the subscription, re-subscribe and tell the server
// about the new one. We don't know the customer's token here, so we can't
// call /api/push/subscribe — but when the user next opens the card page the
// in-page JS re-subscribes anyway.
self.addEventListener('pushsubscriptionchange', (event) => {
  // No-op: the customer will resubscribe on next card page visit.
});
