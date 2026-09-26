self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    /* Keep notification body private when payload is not JSON. */
  }
  const options = {
    body: payload.body || "工作空间有新的进展，点击查看。",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag || payload.sessionId || "agentpanel",
    data: { sessionId: payload.sessionId, url: payload.url },
  };
  event.waitUntil(self.registration.showNotification(payload.title || "AgentPanel", options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL("/", self.location.origin);
  if (event.notification.data?.sessionId)
    url.searchParams.set("session", event.notification.data.sessionId);
  // A notification payload must never open another origin.
  if (event.notification.data?.url) {
    try {
      const candidate = new URL(event.notification.data.url, self.location.origin);
      if (candidate.origin === self.location.origin) url = candidate;
    } catch {}
  }
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(url.href);
          return client.focus();
        }
      }
      return clients.openWindow(url.href);
    }),
  );
});
