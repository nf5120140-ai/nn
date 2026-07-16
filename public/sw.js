// Service Worker - ניהול משק חכם
const CACHE = "nn-cache-v3";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// רשת קודם, עם נפילה לרשת בלבד. לא מתערב בבקשות ל-Supabase או ל-API.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // דלג לגמרי על בקשות שאינן GET, ועל כל בקשה לדומיינים חיצוניים (Supabase וכו')
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  // אל תיגע בבקשות ניווט/API - רק נכסים סטטיים
  return;
});

// ===== Web Push =====
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "התראה חדשה", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "ניהול משק חכם";
  const options = {
    body: data.body || "",
    icon: "/icon-192-v2.png",
    badge: "/icon-192-v2.png",
    dir: "rtl",
    lang: "he",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    vibrate: [200, 100, 200],
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
