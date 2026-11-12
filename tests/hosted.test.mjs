import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AuthorityStore } from "../adapters/cloudflare/authority-store.mjs";
import { configuration } from "../adapters/cloudflare/config.mjs";
import { serveAssets } from "../adapters/cloudflare/assets.mjs";
import { makeSecrets, makeCrypto } from "../adapters/local/crypto.mjs";
import { DataService } from "../core/data.mjs";
import { AccessService } from "../core/access.mjs";
const routes = [
  { id: "landing", label: "Landing" },
  { id: "library", label: "Library" },
];
const event = { schema_version: 2, type: "route_view", route_id: "landing" };
// This is real Node SQLite adapter-contract coverage, explicitly NOT workerd evidence.
function fixture({ qualified = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...args) {
      const rows = db.prepare(query).all(...args);
      return {
        toArray: () => rows,
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
      };
    },
    get databaseSize() {
      return db.prepare("PRAGMA page_count").get().page_count * 4096;
    },
  };
  const storage = {
    sql,
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  let now = Date.UTC(2026, 10, 12, 12);
  const clock = () => now,
    crypto = makeCrypto(makeSecrets(), "quietstats-hosted-test");
  const store = new AuthorityStore(storage, clock);
  const access = new AccessService(store, crypto, clock, { hosted: true });
  const data = new DataService(store, crypto, clock, routes, {
    production: true,
    qualified,
  });
  return {
    db,
    sql,
    store,
    access,
    data,
    crypto,
    clock,
    tick: (n) => (now += n),
    close: () => db.close(),
  };
}
const report = (f) => f.data.report({ from: "2026-11-12", to: "2026-11-12" });
const collect = (f) => f.data.collect(event, "test-source");
function populate(f) {
  f.data.setPolicy(true);
  for (let i = 0; i < 6; i++) collect(f);
}
function patch(f, change) {
  f.store.tx(() => f.store.set("capacity", { ...f.data.state(), ...change }));
}
test("hosted production is distinct from synthetic, default off and explicitly qualified", () => {
  for (const qualified of [true, false]) {
    const f = fixture({ qualified });
    try {
      assert.equal(f.data.status().synthetic, false);
      assert.equal(f.data.status().measurement_mode, "disabled");
      assert.throws(
        () => collect(f),
        (e) => e.code === "collection_disabled",
      );
      if (!qualified)
        assert.throws(
          () => f.data.setPolicy(true),
          (e) => e.status === 403,
        );
      else {
        populate(f);
        assert.equal(report(f).synthetic, false);
        assert.equal(report(f).total, 6);
        assert.match(
          report(f).coverage.collection_policy,
          /Production collection enabled/,
        );
      }
    } finally {
      f.close();
    }
  }
});
test("hosted SQLite rotation is atomic, versions all rows and restores previous archives", () => {
  const f = fixture();
  try {
    populate(f);
    const archive = f.data.backup(),
      before = report(f),
      authority = f.access.state(),
      key = f.data.key();
    patch(f, { encryptions: 999000 });
    collect(f);
    assert.equal(f.data.state().key_version, 2);
    assert.ok(f.data.key() !== key);
    assert.ok(f.store.rows().every((r) => r.envelope.kv === 2));
    assert.deepEqual(f.access.state(), authority);
    f.data.restore(archive);
    assert.deepEqual(report(f), before);
    assert.equal(
      f.sql.exec("SELECT count(*) AS n FROM restore_candidate").one().n,
      0,
    );
    assert.ok(f.store.rows().every((r) => r.envelope.kv === 2));
    patch(f, { key_created: f.clock() - 89 * 86400000 });
    report(f);
    assert.equal(f.data.state().key_version, 3);
    const currentArchive = f.data.backup();
    f.data.rotateDataKey();
    f.data.restore(currentArchive);
    assert.equal(f.data.state().key_version, 4);
    assert.deepEqual(report(f), before);
  } finally {
    f.close();
  }
});
test("hosted key migration and restore write failure roll back every row, key and authority", () => {
  const f = fixture();
  try {
    populate(f);
    const archive = f.data.backup();
    for (const operation of [
      () => f.data.rotateDataKey(),
      () => f.data.restore(archive),
    ]) {
      const before = {
        rows: f.store.rows(),
        key: f.store.get("data_key"),
        state: f.data.state(),
        authority: f.access.state(),
      };
      const real = f.store.put.bind(f.store);
      let count = 0;
      f.store.put = (...args) => {
        real(...args);
        if (++count === 2) throw Error("Injected write failure");
      };
      assert.throws(operation);
      f.store.put = real;
      assert.deepEqual(
        {
          rows: f.store.rows(),
          key: f.store.get("data_key"),
          state: f.data.state(),
          authority: f.access.state(),
        },
        before,
      );
    }
  } finally {
    f.close();
  }
});
test("hosted pre/post accounting refuses stale, future, unknown and post-write growth", () => {
  const f = fixture();
  try {
    populate(f);
    const original = f.store.meter.bind(f.store);
    const key = f.data.key(),
      authority = f.access.state(),
      rows = f.store.rows();
    for (const override of [
      { at: f.clock() - 60001 },
      { at: f.clock() + 1 },
      { bytes: NaN },
      { database_bytes: 5800000 },
    ]) {
      f.store.meter = () => ({ ...original(), ...override });
      assert.throws(() => collect(f));
      f.store.meter = original;
      assert.deepEqual(f.store.rows(), rows);
      assert.ok(f.data.key() === key);
      assert.deepEqual(f.access.state(), authority);
    }
    f.data.setPolicy(true);
    const put = f.store.put.bind(f.store);
    let grew = false;
    f.store.put = (...args) => {
      put(...args);
      grew = true;
    };
    f.store.meter = () => ({
      ...original(),
      ...(grew ? { database_bytes: 5800000 } : {}),
    });
    assert.throws(() => collect(f));
    f.store.meter = original;
    f.store.put = put;
    assert.deepEqual(f.store.rows(), rows);
    assert.equal(f.data.state().enabled, false);
    assert.match(f.data.state().gap, /Physical/);
  } finally {
    f.close();
  }
});
test("hosted actual SQLite physical ceiling rolls back growth and keeps auth and keys", () => {
  const f = fixture();
  try {
    populate(f);
    const authority = f.access.state(),
      key = f.data.key(),
      rows = f.store.rows();
    f.store.tx(() => {
      f.sql.exec("CREATE TABLE pressure(value BLOB)");
      f.sql.exec("INSERT INTO pressure VALUES(zeroblob(5700000))");
    });
    assert.throws(() => collect(f));
    assert.equal(f.data.state().enabled, false);
    const size = f.store.meter().bytes;
    assert.throws(() =>
      f.store.tx(() =>
        f.sql.exec("INSERT INTO pressure VALUES(zeroblob(3000000))"),
      ),
    );
    assert.equal(f.sql.exec("SELECT count(*) AS n FROM pressure").one().n, 1);
    assert.deepEqual(f.store.rows(), rows);
    f.data.erase("2026-11-12");
    assert.ok(f.store.meter().bytes >= size);
    assert.ok(f.data.key() === key);
    assert.deepEqual(f.access.state(), authority);
  } finally {
    f.close();
  }
});
test("hosted candidate verification rejects a corrupt SQL read, live data remains untouched", () => {
  const f = fixture();
  try {
    populate(f);
    const archive = f.data.backup(),
      before = f.store.rows();
    const exec = f.sql.exec.bind(f.sql);
    f.sql.exec = (query, ...args) =>
      query.startsWith("SELECT day,envelope FROM restore_candidate")
        ? { toArray: () => [] }
        : exec(query, ...args);
    assert.throws(() => f.data.restore(archive));
    assert.deepEqual(f.store.rows(), before);
  } finally {
    f.close();
  }
});
test("hosted retention and restore retain erasure cutoff and never import authority", () => {
  const f = fixture();
  try {
    populate(f);
    f.store.tx(() =>
      f.data.writePartition({
        day: "2024-01-01",
        counts: { landing: 5, library: 0 },
      }),
    );
    report(f);
    assert.equal(f.store.rows().length, 2);
    assert.equal(f.data.state().pruned, 1);
    const archive = f.data.backup(),
      authority = f.access.state();
    f.data.erase("2026-11-12");
    f.data.restore(archive);
    assert.equal(f.store.rows().length, 0);
    assert.equal(f.data.state().cutoff, "2026-11-12");
    assert.deepEqual(f.access.state(), authority);
  } finally {
    f.close();
  }
});
test("hosted configuration validates the origin, explicit runtime, routes and qualification", () => {
  const env = {
    TRUSTED_ORIGIN: "https://runtime.example.invalid",
    RUNTIME_MODE: "production",
    DATASET_NAMESPACE: "quietstats-test",
    ROUTES_JSON: JSON.stringify(routes),
  };
  assert.equal(configuration(env).qualified, false);
  for (const change of [
    { TRUSTED_ORIGIN: "http://runtime.example.invalid" },
    { RUNTIME_MODE: "synthetic" },
    { ROUTES_JSON: "[]" },
    { PRODUCTION_QUALIFIED: "yes" },
  ])
    assert.throws(() => configuration({ ...env, ...change }));
});
test("hosted asset handler checks private HTML and rewrites only its own basename", async () => {
  const paths = [];
  const env = {
    ASSETS: {
      fetch: async (request) => {
        paths.push(new URL(request.url).pathname);
        return new Response("asset", {
          headers: { "content-type": "text/html" },
        });
      },
    },
  };
  const authority = { authorizePage: async () => false };
  const get = (path) =>
    serveAssets(
      new Request("https://runtime.example.invalid" + path),
      env,
      authority,
    );
  const denied = await get("/quietstats/admin");
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get("location"), "/quietstats/login?expired=1");
  assert.equal(paths.length, 0);
  const response = await get("/quietstats/login");
  assert.deepEqual(paths, ["/index.html"]);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await get("/quietstats/fixture.html")).status, 404);
});

test("client basename helpers preserve root mode and prefix every hosted navigation target", async () => {
  const { build } = await import("esbuild");
  for (const base of ["/", "/quietstats/"]) {
    const built = await build({
      entryPoints: ["client/paths.mjs"],
      bundle: true,
      format: "esm",
      write: false,
      define: { "import.meta.env.BASE_URL": JSON.stringify(base) },
      logLevel: "silent",
    });
    const paths = await import(
      "data:text/javascript;base64," +
        Buffer.from(built.outputFiles[0].text).toString("base64")
    );
    for (const target of [
      "/",
      "/login",
      "/setup",
      "/admin",
      "/access",
      "/recovery",
      "/help",
      "/privacy.html",
      "/quietstats-logo-dark.webp",
    ]) {
      assert.equal(paths.appPath(target), base + target.slice(1));
      assert.equal(paths.pagePath(paths.appPath(target)), target);
    }
  }
});
