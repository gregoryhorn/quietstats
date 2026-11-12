import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeText } from "../scripts/check-source.mjs";
import { createHandler } from "../server/http.mjs";
import { createSystem } from "../server/system.mjs";
import { makeSecrets } from "../adapters/local/crypto.mjs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
test("sanitised source boundary scanner rejects plain/escaped/encoded negative fixtures without echo", () => {
  const denied = ["synthetic-private.example.invalid"];
  for (const text of [
    denied[0].toUpperCase(),
    denied[0].replaceAll(".", "%2e"),
    denied[0].replaceAll(".", "\\u002e"),
    Buffer.from(denied[0]).toString("base64"),
  ])
    assert.equal(safeText(text, denied), false);
  assert.equal(safeText("Generic safe configuration", denied), true);
});
test("public privacy is static, normal-page controls; core has no provider imports", () => {
  const privacy = readFileSync("public/privacy.html", "utf8");
  assert.match(privacy, /Local example template/);
  assert.ok(!/<form|<dialog|aria-modal|role="dialog"/.test(privacy));
  const ui = readFileSync("client/main.jsx", "utf8");
  assert.match(ui, /aria-label="Admin"/);
  assert.match(ui, /aria-label="Privacy"/);
  for (const file of ["access", "data", "contracts"])
    assert.ok(
      !/from\s*["'][^"']*(?:adapters|cloudflare|server|node:)/.test(
        readFileSync(`core/${file}.mjs`, "utf8"),
      ),
    );
});
test("HTTP abuse bounds, methods, media, query and cross-origin fail closed", async () => {
  const root = join(process.cwd(), ".test-state");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "abuse-"));
  const s = createSystem({ dir, secrets: makeSecrets(), synthetic: true });
  try {
    const origin = "https://127.0.0.1:4318",
      handler = createHandler(s, { origin });
    const req = async (
      path,
      { method = "POST", headers = {}, body = "{}" } = {},
    ) =>
      handler(
        new Request(origin + "/api/metrics/v1" + path, {
          method,
          headers: {
            origin,
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            ...headers,
          },
          ...(["GET", "HEAD"].includes(method) ? {} : { body }),
        }),
        { source: "source" },
      );
    assert.equal(
      (await req("/measure", { body: "x".repeat(513) })).status,
      413,
    );
    assert.equal(
      (await req("/measure", { headers: { "content-type": "text/plain" } }))
        .status,
      415,
    );
    assert.equal(
      (await req("/measure", { headers: { "content-encoding": "gzip" } }))
        .status,
      415,
    );
    assert.equal((await req("/measure", { method: "OPTIONS" })).status, 405);
    assert.equal((await req("/measure?debug=1")).status, 400);
    assert.equal(
      (
        await req("/measure", {
          headers: { origin: "https://other.example.invalid" },
        })
      ).status,
      403,
    );
    assert.equal((await req("/measure", { body: "[]" })).status, 400);
    assert.equal(
      (
        await req("/measure", {
          body: JSON.stringify({
            schema_version: 1,
            type: "route_view",
            route_id: "landing",
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await req("/auth/challenge?secret=x", { method: "GET" })).status,
      400,
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed body cannot cross a collection-disable fence; quota and overflow stop atomically", async () => {
  const root = join(process.cwd(), ".test-state"),
    dir = mkdtempSync(join(root, "fence-"));
  const s = createSystem({ dir, secrets: makeSecrets(), synthetic: true });
  try {
    const origin = "https://127.0.0.1:4318",
      handler = createHandler(s, { origin });
    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    const pending = handler(
      new Request(origin + "/api/metrics/v1/measure", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
        },
        body: stream,
        duplex: "half",
      }),
      { source: "x" },
    );
    s.data.setPolicy(false);
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 2,
          type: "route_view",
          route_id: "landing",
        }),
      ),
    );
    controller.close();
    assert.equal((await pending).status, 403);
    assert.equal(s.store.rows().length, 0);
    s.data.setPolicy(true);
    s.store.tx(() => {
      const c = s.data.state();
      c.requests = 2000;
      s.store.set("capacity", c);
    });
    assert.throws(
      () =>
        s.data.collect(
          { schema_version: 2, type: "route_view", route_id: "landing" },
          "x",
        ),
      (e) => e.status === 429,
    );
    assert.equal(s.store.rows().length, 0);
    s.store.tx(() => {
      const c = s.data.state();
      c.requests = 0;
      s.store.set("capacity", c);
    });
    const day = new Date(s.now()).toISOString().slice(0, 10);
    s.data.writePartition({
      day,
      counts: { landing: 2147483647, library: 0, studio: 0 },
    });
    const before = JSON.stringify(s.store.rows());
    assert.throws(() =>
      s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "x",
      ),
    );
    assert.equal(JSON.stringify(s.store.rows()), before);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
