// Service Worker: zeigt Push-Benachrichtigungen an, auch wenn das Dashboard nicht offen ist.

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Mail Sync", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      // offenes Dashboard-Tab bevorzugen, sonst neues öffnen
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (tab) {
        await tab.focus();
        tab.postMessage({ type: "open", url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
