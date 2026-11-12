import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createSystem } from "../server/system.mjs";
import { makeSecrets, makeCrypto } from "../adapters/local/crypto.mjs";
import { TOTP, Secret } from "otpauth";
import { createHandler } from "../server/http.mjs";
const root = join(process.cwd(), ".test-state");
mkdirSync(root, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(root, "security-"));
  let now = Date.UTC(2026, 10, 12, 12),
    secrets = makeSecrets(),
    options = { dir, secrets, clock: () => now, synthetic: true };
  return {
    dir,
    options,
    s: createSystem(options),
    now: () => now,
    tick: (n) => (now += n ?? 30000),
    close() {
      this.s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const otp = (seed, time) =>
  new TOTP({
    secret: Secret.fromBase32(seed),
    digits: 6,
    algorithm: "SHA1",
    period: 30,
  }).generate({ timestamp: time });
function setup(f) {
  const pre = f.s.access.challenge(),
    grant = f.s.access.issueGrant(),
    a = f.s.access.exchange(pre.token, pre.csrf, grant, "setup");
  const seed = f.s.access.seed(a.token, a.csrf);
  f.s.access.confirm(a.token, a.csrf, otp(seed.seed, f.now()));
  const codes = f.s.access.codes(a.token, a.csrf);
  f.tick();
  f.s.access.commit(a.token, a.csrf, {
    attempt_id: seed.attempt_id,
    codes_generation: codes.generation,
    codes_saved: true,
    code: otp(seed.seed, f.now()),
  });
  return { seed: seed.seed, codes: codes.codes };
}
function log(f, seed, source) {
  const p = f.s.access.challenge();
  return f.s.access.login(p.token, p.csrf, otp(seed, f.now()), source);
}
test("RFC6238 vectors and leading zero; skew and high-water collision/clock rollback", () => {
  const c = makeCrypto(makeSecrets());
  const seed = Secret.fromUTF8("12345678901234567890").base32;
  for (const [seconds, expected] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])
    assert.ok(c.matches(seed, expected, seconds * 1000).length === 1);
  const f = fixture();
  try {
    const old = setup(f);
    f.tick();
    const p = f.s.access.challenge();
    const future = otp(old.seed, f.now() + 30000);
    assert.ok(f.s.access.login(p.token, p.csrf, future, "s"));
    f.tick();
    const p2 = f.s.access.challenge();
    assert.throws(() => f.s.access.login(p2.token, p2.csrf, future, "s"));
    const high = f.s.store.get("authority").last;
    f.s.crypto.matches = () => [high, high + 1];
    assert.throws(() =>
      f.s.access.step(old.seed, "000000", -1) === 0
        ? null
        : f.s.access.step(old.seed, "000000", high),
    );
    f.tick(-120000);
    assert.throws(() => f.s.access.challenge());
  } finally {
    f.close();
  }
});
test("durable throttles survive restart and expire; max5 normal sessions; idle/absolute and explicit touch", () => {
  const f = fixture();
  try {
    const old = setup(f);
    f.tick();
    const pre = f.s.access.challenge();
    for (let i = 0; i < 3; i++)
      assert.throws(() => f.s.access.login(pre.token, pre.csrf, "x", "same"));
    f.s.close();
    f.s = createSystem(f.options);
    assert.throws(
      () =>
        f.s.access.login(pre.token, pre.csrf, otp(old.seed, f.now()), "same"),
      (e) => e.status === 429,
    );
    f.tick(300001);
    const sessions = [];
    for (let i = 0; i < 6; i++) {
      f.tick();
      sessions.push(log(f, old.seed, "source" + i));
    }
    assert.throws(() => f.s.access.authorize(sessions[0].token, "normal"));
    const newest = sessions.at(-1);
    assert.ok(f.s.access.authorize(newest.token, "normal"));
    f.tick(590000);
    f.s.access.touch(newest.token, newest.csrf);
    f.tick(590000);
    assert.ok(f.s.access.authorize(newest.token, "normal"));
    f.tick(700000);
    assert.throws(() => f.s.access.authorize(newest.token, "normal"));
  } finally {
    f.close();
  }
});
test("two durable connections with concurrent HTTP login accept one; restart replay stays spent", async () => {
  const f = fixture();
  let second;
  try {
    const old = setup(f);
    f.tick();
    const p1 = f.s.access.challenge(),
      p2 = f.s.access.challenge();
    second = createSystem(f.options);
    const origin = "https://127.0.0.1:4318";
    const request = (p) =>
      new Request(origin + "/api/metrics/v1/auth/login", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "x-csrf-token": p.csrf,
          cookie: "__Host-qs_pre=" + p.token,
        },
        body: JSON.stringify({ code: otp(old.seed, f.now()) }),
      });
    const results = await Promise.all([
      createHandler(f.s, { origin })(request(p1), { source: "a" }),
      createHandler(second, { origin })(request(p2), { source: "b" }),
    ]);
    assert.equal(results.filter((r) => r.status === 204).length, 1);
    assert.equal(results.filter((r) => r.status === 401).length, 1);
    second.close();
    second = null;
    f.s.close();
    f.s = createSystem(f.options);
    assert.throws(() => log(f, old.seed, "c"));
    assert.equal(
      f.s.store.get("sessions").filter((x) => x.kind === "normal").length,
      1,
    );
  } finally {
    second?.close();
    f.close();
  }
});
test("recovery expiry, grant replay, pending interruption and final transaction rollback preserve all-old", () => {
  const f = fixture();
  try {
    const old = setup(f),
      pre = f.s.access.challenge(),
      r = f.s.access.recover(pre.token, pre.csrf, old.codes[0], "r");
    const pending = f.s.access.seed(r.token, r.csrf);
    f.s.access.confirm(r.token, r.csrf, otp(pending.seed, f.now()));
    const codes = f.s.access.codes(r.token, r.csrf);
    f.s.close();
    f.s = createSystem(f.options);
    assert.equal(f.s.access.accessState(r.token).stage, "codes");
    f.tick();
    const before = f.s.store.get("authority");
    const original = f.s.store.set.bind(f.s.store);
    f.s.store.set = (k, v) => {
      if (k === "sessions") throw Error("injected persistence fault");
      original(k, v);
    };
    assert.throws(() =>
      f.s.access.commit(r.token, r.csrf, {
        attempt_id: pending.attempt_id,
        codes_generation: codes.generation,
        codes_saved: true,
        code: otp(pending.seed, f.now()),
      }),
    );
    f.s.store.set = original;
    assert.deepEqual(f.s.store.get("authority"), before);
    f.tick(600001);
    assert.throws(() => f.s.access.seed(r.token, r.csrf));
    assert.ok(log(f, old.seed, "old"));
    assert.throws(() => {
      const p = f.s.access.challenge();
      f.s.access.recover(p.token, p.csrf, old.codes[0], "r");
    });
  } finally {
    f.close();
  }
});
test("backup restores real totals, wrong key/missing key fail, OOB auth replacement never rolls back", () => {
  const f = fixture();
  try {
    const old = setup(f);
    for (let i = 0; i < 7; i++)
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "s",
      );
    const q = { from: "2026-11-12", to: "2026-11-12" },
      archive = f.s.data.backup();
    const dataKey = f.s.store.get("data_key");
    f.s.data.collect(
      { schema_version: 2, type: "route_view", route_id: "landing" },
      "s",
    );
    assert.equal(f.s.data.report(q).total, 8);
    f.s.data.restore(archive);
    assert.equal(f.s.data.report(q).total, 7);
    const epoch = f.s.store.get("authority").epoch;
    f.s.access.issueGrant(true);
    assert.equal(f.s.store.get("authority").epoch, epoch + 1);
    f.s.data.restore(archive);
    assert.equal(f.s.store.get("authority").epoch, epoch + 1);
    assert.equal(f.s.store.get("authority").seed, null);
    assert.deepEqual(dataKey, f.s.store.get("data_key"));
    const wrong = makeCrypto(makeSecrets());
    assert.throws(() => wrong.open("DATA_KEK", dataKey, "analytics-dek|1"));
    assert.throws(() => makeCrypto({}));
  } finally {
    f.close();
  }
});
test("automatic oldest-date pruning, physical admission, no shrink credit, no credential pruning", () => {
  const f = fixture();
  try {
    setup(f);
    const counts = { landing: 9, library: 0, studio: 0 };
    f.s.data.writePartition({ day: "2024-01-01", counts });
    const auth = f.s.store.get("authority");
    f.s.data.maintain();
    assert.equal(f.s.store.rows().length, 0);
    assert.equal(f.s.data.state().cutoff >= "2024-01-01", true);
    assert.deepEqual(f.s.store.get("authority"), auth);
    const original = f.s.store.meter.bind(f.s.store);
    f.s.store.meter = () => ({
      bytes: 16000000,
      database_bytes: 5900000,
      at: f.now(),
    });
    assert.throws(() =>
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "x",
      ),
    );
    assert.equal(f.s.data.state().enabled, false);
    assert.deepEqual(f.s.store.get("authority"), auth);
    f.s.store.meter = original;
    f.s.data.setPolicy(true);
    f.s.data.collect(
      { schema_version: 2, type: "route_view", route_id: "landing" },
      "x",
    );
    const before = f.s.store.meter().database_bytes;
    f.s.data.erase("2026-11-12");
    assert.ok(f.s.store.meter().database_bytes >= before);
    assert.equal(f.s.data.status().storage.delete_reclaims_allocation, false);
  } finally {
    f.close();
  }
});

test("single-use grant and competing recovery starts; stale meter cannot admit data", () => {
  const f = fixture();
  try {
    const grant = f.s.access.issueGrant(),
      p = f.s.access.challenge();
    const a = f.s.access.exchange(p.token, p.csrf, grant, "one");
    const p2 = f.s.access.challenge();
    assert.throws(() => f.s.access.exchange(p2.token, p2.csrf, grant, "two"));
    f.s.access.cancel(a.token, a.csrf);
    const old = setup(f),
      r1 = f.s.access.challenge(),
      r2 = f.s.access.challenge();
    f.s.access.recover(r1.token, r1.csrf, old.codes[0], "r1");
    assert.throws(
      () => f.s.access.recover(r2.token, r2.csrf, old.codes[1], "r2"),
      (e) => e.status === 409,
    );
    assert.equal(
      f.s.store.get("authority").codes.filter((x) => x.used).length,
      1,
    );
    f.s.store.meter = () => ({
      bytes: 30000,
      database_bytes: 20000,
      at: f.now() - 60001,
    });
    assert.throws(() =>
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "x",
      ),
    );
    assert.equal(f.s.store.rows().length, 0);
  } finally {
    f.close();
  }
});

test("bounded source flood retains no raw network identity and refuses new live buckets", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 512; i++) f.s.access.rate("192.0.2." + i, "measure");
    const before = f.s.store.get("limits");
    assert.throws(
      () => f.s.access.rate("overflow-source", "measure"),
      (e) => e.status === 429,
    );
    assert.equal(f.s.store.get("limits").length, before.length);
    assert.ok(
      !readFileSync(join(f.dir, "state.sqlite")).includes(
        Buffer.from("192.0.2."),
      ),
    );
    f.tick(86400001);
    f.s.access.rate("new-day", "measure");
    assert.ok(f.s.store.get("limits").length < 10);
  } finally {
    f.close();
  }
});

test("actual SQLite physical page cap stops growth without deleting authority or key registry", () => {
  const f = fixture();
  try {
    setup(f);
    const auth = f.s.store.get("authority"),
      key = f.s.store.get("data_key");
    f.s.store.db.exec("CREATE TABLE pressure(value BLOB)");
    const insert = f.s.store.db.prepare(
      "INSERT INTO pressure VALUES(zeroblob(65536))",
    );
    let failed = false;
    for (let i = 0; i < 150; i++) {
      try {
        insert.run();
      } catch {
        failed = true;
        break;
      }
    }
    assert.ok(failed);
    const meter = f.s.store.meter();
    assert.ok(meter.database_bytes <= 8388608);
    assert.deepEqual(f.s.store.get("authority"), auth);
    assert.deepEqual(f.s.store.get("data_key"), key);
    assert.throws(() =>
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "x",
      ),
    );
    assert.deepEqual(f.s.store.get("authority"), auth);
  } finally {
    f.close();
  }
});
