const CACHE = "nn-cache-v4";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: "התראה חדשה", body: event.data ? event.data.text() : "" }; }
  const options = {
    body: data.body || "",
    icon: "/icon-192-v2.png",
    badge: "/badge-96.png",
    dir: "rtl", lang: "he",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    vibrate: [200, 100, 200],
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(data.title || "ניהול משק חכם", options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if ("focus" in client) { client.navigate(target).catch(() => {}); return client.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(target);
  }));
});
