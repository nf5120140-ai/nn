const CACHE = "nn-cache-v5";
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
    data: {
      url: data.url || "/",
      // Carried through so the "done" button can mark the task done without opening the app.
      taskId: data.taskId || null,
      org: data.org || null,
      doneUrl: data.doneUrl || null,
      doneAuth: data.doneAuth || null,
    },
  };
  // When the push is about a specific task, add a "done" button.
  // On a paired Galaxy Watch this button is mirrored to the wrist.
  if (data.taskId && data.doneUrl) {
    options.actions = [{ action: "done", title: "\u2713 \u05d1\u05d5\u05e6\u05e2" }];
  }
  event.waitUntil(self.registration.showNotification(data.title || "\u05e0\u05d9\u05d4\u05d5\u05dc \u05de\u05e9\u05e7 \u05d7\u05db\u05dd", options));
});

// Small helper: pop a short confirmation notification (used after a wrist action).
function ack(title, ok) {
  return self.registration.showNotification(title, {
    icon: "/icon-192-v2.png",
    badge: "/badge-96.png",
    dir: "rtl", lang: "he",
    tag: "ack",
    renotify: true,
    vibrate: ok ? [80] : [200, 100, 200],
  });
}

self.addEventListener("notificationclick", (event) => {
  const d = (event.notification && event.notification.data) || {};
  event.notification.close();

  // (1) Client-side test button - proves the watch forwards the tap. No server needed.
  if (event.action === "done-test") {
    event.waitUntil(ack("\u2713 \u05e2\u05d1\u05d3! \u05d4\u05dc\u05d7\u05d9\u05e6\u05d4 \u05de\u05d4\u05e9\u05e2\u05d5\u05df \u05d4\u05ea\u05e7\u05d1\u05dc\u05d4", true));
    return;
  }

  // (2) The real "done" button - mark the task done in Supabase, without opening the app.
  //     Works both when pressed on the phone and when forwarded from the watch.
  if (event.action === "done" && d.taskId && d.doneUrl) {
    event.waitUntil((async () => {
      try {
        const res = await fetch(d.doneUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(d.doneAuth ? { Authorization: "Bearer " + d.doneAuth, apikey: d.doneAuth } : {}),
          },
          body: JSON.stringify({ org: d.org, taskId: d.taskId }),
        });
        await ack(res.ok ? "\u2713 \u05d4\u05de\u05e9\u05d9\u05de\u05d4 \u05e1\u05d5\u05de\u05e0\u05d4 \u05db\u05d1\u05d5\u05e6\u05e2\u05d4" : "\u05dc\u05d0 \u05d4\u05e6\u05dc\u05d7\u05ea\u05d9 \u05dc\u05e1\u05de\u05df - \u05e0\u05e1\u05d4 \u05de\u05d4\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4", res.ok);
      } catch (e) {
        await ack("\u05d0\u05d9\u05df \u05d7\u05d9\u05d1\u05d5\u05e8 - \u05e0\u05e1\u05d4 \u05e9\u05d5\u05d1 \u05de\u05d4\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4", false);
      }
    })());
    return;
  }

  // (3) Default tap (body of the notification): open / focus the app.
  const target = d.url || "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if ("focus" in client) { client.navigate(target).catch(() => {}); return client.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(target);
  }));
});
