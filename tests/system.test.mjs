import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSystem } from "../server/system.mjs";
import { makeSecrets, makeCrypto } from "../adapters/local/crypto.mjs";
import { TOTP, Secret } from "otpauth";
const base = join(process.cwd(), ".test-state");
import { mkdirSync } from "node:fs";
mkdirSync(base, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(base, "unit-"));
  let now = Date.UTC(2026, 10, 12, 12);
  const secrets = makeSecrets();
  const options = { dir, secrets, clock: () => now, synthetic: true };
  const s = createSystem(options);
  return {
    s,
    dir,
    secrets,
    options,
    tick: (n = 30000) => (now += n),
    close() {
      this.s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function code(seed, time) {
  return new TOTP({
    secret: Secret.fromBase32(seed),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  }).generate({ timestamp: time });
}
function enroll(f) {
  const grant = f.s.access.issueGrant();
  const pre = f.s.access.challenge();
  const a = f.s.access.exchange(pre.token, pre.csrf, grant, "source");
  const seed = f.s.access.seed(a.token, a.csrf);
  f.s.access.confirm(a.token, a.csrf, code(seed.seed, f.s.now()));
  const codes = f.s.access.codes(a.token, a.csrf);
  f.tick();
  f.s.access.commit(a.token, a.csrf, {
    attempt_id: seed.attempt_id,
    codes_generation: codes.generation,
    codes_saved: true,
    code: code(seed.seed, f.s.now()),
  });
  return { seed: seed.seed, codes: codes.codes };
}
function login(f, seed) {
  f.tick();
  const p = f.s.access.challenge();
  return f.s.access.login(p.token, p.csrf, code(seed, f.s.now()), "source");
}
test("setup restricted, durable replay, max sessions, expiry, rollback and ciphertext", () => {
  const f = fixture();
  try {
    const old = enroll(f);
    let session = login(f, old.seed);
    assert.equal(f.s.access.authorize(session.token, "normal").epoch, 1);
    const p = f.s.access.challenge();
    assert.throws(() =>
      f.s.access.login(p.token, p.csrf, code(old.seed, f.s.now()), "other"),
    );
    f.s.data.collect(
      { schema_version: 2, type: "route_view", route_id: "landing" },
      "source",
    );
    assert.ok(
      !readFileSync(join(f.dir, "state.sqlite")).includes(
        Buffer.from(old.seed),
      ),
    );
    f.s.close();
    f.s = createSystem(f.options);
    assert.throws(() =>
      f.s.access.login(p.token, p.csrf, code(old.seed, f.s.now()), "other"),
    );
    f.tick(600001);
    assert.throws(() => f.s.access.authorize(session.token, "normal"));
  } finally {
    f.close();
  }
});
test("recovery cancel all-old, code consumed; commit all-new, data key and backup continuity", () => {
  const f = fixture();
  try {
    const old = enroll(f);
    const normal = login(f, old.seed);
    for (let i = 0; i < 6; i++)
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "source",
      );
    const before = f.s.data.report({ from: "2026-11-12", to: "2026-11-12" });
    const archive = f.s.data.backup();
    const key = f.s.store.get("data_key");
    let pre = f.s.access.challenge(),
      r = f.s.access.recover(pre.token, pre.csrf, old.codes[0], "r");
    assert.throws(() => f.s.access.authorize(r.token, "normal"));
    f.s.access.cancel(r.token, r.csrf);
    pre = f.s.access.challenge();
    assert.throws(() =>
      f.s.access.recover(pre.token, pre.csrf, old.codes[0], "r"),
    );
    pre = f.s.access.challenge();
    r = f.s.access.recover(pre.token, pre.csrf, old.codes[1], "r");
    const pending = f.s.access.seed(r.token, r.csrf);
    f.s.access.confirm(r.token, r.csrf, code(pending.seed, f.s.now()));
    const stale = f.s.access.codes(r.token, r.csrf),
      fresh = f.s.access.codes(r.token, r.csrf);
    f.tick();
    assert.throws(() =>
      f.s.access.commit(r.token, r.csrf, {
        attempt_id: pending.attempt_id,
        codes_generation: stale.generation,
        codes_saved: true,
        code: code(pending.seed, f.s.now()),
      }),
    );
    f.s.access.commit(r.token, r.csrf, {
      attempt_id: pending.attempt_id,
      codes_generation: fresh.generation,
      codes_saved: true,
      code: code(pending.seed, f.s.now()),
    });
    assert.throws(() => f.s.access.authorize(normal.token, "normal"));
    assert.deepEqual(f.s.store.get("data_key"), key);
    assert.deepEqual(
      f.s.data.report({ from: "2026-11-12", to: "2026-11-12" }).rows,
      before.rows,
    );
    assert.ok(login(f, pending.seed));
    f.s.data.erase("2026-11-12");
    f.s.data.restore(archive);
    assert.equal(
      f.s.data.report({ from: "2026-11-12", to: "2026-11-12" }).total,
      null,
    );
  } finally {
    f.close();
  }
});
test("AEAD AAD/wrong key/tamper and bounded backup fail closed", () => {
  const f = fixture();
  try {
    const c = makeCrypto(f.secrets);
    const e = c.seal("DATA_KEK", { x: 1 }, "a");
    assert.deepEqual(c.open("DATA_KEK", e, "a"), { x: 1 });
    assert.throws(() => c.open("DATA_KEK", e, "b"));
    assert.throws(() => makeCrypto(makeSecrets()).open("DATA_KEK", e, "a"));
    const b = f.s.data.backup();
    let bad = Buffer.from(b);
    bad[bad.length - 5] ^= 1;
    assert.throws(() => f.s.data.restore(bad));
    assert.throws(() => f.s.data.restore(Buffer.alloc(2_000_001)));
  } finally {
    f.close();
  }
});
test("collection disabled by default; physical uncertainty and budget deny with preserved authority", () => {
  const f = fixture();
  try {
    const old = enroll(f);
    f.s.data.setPolicy(false);
    assert.throws(() =>
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "s",
      ),
    );
    f.s.data.setPolicy(true);
    f.s.store.meter = () => ({ bytes: NaN, at: f.s.now() });
    assert.throws(() =>
      f.s.data.collect(
        { schema_version: 2, type: "route_view", route_id: "landing" },
        "s",
      ),
    );
    assert.ok(f.s.store.get("authority").seed);
  } finally {
    f.close();
  }
});
