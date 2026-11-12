import assert from "node:assert/strict";
import { browser, code, enroll, login, event } from "./runtime-helpers.mjs";
export async function routing(runtime) {
  const client = browser(runtime);
  for (const path of [
    "/",
    "/login",
    "/admin",
    "/api/other",
    "/quietstats-extra/",
    "/quietstats/fixture.html",
    "/quietstats/index.html",
    "/api/metrics/v1/issueSetupGrant",
  ])
    assert.equal((await client.request(path)).status, 404);
  assert.equal((await client.request("/quietstats")).status, 308);
  for (const path of ["/quietstats/admin", "/quietstats/access"])
    assert.equal((await client.request(path)).status, 303);
  for (const path of [
    "/quietstats/",
    "/quietstats/login",
    "/quietstats/setup",
    "/quietstats/recovery",
    "/quietstats/help",
    "/quietstats/privacy",
  ]) {
    const r = await client.request(path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.match(
      r.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    const text = await r.text();
    if (!path.endsWith("privacy")) assert.match(text, /\/quietstats\/assets\//);
  }
  const page = await (await client.request("/quietstats/login")).text();
  const asset = page.match(/src="(\/quietstats\/assets\/[^\"]+\.js)"/)[1];
  const js = await client.request(asset);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("cache-control"), /immutable/);
  assert.equal(
    (await client.request("/quietstats/", { method: "POST", body: {} })).status,
    405,
  );
}
export async function authentication(runtime, stub, clock, operator = stub) {
  const client = browser(runtime, "owner"),
    visitor = browser(runtime, "visitor");
  await client.challenge();
  assert.equal(
    (
      await client.api("/setup/exchange", {
        method: "POST",
        body: { grant: "unissued" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await visitor.api("/reports?from=2026-11-12&to=2026-11-12")).status,
    401,
  );
  assert.equal(
    (await visitor.api("/measure", { method: "POST", body: event })).status,
    403,
  );
  const owner = await enroll(client, stub, clock, operator);
  await login(client, stub, clock, owner.seed);
  assert.equal((await client.request("/quietstats/admin")).status, 200);
  const replay = browser(runtime, "replay");
  await replay.challenge();
  assert.equal(
    (
      await replay.api("/auth/login", {
        method: "POST",
        body: { code: code(owner.seed, clock.now) },
      })
    ).status,
    401,
  );
  assert.equal(
    (await client.api("/measure", { method: "POST", body: event })).status,
    403,
  );
  assert.equal(
    (
      await visitor.api("/measure", {
        method: "POST",
        body: event,
        headers: { origin: "https://other.example.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await client.api("/erase", {
        method: "POST",
        body: { through: "2026-01-01" },
        headers: { "x-csrf-token": "wrong" },
      })
    ).status,
    403,
  );
  return { client, visitor, owner };
}
export async function analytics(stub, state) {
  const { client, visitor } = state;
  const query = "/reports?from=2026-11-12&to=2026-11-12";
  const status = await client.json("/status");
  assert.equal(status.synthetic, false);
  assert.equal(status.runtime_mode, "production");
  assert.equal(status.measurement_mode, "disabled");
  await stub.setCollectionPolicy(true);
  for (let i = 0; i < 6; i++)
    assert.equal(
      (await visitor.api("/measure", { method: "POST", body: event })).status,
      204,
    );
  const report = await client.json(query);
  assert.ok(JSON.stringify(report).includes('"count":6'));
  const backup = await client.api("/backup", { method: "POST", body: {} });
  assert.equal(backup.status, 200);
  const archive = await backup.text();
  assert.ok(
    archive.length < 2000000 &&
      !archive.includes('"counts"') &&
      !archive.includes(state.owner.seed),
  );
  const before = await stub.testInspect();
  await stub.testCapacity({ encryptions: 999000 });
  assert.equal(
    (await visitor.api("/measure", { method: "POST", body: event })).status,
    204,
  );
  let after = await stub.testInspect();
  assert.equal(after.capacity.key_version, 2);
  assert.deepEqual(after.versions, [2]);
  assert.ok(after.key !== before.key && after.authority === before.authority);
  // An archive encrypted with the previous wrapped DEK restores under the new DEK.
  assert.equal(
    (await client.api("/restore", { method: "POST", body: { archive } }))
      .status,
    200,
  );
  assert.deepEqual(await client.json(query), report);
  assert.equal((await stub.testInspect()).candidate, 0);
  const tampered = JSON.parse(archive);
  tampered.mac = "invalid";
  assert.equal(
    (
      await client.api("/restore", {
        method: "POST",
        body: { archive: JSON.stringify(tampered) },
      })
    ).status,
    400,
  );
  const stable = await stub.testInspect();
  await stub.testFailWrite(true);
  await assert.rejects(stub.rotateDataKey());
  await stub.testFailWrite(false);
  after = await stub.testInspect();
  assert.ok(
    after.key === stable.key &&
      after.rows === stable.rows &&
      after.authority === stable.authority,
  );
  // Age rotation also runs on maintenance/reporting, before an expired key can encrypt.
  await stub.testCapacity({
    key_created: Date.UTC(2026, 10, 12, 12) - 89 * 86400000,
  });
  await client.json(query);
  assert.equal((await stub.testInspect()).capacity.key_version, 3);
  await stub.testOldPartition("2024-01-01");
  await client.json(query);
  assert.equal((await stub.testInspect()).count, 2);
  assert.equal((await client.json("/status")).storage.pruned_dates, 1);
  await stub.setCollectionPolicy(false);
  assert.equal(
    (await visitor.api("/measure", { method: "POST", body: event })).status,
    403,
  );
  return { archive, report, query };
}
export async function recovery(runtime, stub, clock, state, data) {
  const { client, owner } = state;
  const recoveryClient = browser(runtime, "recovery");
  const before = await stub.testInspect();
  await recoveryClient.challenge();
  assert.equal(
    (
      await recoveryClient.api("/recovery/start", {
        method: "POST",
        body: { recovery_code: owner.recovery[0] },
      })
    ).status,
    204,
  );
  recoveryClient.csrf = (await recoveryClient.json("/access/state")).csrf_token;
  assert.equal(
    (await recoveryClient.api("/reports?from=2026-11-12&to=2026-11-12")).status,
    401,
  );
  assert.equal(
    (await recoveryClient.request("/quietstats/access")).status,
    200,
  );
  const pending = await recoveryClient.json("/access/seed", {
    method: "POST",
    body: {},
  });
  await recoveryClient.json("/access/confirm", {
    method: "POST",
    body: { code: code(pending.seed, clock.now) },
  });
  const codes = await recoveryClient.json("/access/codes", {
    method: "POST",
    body: {},
  });
  clock.now += 30000;
  await stub.testClock(clock.now);
  assert.equal(
    (
      await recoveryClient.api("/access/commit", {
        method: "POST",
        body: {
          attempt_id: pending.attempt_id,
          codes_generation: codes.generation,
          codes_saved: true,
          code: code(pending.seed, clock.now),
        },
      })
    ).status,
    204,
  );
  assert.equal((await client.api("/auth/session")).status, 401);
  const newClient = browser(runtime, "replacement");
  await login(newClient, stub, clock, pending.seed);
  assert.equal((await stub.testInspect()).key, before.key);
  const authority = (await stub.testInspect()).authority;
  assert.equal(
    (
      await newClient.api("/restore", {
        method: "POST",
        body: { archive: data.archive },
      })
    ).status,
    200,
  );
  assert.equal((await stub.testInspect()).authority, authority);
  const spent = browser(runtime, "spent-code");
  await spent.challenge();
  assert.equal(
    (
      await spent.api("/recovery/start", {
        method: "POST",
        body: { recovery_code: owner.recovery[0] },
      })
    ).status,
    401,
  );
  return { client: newClient, seed: pending.seed };
}
export async function budget(stub, state) {
  const { client, visitor } = state;
  let stable = await stub.testInspect();
  for (const mode of ["stale", "future", "unknown", "full"]) {
    await stub.setCollectionPolicy(true);
    await stub.testMeter(mode);
    assert.equal(
      (await visitor.api("/measure", { method: "POST", body: event })).status,
      503,
    );
    await stub.testMeter("normal");
    const after = await stub.testInspect();
    assert.ok(
      stable.rows === after.rows &&
        stable.key === after.key &&
        stable.authority === after.authority,
    );
  }
  const physical = await stub.testPhysicalPressure();
  assert.ok(physical >= 5700000 && physical < 8388608);
  await stub.setCollectionPolicy(true);
  assert.equal(
    (await visitor.api("/measure", { method: "POST", body: event })).status,
    503,
  );
  const status = await client.json("/status");
  assert.equal(status.measurement_mode, "disabled");
  assert.match(status.blocked_reason, /Physical/);
  stable = await stub.testInspect();
  assert.equal(await stub.testHardBudgetRollback(), true);
  const after = await stub.testInspect();
  assert.ok(
    stable.rows === after.rows &&
      stable.key === after.key &&
      stable.authority === after.authority,
  );
  // DELETE removes logical analytics without claiming a smaller physical database.
  assert.equal(
    (
      await client.api("/erase", {
        method: "POST",
        body: { through: "2026-11-12" },
      })
    ).status,
    200,
  );
  const erased = await stub.testInspect();
  assert.equal(erased.count, 0);
  assert.ok(
    erased.physical >= stable.physical &&
      erased.key === stable.key &&
      erased.authority === stable.authority,
  );
  await client.session();
}
