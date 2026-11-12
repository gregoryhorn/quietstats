import { test } from "node:test";
import assert from "node:assert/strict";
import { attachReporter } from "../client/reporter.mjs";
test("reporter quiet policies, remount, visible current-only, utilities and bfcache", () => {
  let route = "landing",
    visible = true,
    dnt = "0",
    gpc = false;
  const listeners = new Set(),
    life = new Set(),
    sent = [];
  const env = {
      visible: () => visible,
      signals: () => ({ dnt, gpc }),
      subscribe: (fn) => (life.add(fn), () => life.delete(fn)),
    },
    source = {
      current: () => route,
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    };
  const go = (id) => {
      route = id;
      for (const f of listeners) f();
    },
    show = (v) => {
      visible = v;
      for (const f of life) f();
    };
  const options = {
    source,
    env,
    ids: ["landing", "library", "studio"],
    enabled: true,
    policy: "synthetic",
    send: (e) => sent.push(e),
  };
  let stop = attachReporter(options);
  assert.equal(sent.length, 1);
  go("landing");
  stop();
  stop = attachReporter(options);
  assert.equal(sent.length, 1);
  go(null);
  go("landing");
  assert.equal(sent.length, 1);
  show(false);
  go("library");
  go("studio");
  show(true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].route_id, "studio");
  dnt = "1";
  go("library");
  assert.equal(sent.length, 2);
  dnt = null;
  go("landing");
  assert.equal(sent.length, 2);
  dnt = "0";
  gpc = true;
  go("library");
  assert.equal(sent.length, 2);
  stop();
  assert.deepEqual(Object.keys(sent[0]), [
    "schema_version",
    "type",
    "route_id",
  ]);
});

test("reporter qualified aggregate mode is explicit, default off and preserves privacy refusal", () => {
  for (const policy of [
    "unknown",
    "synthetic",
    "qualified-aggregate",
    "production",
  ]) {
    for (const enabled of [true, false]) {
      for (const signals of [
        { dnt: "0", gpc: false },
        { dnt: "1", gpc: false },
        { dnt: null, gpc: false },
        { dnt: "0", gpc: true },
        { dnt: "0", gpc: undefined },
      ]) {
        const sent = [];
        const stop = attachReporter({
          source: { current: () => "home", subscribe: () => () => {} },
          env: {
            visible: () => true,
            signals: () => signals,
            subscribe: () => () => {},
          },
          ids: ["home"],
          enabled,
          policy,
          send: (event) => sent.push(event),
        });
        assert.equal(
          sent.length,
          enabled &&
            ["synthetic", "qualified-aggregate"].includes(policy) &&
            signals.dnt === "0" &&
            signals.gpc === false
            ? 1
            : 0,
        );
        stop();
      }
    }
  }
});

test("browser reporter supports injected home/utility route source and same-origin bounded sending", async () => {
  const { browserReporter } = await import("../client/reporter.mjs");
  const { readFileSync } = await import("node:fs");
  assert.equal(
    readFileSync("public/reporter.mjs", "utf8"),
    readFileSync("client/reporter.mjs", "utf8"),
  );
  const originals = Object.fromEntries(
    ["window", "document", "navigator", "location", "fetch"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  const events = () => {
    const listeners = new Map();
    return {
      addEventListener: (key, fn) => {
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(fn);
      },
      removeEventListener: (key, fn) => listeners.get(key)?.delete(fn),
      emit: (key) => {
        for (const fn of listeners.get(key) || []) fn();
      },
    };
  };
  const window = events(),
    document = { ...events(), visibilityState: "visible" },
    location = { hash: "" },
    sent = [];
  let route = null;
  const globals = {
    window,
    document,
    location,
    navigator: { doNotTrack: "0", globalPrivacyControl: false },
    fetch: (path, options) => {
      sent.push({ path, options });
      return Promise.reject(Error("No retry"));
    },
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const routes = [
    { id: "home" },
    ...Array.from({ length: 17 }, (_, i) => ({ id: "route" + (i + 1) })),
  ];
  let stop;
  try {
    // Utility/private source null is never replaced by a landing/home default.
    stop = browserReporter({
      routes,
      enabled: true,
      policy: "qualified-aggregate",
      defaultRoute: "home",
      readRoute: () => route,
    });
    assert.equal(sent.length, 0);
    route = "home";
    window.emit("hashchange");
    assert.equal(sent.length, 1);
    route = null;
    window.emit("hashchange");
    route = "private-utility";
    window.emit("hashchange");
    assert.equal(sent.length, 1);
    document.visibilityState = "hidden";
    route = "route1";
    window.emit("hashchange");
    route = "route2";
    window.emit("hashchange");
    document.visibilityState = "visible";
    document.emit("visibilitychange");
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(sent[1].options.body).route_id, "route2");
    window.emit("pageshow");
    await Promise.resolve();
    assert.equal(sent.length, 2);
    for (const { path, options } of sent) {
      assert.equal(path, "/api/metrics/v1/measure");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.keepalive, false);
      assert.equal(options.cache, "no-store");
      assert.equal(options.headers["content-type"], "application/json");
      assert.deepEqual(Object.keys(JSON.parse(options.body)), [
        "schema_version",
        "type",
        "route_id",
      ]);
    }
    stop();
    delete window.quietstatsRouteEnvironment;
    stop = browserReporter({ routes, enabled: true, defaultRoute: "home" });
    assert.equal(sent.length, 2); // An enabled boolean does not choose a policy.
    stop();
    delete window.quietstatsRouteEnvironment;
    stop = browserReporter({
      routes,
      enabled: true,
      policy: "qualified-aggregate",
      defaultRoute: "home",
    });
    assert.equal(JSON.parse(sent.at(-1).options.body).route_id, "home");
  } finally {
    stop?.();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
