import assert from "node:assert/strict";
import { TOTP, Secret } from "otpauth";
export const origin = "https://runtime.example.invalid";
export const apiBase = "/api/metrics/v1";
export const event = {
  schema_version: 2,
  type: "route_view",
  route_id: "landing",
};
export function code(seed, now) {
  return new TOTP({
    secret: Secret.fromBase32(seed),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  }).generate({ timestamp: now });
}
export function browser(runtime, source = "test-client") {
  const jar = new Map();
  return {
    csrf: undefined,
    async request(path, { method = "GET", body, headers = {} } = {}) {
      const res = await runtime.dispatchFetch(origin + path, {
        method,
        redirect: "manual",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "cf-connecting-ip": source,
          cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(";"),
          index = pair.indexOf("=");
        const name = pair.slice(0, index),
          value = pair.slice(index + 1);
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
      return res;
    },
    async api(path, options) {
      return this.request(apiBase + path, options);
    },
    async json(path, options) {
      const r = await this.api(path, options);
      assert.equal(
        r.status,
        200,
        "Expected successful JSON response at " + path.split("?")[0],
      );
      return r.json();
    },
    async challenge() {
      this.csrf = (await this.json("/auth/challenge")).csrf_token;
    },
    async session() {
      this.csrf = (await this.json("/auth/session")).csrf_token;
    },
  };
}
export async function enroll(client, stub, clock, operator = stub) {
  await client.challenge();
  // No first-visitor setup: only a private namespace RPC can mint this grant.
  const grant = await operator.issueSetupGrant();
  assert.equal(
    (await client.api("/setup/exchange", { method: "POST", body: { grant } }))
      .status,
    204,
  );
  const state = await client.json("/access/state");
  client.csrf = state.csrf_token;
  const seed = await client.json("/access/seed", { method: "POST", body: {} });
  assert.equal(seed.issuer, "QuietStats");
  assert.equal(
    (
      await client.json("/access/confirm", {
        method: "POST",
        body: { code: code(seed.seed, clock.now) },
      })
    ).stage,
    "confirmed",
  );
  const codes = await client.json("/access/codes", {
    method: "POST",
    body: {},
  });
  clock.now += 30000;
  await stub.testClock(clock.now);
  assert.equal(
    (
      await client.api("/access/commit", {
        method: "POST",
        body: {
          attempt_id: seed.attempt_id,
          codes_generation: codes.generation,
          codes_saved: true,
          code: code(seed.seed, clock.now),
        },
      })
    ).status,
    204,
  );
  return { seed: seed.seed, recovery: codes.codes };
}
export async function login(client, stub, clock, seed) {
  clock.now += 30000;
  await stub.testClock(clock.now);
  await client.challenge();
  assert.equal(
    (
      await client.api("/auth/login", {
        method: "POST",
        body: { code: code(seed, clock.now) },
      })
    ).status,
    204,
  );
  await client.session();
}
