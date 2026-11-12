import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSystem } from "../server/system.mjs";
import { createHandler } from "../server/http.mjs";
import { makeSecrets } from "../adapters/local/crypto.mjs";
import { TOTP, Secret } from "otpauth";
const root = join(process.cwd(), ".test-state");
mkdirSync(root, { recursive: true });
test("real Fetch HTTP boundary: private denial, strict schemas, CSRF, secure cookies, scope and aggregate projection", async () => {
  const dir = mkdtempSync(join(root, "http-"));
  let now = Date.UTC(2026, 10, 12, 12);
  const s = createSystem({
    dir,
    secrets: makeSecrets(),
    clock: () => now,
    synthetic: true,
  });
  const origin = "https://127.0.0.1:4318",
    handle = createHandler(s, { origin });
  let cookies = {};
  async function req(path, { method = "GET", body, csrf, headers = {} } = {}) {
    const h = {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      ...headers,
    };
    if (method === "POST") {
      h.origin = origin;
      h["content-type"] = "application/json";
    }
    if (csrf) h["x-csrf-token"] = csrf;
    h.cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const r = await handle(
      new Request(origin + "/api/metrics/v1" + path, {
        method,
        headers: h,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { source: "127.0.0.1" },
    );
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";"),
        [k, v] = pair.split("=");
      cookies[k] = v;
    }
    return r;
  }
  try {
    for (const p of [
      "/reports?from=2026-11-12&to=2026-11-12",
      "/export?from=2026-11-12&to=2026-11-12",
      "/status",
      "/nope",
    ]) {
      const r = await req(p);
      assert.ok(r.status >= 400);
      assert.match(r.headers.get("cache-control"), /no-store/);
    }
    const grant = s.access.issueGrant();
    let r = await req("/auth/challenge");
    assert.match(
      r.headers.get("set-cookie"),
      /Secure; HttpOnly; SameSite=Strict/,
    );
    assert.ok(!r.headers.get("set-cookie").includes("Domain="));
    let csrf = (await r.json()).csrf_token;
    assert.equal(
      (await req("/setup/exchange", { method: "POST", body: { grant } }))
        .status,
      403,
    );
    r = await req("/setup/exchange", { method: "POST", body: { grant }, csrf });
    assert.equal(r.status, 204);
    r = await req("/access/state");
    csrf = (await r.json()).csrf_token;
    assert.equal((await req("/status")).status, 401);
    r = await req("/access/seed", { method: "POST", body: {}, csrf });
    const seed = await r.json();
    const otp = () =>
      new TOTP({
        secret: Secret.fromBase32(seed.seed),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      }).generate({ timestamp: now });
    assert.equal(
      (
        await req("/access/confirm", {
          method: "POST",
          body: { code: otp() },
          csrf,
        })
      ).status,
      200,
    );
    const codes = await (
      await req("/access/codes", { method: "POST", body: {}, csrf })
    ).json();
    now += 30000;
    assert.equal(
      (
        await req("/access/commit", {
          method: "POST",
          body: {
            attempt_id: seed.attempt_id,
            codes_generation: codes.generation,
            codes_saved: true,
            code: otp(),
          },
          csrf,
        })
      ).status,
      204,
    );
    now += 30000;
    csrf = (await (await req("/auth/challenge")).json()).csrf_token;
    r = await req("/auth/login", {
      method: "POST",
      body: { code: otp() },
      csrf,
    });
    assert.equal(r.status, 204);
    csrf = (await (await req("/auth/session")).json()).csrf_token;
    assert.equal((await req("/status")).status, 200);
    assert.equal(
      (
        await req("/measure", {
          method: "POST",
          body: { schema_version: 2, type: "route_view", route_id: "landing" },
        })
      ).status,
      403,
    );
    const ownerCookies = cookies;
    cookies = {};
    assert.equal(
      (
        await req("/measure", {
          method: "POST",
          body: {
            schema_version: 2,
            type: "route_view",
            route_id: "landing",
            extra: 1,
          },
        })
      ).status,
      400,
    );
    for (let i = 0; i < 6; i++)
      assert.equal(
        (
          await req("/measure", {
            method: "POST",
            body: {
              schema_version: 2,
              type: "route_view",
              route_id: "landing",
            },
          })
        ).status,
        204,
      );
    cookies = ownerCookies;
    r = await req("/reports?from=2026-11-12&to=2026-11-12");
    assert.equal((await r.json()).total, 6);
    assert.equal(
      (await req("/export?from=2026-11-12&to=2026-11-12", { csrf })).status,
      200,
    );
    assert.equal(
      (await req("/auth/logout", { method: "POST", body: {}, csrf })).status,
      204,
    );
    assert.equal((await req("/status")).status, 401);
    const hostile = await handle(
      new Request(origin + "/api/metrics/v1/auth/challenge", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      { source: "x" },
    );
    assert.equal(hostile.status, 403);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
