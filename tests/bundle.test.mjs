import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
test("Workers bundles resolve official OTPAuth ESM with static node crypto and private exports", async () => {
  for (const entry of [
    "adapters/cloudflare/worker.mjs",
    "tests/runtime-worker.mjs",
  ]) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "node",
      target: "es2022",
      external: ["cloudflare:workers", "node:crypto"],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs),
      text = result.outputFiles[0].text;
    assert.ok(inputs.includes("vendor/otpauth/otpauth.node.mjs"));
    assert.ok(!inputs.some((path) => path.endsWith("otpauth.cjs")));
    assert.ok(
      !/\b__require\s*\(|\brequire\s*\(/.test(text),
      "Worker bundle must contain no dynamic CJS require",
    );
    assert.match(text, /from "node:crypto"/);
    const exports = Object.values(result.metafile.outputs)[0].exports;
    assert.ok(exports.includes("QuietStatsOperator"));
    assert.ok(
      exports.includes(
        entry.startsWith("tests/") ? "RuntimeAuthority" : "QuietStatsAuthority",
      ),
    );
    assert.ok(exports.includes("default"));
  }
  assert.match(
    readFileSync("wrangler.example.jsonc", "utf8"),
    /"compatibility_date": "2026-07-30"/,
  );
  assert.match(
    readFileSync("tests/runtime.mjs", "utf8"),
    /compatibilityDate: "2026-07-30"/,
  );
});
