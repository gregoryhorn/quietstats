# Single-site hosted runtime

This generic runtime uses **one SQLite Durable Object** for a site's authentication, encrypted aggregates, retention, capacity and candidate restore. Every route uses `AUTHORITY.getByName("quietstats-site-v1")`. No D1, R2, per-user objects, account provisioning or paid fallback is involved. `AuthorityStore` uses synchronous SQL and `storage.transactionSync`; the shared core services and `node:crypto` port run with `nodejs_compat`. Compatibility date is pinned to `2026-07-30` for both deployment and runtime tests. OTPAuth imports use the byte-identical official Node ESM distribution, avoiding a bundled CJS dynamic require. Local mode remains separate.

## Build and binding contract

Run `npm run build:hosted` to build assets with public base `/quietstats/`. Local `npm run build` continues to use `/`. The example configuration has no account, domain, route or secret values. Copy/adapt it in the parent's private deployment workspace, with source/build paths resolved there. Assets must be built from this source and bound as `ASSETS`, with `run_worker_first: true` and `html_handling: "none"`. The Worker rewrites application pages to `/index.html` in that binding and asset paths to the dist root. It checks `/quietstats/admin` and `/quietstats/access` on the server before serving private HTML, sets no-store/CSP headers on pages and private APIs, and allows immutable caching only for successful hashed build assets. The public API remains `/api/metrics/v1/*`.

Route only `/quietstats`, `/quietstats/*` and `/api/metrics/*` to this Worker; it returns 404 outside those namespaces. It never proxies or serves the portfolio root. Public JS is downloadable and grants no authority. Fixture collector assets are not served by the hosted handler. The host's existing reporter/integration is a separate parent-owned action; this runtime does not attach a collector to the live portfolio.

Private deployment configuration must supply:

- `RUNTIME_MODE`: exactly `production`.
- `TRUSTED_ORIGIN`: the canonical HTTPS origin, with no path or trailing slash.
- `DATASET_NAMESPACE`: stable 8–80 characters, letters/digits/underscore/hyphen; it separates cryptographic contexts.
- `ROUTES_JSON`: JSON array of 1–32 unique `{id,label}` entries. IDs start with a lower-case letter, contain lower-case letters/digits/underscore/hyphen, and are at most 40 characters; labels are 1–100 characters. No example route map is selected silently.
- Five independent 32-byte base64url **secret bindings**: `AUTH_KEK`, `DATA_KEK`, `RECOVERY_PEPPER`, `LIMIT_PEPPER`, `BACKUP_AUTH_KEY`. Keep them in existing protected custody, separate from archives. Never put them in `vars`, URLs, logs, source or chat.
- `PRODUCTION_QUALIFIED`: absent/`false` by default; `true` records the parent's external Free account/shared-quota/privacy eligibility determination. This alone does not enable collection. No code changes account plans or purchases services.
- SQLite DO namespace binding `AUTHORITY` to `QuietStatsAuthority`, with the `new_sqlite_classes` migration, and static-assets binding `ASSETS`.

The namespace, route IDs/labels and trusted origin are fingerprinted in the object. Changing that contract on an existing instance fails closed; do not change the fixed object identity or namespace to evade stored authority. No arbitrary public operator method forwarding exists.

## Private operator RPC and owner enrolment

The module exports the named `QuietStatsOperator extends WorkerEntrypoint` capability. It forwards only `issueSetupGrant()`, `setCollectionPolicy(boolean)` and `operatorStatus()` to the same fixed `AUTHORITY` object; its `fetch()` returns 404. Invoke it **only through an already-authorized Cloudflare service binding**, including Wrangler's authenticated remote service-binding proxy. No separate public operator Worker is required. See the exact proxy configuration/invocation below. Direct namespace RPC remains available to protected existing operator tooling. No public operator URL, operator token, first-visitor setup, secret query parameter or generic eval endpoint is supplied.

- `issueSetupGrant()` returns a secret one-use grant, valid for ten minutes, while unenrolled. Deliver it privately to the owner. Owner opens `/quietstats/setup`, exchanges it, stages/scans the actual phone authenticator, confirms a code, saves the once-shown recovery set, and commits with a different fresh code. No owner enrolment is simulated by deployment.
- `issueSetupGrant(true)` is the explicit lost-phone-and-recovery operator replacement. It freezes/revokes existing access and grants only replacement scope, preserving analytics keys/data. Use only for an actual authorized recovery decision.
- `operatorStatus()` returns enrolled boolean, mode, storage/backup/rotation metadata and gaps; no seeds, codes, keys or bearer tokens.
- `setCollectionPolicy(true|false)` changes the durable policy. Enabling requires explicit production qualification; policy starts off even in a qualified instance. Reports/status identify `synthetic: false`. Public APIs cannot change policy.
- `rotateDataKey()` atomically migrates all retained analytics to a new random wrapped DEK and returns only version/time. It never changes auth keys/credentials. It is a safe private retry if automated rotation could not obtain physical headroom.

Use existing protected operator tooling rather than adding a public bridge. Parent owns creation/removal/access control for any private operator Worker. Do not print RPC grant responses or record enrolment/recovery screens, request bodies, cookie headers or bindings. Review provider request/trace logging separately; this generic app emits no request or secret logs.

## Storage, rotation and recovery limits

`sql.databaseSize` measures the attached database; it does **not** measure provider replication, PITR, WAL/internal storage or other Free account usage. Every store transaction checks a fresh physical meter before/after and rolls back on an 8 MiB application ceiling. This is a transaction-enforced ceiling, not a configured provider `max_page_count`. Analytics admission additionally requires projected database size below 6,000,000 bytes, 393,216 bytes mutation headroom, and a conservative 8 MiB unmeasured-internals reserve within a 20 MB application budget. Those reserves do not certify provider internal usage. Unknown/stale/future meters and exhausted budgets refuse writes; auth/key records are never pruned for space. Existing authentication may refuse new sessions under pressure, while stored authority and valid-session authorization survive. Status derives a physical gap even if an earlier auth-rate admission refused collection before analytics ran.

Only six fixed state keys exist (each value <=256 KiB), aggregate envelopes <=4 KiB, <=800 family rows /400 dates, <=2,000 admitted reports/day, bounded sessions/security buckets. Oldest-day retention and monotonic erasure cutoffs remain in force. DELETE creates no assumed physical shrinkage. At the physical stop, logical erasure is available within the hard ceiling; re-enablement requires actual measured headroom. If the provider keeps allocation, export a bounded verified archive and arrange a deliberate parent-operated capacity/recovery action. Never delete the object or restore provider PITR over live auth as an automatic remedy.

Production rotates the DEK before new aggregate encryption when it reaches 89 days or projected 999,000 encryptions; report/backup maintenance also rotates when due. All rows, wrapped key, version and counters change in one transaction, with full decryption/parity comparison before commit. Failure leaves all-old data. At rest, `kv` in each envelope is authenticated through aggregate AAD; missing `kv` means legacy version 1. The wrap context `analytics-dek|1` is the stable wrap-format version, independent of the rotating DEK generation. The archive's `key_version` identifies its captured generation; old archives retain their wrapped DEK and restore by decrypting the old generation and re-encrypting under the current one. Local mode retains its original explicit key-maintenance stop.

Backups are encrypted authenticated **buffered** archives capped at 2 MB; no scalable streaming guarantee is claimed. Restore validates/decrypts/parity-checks the archive, writes an encrypted bounded SQL candidate, independently reads/decrypts it and compares every partition, then atomically replaces only analytics while preserving current auth and cutoffs. Candidate rows are deleted; their physical allocation is not credited as reclaimed. Temporary candidate encryption uses its own random ephemeral key. External archive retention/custody remains with the owner (at most two /35 days per existing guidance).

## Verification

`npm test` includes direct Node SQLite coverage of this store/production service contract; it is not workerd evidence. `npm run test:runtime` bundles a **test-only** subclass and instantiates Worker + SQLite DO in Miniflare/workerd, with randomly generated temporary synthetic keys only. Never deploy `tests/runtime-worker.mjs` or `RuntimeAuthority`.

```sh
npm run build:hosted
# Miniflare must be resolvable locally, or point to an existing module file/package directory:
QUIETSTATS_MINIFLARE_MODULE=<module-path> npm run test:runtime
```

The harness supports Miniflare 4 options and Miniflare 5's exported options converter. The parent-provided intact official runtime is `miniflare@4.20260730.0` with `workerd@1.20260730.1`; use compatibility date `2026-07-30`. Parent found its older Miniflare 5 workerd binary truncated; do not use that installation as runtime evidence. No additional package was installed here. It writes sanitized `evidence/hosted-runtime-result.json` and exits unsuccessfully on failure, including socket restrictions. Runtime tests cover auth/replay/recovery, collection off/on, reports, encrypted backup/restore, rotation rollback, retention, real physical allocation/rollback, auth survival, restart persistence and static basename routing. The actual local runtime outcome is recorded in the private build report; a successful Node test or bundle must not be substituted for a runtime pass.

References: [SQLite storage/transactionSync/databaseSize](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [DO Free pricing and quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/). These specify APIs and product availability, not deployment qualification.

## Private setup through Wrangler remote service binding

Parent keeps this proxy config and invocation in its protected operator workspace, **outside generic source**. This is a local proxy configuration, not a Worker to deploy. Use existing authenticated Wrangler access; no new bearer credential or HTTP management route is added. Replace the target service name with the actual deployed runtime name. Do not bind this capability into a public host frontend or expose an HTTP forwarding function.

```jsonc
{
  "name": "quietstats-private-local-proxy",
  "account_id": "<already-authorized-account-id>",
  "compatibility_date": "2026-07-30",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "services": [{
    "binding": "QUIETSTATS_OPERATOR",
    "service": "<deployed-runtime-worker-name>",
    "entrypoint": "QuietStatsOperator",
    "remote": true
  }]
}
```

In a private Node ESM program next to the parent's existing Wrangler installation:

```js
import { getPlatformProxy } from "wrangler";
import { writeFile } from "node:fs/promises";

const platform = await getPlatformProxy({
  configPath: process.env.QUIETSTATS_OPERATOR_CONFIG,
  remoteBindings: true,
  persist: false,
});
try {
  const operator = platform.env.QUIETSTATS_OPERATOR;
  const status = await operator.operatorStatus();
  if (!status.enrolled) {
    const grant = await operator.issueSetupGrant();
    // Parent chooses an existing protected directory. Never log the value.
    await writeFile(process.env.QUIETSTATS_SETUP_GRANT_FILE, grant + "\n", {
      flag: "wx", mode: 0o600,
    });
  }
} finally {
  await platform.dispose();
}
```

Run that private program with `QUIETSTATS_OPERATOR_CONFIG` naming the private proxy JSONC and `QUIETSTATS_SETUP_GRANT_FILE` naming a new protected file. These environment variables hold **paths**, not secret values. Use a private local editor to transfer the saved one-use grant into the trusted `/quietstats/setup` form (request body, never URL/chat/logs). Owner enrols the actual phone and saves recovery codes there; this bootstrap program does not receive the seed or recovery set. Do not dump `platform`, bindings, returned grant or raw RPC failures. A separate private invocation can call `operator.operatorStatus()` or `operator.setCollectionPolicy(true)` through the same proxy after the parent-selected enablement point. `setCollectionPolicy(false)` disables it. Always dispose the proxy. No migration/account/secret/portfolio operation is performed by this documentation.

The target runtime uses `AUTHORITY` and `ASSETS` plus the existing origin/namespace/routes/qualification and five secret bindings. The **local proxy config only** uses `QUIETSTATS_OPERATOR`; it needs none of the runtime secret values or the DO namespace binding. The target's named entrypoint accesses its own existing `AUTHORITY` binding.

References: [Wrangler getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/), [named WorkerEntrypoint service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/), [service binding configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#service-bindings). This invocation is documented against official APIs; actual remote execution remains parent-owned and has not been performed here.

## Host reporter join

The browser module exports `attachReporter` and `browserReporter` from both `client/reporter.mjs` and the byte-matched public copy. Defaults remain `enabled: false`, `policy: "unknown"`, and the existing generic fallback route `landing`. `enabled: true` alone selects no measurement mode. The fixture explicitly passes `policy: "synthetic"`; a qualified host explicitly passes `policy: "qualified-aggregate"`. This client policy grants no server permission: backend qualification and durable collection policy still govern admission.

Parent supplies the real 18-entry registry and its exact route reader. To use a `home` fallback with hash routing:

```js
const stop = browserReporter({
  routes: hostRegistry,
  enabled: hostCollectionEnabled,
  policy: "qualified-aggregate",
  defaultRoute: "home",
  readRoute: hostReadRoute, // Returns an allowlisted ID, or null for utility/private pages.
});
// Call stop() when the host component unmounts.
```

An injected reader returning `null` never falls back to home/landing. `browserReporter` listens to hash/visibility/pageshow events. For a different router lifecycle, use the already-exported `attachReporter({source, env, ids, enabled, policy, send})`, where `source.current()` supplies that same exact utility-aware route and `source.subscribe()` follows the real host router. Do not synthesize IDs from utility/private paths or add those pages to the aggregate registry.

Both explicit modes preserve DNT exactly `0` and GPC exactly `false`, unknown-signal refusal, visible current-route-only reporting, document-memory deduplication across remount/bfcache, exact schema2 route-only payloads, same-origin JSON Fetch with same-origin credentials for server owner exclusion, no keepalive/beacon/retry queue/persistent identifiers/popup. Client modes add no payload fields or metrics. Hosted app assets and CSS/public-font links remain under `/quietstats/`; this change does not attach the reporter to that app or the live portfolio.
