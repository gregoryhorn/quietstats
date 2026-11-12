const memory = new WeakMap();
export function attachReporter({
  source,
  env,
  ids,
  enabled = false,
  policy = "unknown",
  send,
}) {
  let state = memory.get(env);
  if (!state) {
    state = { last: null };
    memory.set(env, state);
  }
  let stopped = false;
  function consider() {
    if (stopped || !env.visible()) return;
    const id = source.current();
    if (!ids.includes(id)) return;
    if (id === state.last) return;
    state.last = id;
    const { dnt, gpc } = env.signals();
    if (
      !enabled ||
      !["synthetic", "qualified-aggregate"].includes(policy) ||
      dnt !== "0" ||
      gpc !== false
    )
      return;
    try {
      const result = send({
        schema_version: 2,
        type: "route_view",
        route_id: id,
      });
      result?.catch?.(() => {});
    } catch {}
  }
  const offSource = source.subscribe(consider),
    offLife = env.subscribe(consider);
  consider();
  return () => {
    stopped = true;
    offSource();
    offLife();
  };
}
export function browserReporter({
  routes,
  enabled = false,
  policy = "unknown",
  defaultRoute = "landing",
  readRoute,
}) {
  const ids = routes.map((r) => r.id),
    source = {
      current: () => {
        const id = readRoute
          ? readRoute()
          : location.hash.slice(1) || defaultRoute;
        return ids.includes(id) ? id : null;
      },
      subscribe(fn) {
        window.addEventListener("hashchange", fn);
        return () => window.removeEventListener("hashchange", fn);
      },
    };
  // One document-lifetime environment retains deduplication across host remounts.
  const env = (window.quietstatsRouteEnvironment ||= {
    visible: () => document.visibilityState === "visible",
    signals: () => ({
      dnt: navigator.doNotTrack,
      gpc: navigator.globalPrivacyControl,
    }),
    subscribe(fn) {
      document.addEventListener("visibilitychange", fn);
      window.addEventListener("pageshow", fn);
      return () => {
        document.removeEventListener("visibilitychange", fn);
        window.removeEventListener("pageshow", fn);
      };
    },
  });
  return attachReporter({
    source,
    env,
    ids,
    enabled,
    policy,
    send: (event) =>
      fetch("/api/metrics/v1/measure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        credentials: "same-origin",
        cache: "no-store",
        keepalive: false,
      }),
  });
}
