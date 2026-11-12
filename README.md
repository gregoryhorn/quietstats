# QuietStats

A React application for private encrypted aggregate route counts, with an HTTPS local runner and a generic single-site Cloudflare SQLite Durable Object runtime. Both start empty with collection off. No live site integration, deployment or account provisioning is performed by this source. See [hosted runtime configuration and operator steps](adapters/cloudflare/README.md).

## Local run

Requires Node 22.23 or newer (including `node:sqlite`), npm and OpenSSL. Use the supplied lockfile and project `.npmrc` (which retains the tested development-tool peer-resolution policy):

```sh
npm ci
npm run build
npm run setup:local
npm start
```

Open **https://127.0.0.1:4318**. This isolated loopback adapter uses a self-signed certificate generated under protected `.local/`; establish local browser trust for that certificate, and do not treat it as production TLS. The server binds only to 127.0.0.1. No public or insecure-cookie fallback exists. `NODE_ENV=production` is refused.

Open `/setup` and paste the grant from `.local/setup-grant.txt` using a local editor. Never send that file, seed, QR, authenticator code or recovery codes through chat or logs. This task is for a **synthetic test authenticator**, not real-owner enrolment. Setup stages a seed, confirms a TOTP, displays ten one-use recovery codes once, then requires acknowledgment and a different fresh TOTP to commit. Normal access at `/login` always requires the next unused code. No password or OAuth exists. Restarting `setup:local` can issue a new initial grant while unenrolled; it refuses replacement of enrolled access without the explicit local operator `--replace-access` flag.

Stop with **Ctrl+C**. No database migration or server starts during installation. The initial schema is created locally when setup/tests run. Protected `.local/` files are excluded from source packaging. Do not copy config/keys alongside a backup as your only custody copy.

For an independent isolated synthetic collector, choose the flag on first setup:

```sh
npm run setup:local -- --synthetic
```

Then visit `/fixture.html`; it sends only if DNT is explicitly `0` and GPC explicitly `false`. Unknown signals send nothing. There is no public header/query bypass or production enable switch. The default landing page does not attach a collector. Synthetic data comes from real API writes to the isolated backend, never from dashboard placeholders. Existing config is preserved; the setup command does not silently change its mode.

## Tests and build

```sh
npm test
npm run test:vitest
npm run build
npm run test:browser
npm run package:source
```

For hosted assets run `npm run build:hosted`; then run `QUIETSTATS_MINIFLARE_MODULE=<module-path> npm run test:runtime` in an environment permitting local sockets. The harness uses only temporary synthetic keys and writes sanitized runtime evidence.

Node tests exercise actual durable SQLite state, two database connections, concurrent HTTP-handler login, restart replay, transactional fault rollback, restricted recovery, AEAD, encrypted backup/isolated restore, cutoffs, suppression, physical accounting and reporter lifecycle. Fetch `Request`/`Response` tests invoke the real HTTP handler without socket mocks. These are distinct from socket/browser evidence.

The Playwright runner uses `/usr/bin/google-chrome` by default (`QUIETSTATS_CHROME` can select another local executable), an isolated loopback TLS backend, synthetic material and no secret screenshots/traces. Run `setup:local` first for local TLS files. It exercises ordinary public/Privacy/setup/login/recovery/dashboard/fixture/expiry pages, chart/date controls, CSV/encrypted downloads and responsive dashboard layouts, and writes only sanitised aggregate/public screenshots. Browser journeys use real loopback HTTPS and SQLite; they require an environment permitting browser and socket system calls. Restricted execution environments may deny Chrome or local listeners; such failures exit unsuccessfully rather than substituting fabricated results. Hosted-provider and real-phone qualification are separate.

## Architecture and security

- `core/`: portable contracts, access state machine and encrypted daily aggregate services. Explicit store/crypto/clock ports; no provider or website imports.
- `adapters/local/`: durable serializable SQLite, filesystem/page metering, isolated candidate restore and Node crypto/OTPAuth port.
- `server/`: HTTPS loopback serving, strict same-origin Fetch Metadata/media/schema/size guards, private no-store API, server checks for private pages. Opaque secure host-only HttpOnly Strict cookies; session-bound CSRF.
- `client/`: React ordinary-page UI, SVG chart/table, server-only authority and in-memory report clearing on expiry/visibility/revalidation. No prototype state selector.
- `adapters/cloudflare/`: one fixed SQLite DO for auth and encrypted analytics, physical admission/rollback, private operator RPC, production qualification/policy, and `/quietstats/` static routing. No D1/R2 or account operations. Actual workerd verification and deployment remain separate from Node checks.

TOTP is single-factor possession authentication and susceptible to phishing. Server/operator compromise can decrypt data. Each admitted code consumes durable replay high-water; future skew success can require waiting. Source/global HMAC-keyed rate limits survive restarts. Rate limiting cannot prevent distributed service denial. Recovery grants only restricted replacement scope; old credentials remain active until atomic final replacement. Lost responses may burn an entry code. No auth state is restored from an analytics archive.

AES-256-GCM analytics DEKs are independently wrapped by DATA_KEK; seeds use AUTH_KEK; rate/recovery/archive purposes have distinct keys. Ciphertext dates, sizes and key/security metadata remain visible. Missing/tampered/wrong-key data fails closed. Local mode keeps its original 90-day/one-million-encryption key-maintenance stop. Hosted production mode automatically rotates the DEK at 89 days or projected 999,000 encryptions in one all-old/all-new transaction, preserving old archive restoration; see the hosted runtime guide for failure recovery. Phone and recovery codes cannot reconstruct a lost data key.

## Bounded data and honest reporting

Only `{schema_version:2,type:'route_view',route_id:allowlistedID}` is accepted, up to 512 bytes. Server UTC receipt is immediately aggregated; no individual analytics row, visitor identifier, history, referrer or raw IP is stored. Source digests serve security only and expire within 24 hours. Counts 1–4 and revealing derived totals/trends are suppressed. Missing/incomplete zero cells remain unavailable; no unique-person, source or outbound metrics are fabricated. Overlapping queries can still permit inference; this is not a differential privacy or legal anonymity claim.

Local SQLite has an 8 MiB physical page cap, stops collection before projected 6 MB primary allocation, reserves 393,216 bytes per mutation plus a full 8 MiB rollback journal, and stops projected managed usage before 20 MB. These are stricter **local test** limits, not proof of provider storage. Pruning is oldest-date-first, at most 400 dates, with monotonic erasure/prune cutoff. DELETE never creates claimed physical credit. Credential/key/replay state is not pruned for analytics pressure. Unknown allocation closes collection. All local writes are serialized in one DB transaction; distributed DO/D1 permits are not falsely emulated.

Both runtimes use buffered encrypted archives capped at 2 MB; scalable production streaming is unavailable. Restore decrypts and validates a bounded isolated candidate before an atomic analytics-only replacement, retaining current erasure/retention cutoffs and live auth authority. Keep no more than two downloaded archives (4 MB combined), at most 35 days, scratch/CSV under 20 MB, and keys in separate existing protected custody. The app cannot enforce deletion of unmanaged downloaded copies or assert off-device backup custody. Download/generation, saved acknowledgment and verified restore are different facts. RPO is since your retained verified archive; RTO is unqualified.

## Source package and rights

`package:source` builds an explicit file-manifest archive under `evidence/`, rejects symlinks/private path/secret fixtures and checks exact members. It excludes local state, keys, all evidence, private work orders/build records, tooling caches, inherited files and Git metadata. The source archive contains generic reusable software only; deployment credentials, account configuration and visitor data are excluded. No automatic deployment or publishing script exists. No parent repository history is imported or certified. `LICENSE` is standard MIT, Copyright (c) 2026 Gregory Horn; see `THIRD-PARTY-NOTICES.md`, font licence and dependency inventory. Default `quietstats:software`/`quietstats:creator` metadata credits the product without replacing a host author's metadata.
