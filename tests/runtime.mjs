import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { makeSecrets } from "../adapters/local/crypto.mjs";
import { browser, code } from "./runtime-helpers.mjs";
import {
  routing,
  authentication,
  analytics,
  recovery,
  budget,
} from "./runtime-scenarios.mjs";
const require = createRequire(import.meta.url);
mkdirSync("evidence", { recursive: true });
mkdirSync(".test-state", { recursive: true });
const root = mkdtempSync(resolve(".test-state/runtime-"));
const previousTemporary = process.env.TMPDIR;
const temporary = join(root, "tmp");
mkdirSync(temporary, { recursive: true, mode: 0o700 });
process.env.TMPDIR = temporary;
const result = {
  status: "running",
  runtime: "workerd + SQLite Durable Object via Miniflare",
  checks: [],
  started_at: new Date().toISOString(),
};
const testSecrets = makeSecrets();
function saveResult() {
  result.finished_at = new Date().toISOString();
  writeFileSync(
    "evidence/hosted-runtime-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
}
process.once("uncaughtException", (error) => {
  result.status = "failed";
  result.failed_phase = phase;
  result.error_type = error.name;
  result.error_code = typeof error.code === "string" ? error.code : null;
  result.environment_refusal = ["EPERM", "EACCES"].includes(error.code);
  saveResult();
  console.log(JSON.stringify(result));
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
let runtime,
  phase = "load Miniflare";
async function main() {
  const module = require.resolve(
    process.env.QUIETSTATS_MINIFLARE_MODULE || "miniflare",
  );
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import(
    pathToFileURL(resolve(module)).href
  );
  phase = "bundle test-only Worker";
  const scriptPath = join(root, "worker.mjs");
  await build({
    entryPoints: ["tests/runtime-worker.mjs"],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["cloudflare:workers", "node:crypto"],
    logLevel: "silent",
  });
  const options = {
    resourceTmpPath: join(root, "resources"),
    resourcePersistencePath: join(root, "resources-persist"),
    cf: false,
    stripCfConnectingIp: false,
    telemetry: { enabled: false },
    name: "quietstats-runtime-test",
    modules: true,
    scriptPath,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      AUTHORITY: { className: "RuntimeAuthority", useSQLite: true },
    },
    durableObjectsPersist: join(root, "storage"),
    assets: {
      directory: resolve("dist"),
      binding: "ASSETS",
      routerConfig: {invoke_user_worker_ahead_of_assets:true,has_user_worker:true},
      assetConfig: { html_handling: "none", not_found_handling: "none" },
    },
    bindings: {
      ...testSecrets,
      RUNTIME_MODE: "production",
      PRODUCTION_QUALIFIED: "true",
      TRUSTED_ORIGIN: "https://runtime.example.invalid",
      DATASET_NAMESPACE: "quietstats-runtime-test",
      ROUTES_JSON: JSON.stringify([
        { id: "landing", label: "Landing" },
        { id: "library", label: "Library" },
      ]),
    },
    log: new Log(LogLevel.NONE),
  };
  // A second LOCAL test Worker holds a service binding to the real named entrypoint.
  // It exposes no HTTP-to-RPC bridge; Node tests use Miniflare's binding proxy.
  function runtimeOptions(bindings = options.bindings) {
    const {
      resourceTmpPath,
      resourcePersistencePath,
      cf,
      telemetry,
      log,
      durableObjectsPersist,
      ...site
    } = options;
    return {
      resourceTmpPath,
      resourcePersistencePath,
      cf,
      telemetry,
      log,
      durableObjectsPersist,
      workers: [
        { ...site, bindings },
        {
          name: "operator-test-client",
          modules: true,
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          script:
            'export default {fetch() {return new Response("Not found", {status:404})}}',
          serviceBindings: {
            OPERATOR: { name: options.name, entrypoint: "QuietStatsOperator" },
          },
        },
      ],
    };
  }
  const createRuntime = (bindings) => {
    const config = runtimeOptions(bindings);
    return new Miniflare(
      convertV4MiniflareOptions ? convertV4MiniflareOptions(config) : config,
    );
  };
  phase = "start workerd";
  runtime = createRuntime();
  await runtime.ready;
  const getStub = async () =>
    (await runtime.getDurableObjectNamespace("AUTHORITY")).getByName(
      "quietstats-site-v1",
    );
  let stub = await getStub();
  const clock = { now: Date.UTC(2026, 10, 12, 12) };
  await stub.testClock(clock.now);
  phase = "static basename routing and private HTML";
  await routing(runtime);
  result.checks.push(phase);
  phase = "private named WorkerEntrypoint through service-binding proxy";
  const operator = (await runtime.getBindings("operator-test-client")).OPERATOR;
  assert.equal((await operator.operatorStatus()).enrolled, false);
  assert.equal(
    (await operator.fetch(new Request("https://operator.invalid/"))).status,
    404,
  );
  assert.equal(
    (await operator.setCollectionPolicy(true)).measurement_mode,
    "production",
  );
  await operator.setCollectionPolicy(false);
  result.checks.push(phase);
  phase = "API setup, login, replay, same-origin and CSRF";
  const state = await authentication(runtime, stub, clock, operator);
  result.checks.push(phase);
  phase =
    "production collection, encryption, rotation, backup/restore, rollback and retention";
  const data = await analytics(stub, state);
  result.checks.push(phase);
  phase = "recovery replacement and restore preserves auth";
  const replaced = await recovery(runtime, stub, clock, state, data);
  result.checks.push(phase);
  phase = "restart and storage persistence";
  const inspected = await stub.testInspect();
  const persistedReport = await replaced.client.json(data.query);
  assert.equal(persistedReport.coverage.collection_policy,'Production collection disabled');
  const before = Object.fromEntries(['authority','key','rows'].map(k=>[k,inspected[k]]));
  await runtime.dispose();
  runtime = createRuntime();
  await runtime.ready;
  stub = await getStub();
  await stub.testClock(clock.now);
  const after = await stub.testInspect();
  assert.ok(
    before.authority === after.authority &&
      before.key === after.key &&
      before.rows === after.rows,
  );
  const replay = browser(runtime, "restart-replay");
  await replay.challenge();
  assert.equal(
    (
      await replay.api("/auth/login", {
        method: "POST",
        body: { code: code(replaced.seed, clock.now) },
      })
    ).status,
    401,
  );
  // Verify a fresh login after restart as well as durable replay refusal.
  clock.now += 30000;
  await stub.testClock(clock.now);
  const client = browser(runtime, "restart-owner");
  await client.challenge();
  assert.equal(
    (
      await client.api("/auth/login", {
        method: "POST",
        body: { code: code(replaced.seed, clock.now) },
      })
    ).status,
    204,
  );
  await client.session();
  assert.deepEqual(await client.json(data.query), persistedReport);
  result.checks.push(phase);
  phase =
    "meter refusal, actual physical budget rollback, erasure and auth survival";
  await budget(stub, { client, visitor: browser(runtime, "budget-visitor") });
  result.checks.push(phase);
  phase = "unqualified production cannot enable collection";
  await runtime.dispose();
  runtime = createRuntime({
    ...options.bindings,
    PRODUCTION_QUALIFIED: "false",
  });
  await runtime.ready;
  stub = await getStub();
  await assert.rejects(stub.setCollectionPolicy(true));
  assert.equal((await stub.operatorStatus()).synthetic, false);
  result.checks.push(phase);
  result.status = "passed";
}
try {
  await main();
} catch (error) {
  result.status = "failed";
  result.failed_phase = phase;
  result.error_type = error.name;
  result.error_code = typeof error.code === "string" ? error.code : null;
  result.safe_diagnostic = String(error.message).replace(/[A-Za-z0-9_+\/=\-]{12,}/g,"[redacted]").slice(0,400);
  if (result.error_code === "ERR_VALIDATION") {
    let diagnostic = String(error.message);
    for (const value of Object.values(testSecrets))
      diagnostic = diagnostic.replaceAll(value, "[redacted synthetic key]");
    result.validation = diagnostic.slice(0, 4000);
  }
  result.environment_refusal =
    /EPERM|EACCES|permission|operation not permitted|listen/i.test(
      String(error.message) + String(error.cause?.message),
    );
  // Startup diagnostics may contain configuration; never serialize exception objects/bindings.
  if (error.name === "AssertionError")
    result.assertion = String(error.message).slice(0, 300);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.dispose();
  rmSync(root, { recursive: true, force: true });
  if (previousTemporary === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTemporary;
  saveResult();
  console.log(JSON.stringify(result));
}
