import {
  requireThat,
  validateEvent,
  dayOf,
  validDay,
  project,
  period,
} from "./contracts.mjs";
export class DataService {
  constructor(
    store,
    crypto,
    clock,
    routes,
    { synthetic = false, production = false, qualified = false } = {},
  ) {
    this.store = store;
    this.c = crypto;
    this.now = clock;
    this.routes = routes;
    requireThat(!(synthetic && production), 503, "invalid_configuration");
    this.synthetic = synthetic;
    this.production = production;
    this.qualified = production && qualified;
    if (!store.get("data_key"))
      store.tx(() => {
        store.set(
          "data_key",
          crypto.seal("DATA_KEK", crypto.key(), "analytics-dek|1"),
        );
        store.set("capacity", {
          enabled: synthetic,
          fence: 0,
          day: dayOf(clock()),
          requests: 0,
          cutoff: "0000-01-01",
          gap: null,
          pruned: 0,
          encryptions: 0,
          key_created: clock(),
        });
      });
  }
  key() {
    return this.c.open(
      "DATA_KEK",
      this.store.get("data_key"),
      "analytics-dek|1",
    );
  }
  state() {
    return this.store.get("capacity");
  }
  setPolicy(enabled) {
    requireThat(
      typeof enabled === "boolean" &&
        (this.synthetic || this.qualified || !enabled),
      403,
      "forbidden",
    );
    this.store.tx(() => {
      const s = this.state();
      s.enabled = enabled;
      s.fence++;
      s.gap = enabled ? null : "Collection disabled";
      this.store.set("capacity", s);
    });
  }
  admission(s) {
    const m = this.store.meter();
    requireThat(
      Number.isFinite(m.bytes) &&
        m.bytes >= 0 &&
        this.now() - m.at <= 60000 &&
        m.at <= this.now(),
      503,
      "temporarily_unavailable",
    );
    requireThat(
      m.bytes + 393216 + 8388608 < 20000000,
      503,
      "temporarily_unavailable",
    );
    requireThat(
      m.database_bytes + 393216 < 6000000,
      503,
      "temporarily_unavailable",
    );
    requireThat(
      s.encryptions < 1000000 && this.now() - s.key_created < 90 * 86400000,
      503,
      "key_rotation_required",
    );
    return m;
  }
  partitions(
    rows = this.store.rows(),
    key = this.key(),
    version = this.state().key_version || 1,
  ) {
    requireThat(
      Number.isSafeInteger(version) && version >= 1,
      400,
      "invalid_archive",
    );
    requireThat(rows.length <= 800, 503, "temporarily_unavailable");
    const days = new Map();
    for (const row of rows) {
      requireThat(
        validDay(row.day) &&
          ["content", "totals"].includes(row.family) &&
          (row.envelope.kv || 1) === version,
        503,
        "temporarily_unavailable",
      );
      const plain = this.c.open(
        key,
        row.envelope,
        `aggregate|2|${row.envelope.kv || 1}|${row.day}|${row.family}`,
      );
      if (!days.has(row.day)) days.set(row.day, {});
      requireThat(
        !Object.hasOwn(days.get(row.day), row.family),
        400,
        "invalid_archive",
      );
      days.get(row.day)[row.family] = plain;
    }
    return [...days].map(([day, v]) => {
      requireThat(v.content && v.totals, 503, "temporarily_unavailable");
      const counts = v.content.counts;
      requireThat(
        counts &&
          Object.keys(counts).length === this.routes.length &&
          this.routes.every(
            (r) =>
              Number.isInteger(counts[r.id]) &&
              counts[r.id] >= 0 &&
              counts[r.id] <= 2147483647,
          ),
        503,
        "temporarily_unavailable",
      );
      requireThat(
        Object.values(counts).reduce((a, b) => a + b, 0) === v.totals.total,
        503,
        "temporarily_unavailable",
      );
      return { day, counts };
    });
  }
  collect(event, source) {
    validateEvent(
      event,
      this.routes.map((r) => r.id),
    );
    try {
      return this.store.tx(() => {
        const s = this.state();
        requireThat(
          (this.synthetic || this.qualified) && s.enabled,
          403,
          "collection_disabled",
        );
        this.rotateInTransaction(s);
        this.admission(s);
        const day = dayOf(this.now());
        requireThat(day > s.cutoff, 503, "temporarily_unavailable");
        if (s.day !== day) {
          s.day = day;
          s.requests = 0;
        }
        requireThat(s.requests < 2000, 429, "try_later");
        this.pruneInTransaction(s);
        const partitions = this.partitions(
          undefined,
          this.key(),
          s.key_version || 1,
        );
        const counts =
          partitions.find((x) => x.day === day)?.counts ||
          Object.fromEntries(this.routes.map((r) => [r.id, 0]));
        requireThat(
          counts[event.route_id] < 2147483647,
          503,
          "temporarily_unavailable",
        );
        counts[event.route_id]++;
        this.writePartition({ day, counts }, this.key(), s.key_version || 1);
        s.requests++;
        s.fence++;
        s.encryptions += 2;
        s.gap = null;
        this.store.set("capacity", s);
        this.admission(s);
        return { accepted: true };
      });
    } catch (error) {
      if (error.status === 503)
        this.store.tx(() => {
          const s = this.state();
          s.enabled = false;
          s.gap =
            error.code === "key_rotation_required"
              ? "Key rotation required; private rotateDataKey RPC after restoring physical headroom"
              : "Physical accounting or key/work budget unavailable; collection paused";
          s.fence++;
          this.store.set("capacity", s);
        });
      throw error;
    }
  }
  writePartition(
    { day, counts },
    key = this.key(),
    version = this.state().key_version || 1,
  ) {
    const seal = (value, family) => ({
      ...this.c.seal(key, value, `aggregate|2|${version}|${day}|${family}`),
      ...(version === 1 ? {} : { kv: version }),
    });
    this.store.put(day, "content", seal({ counts }, "content"));
    this.store.put(
      day,
      "totals",
      seal(
        { total: Object.values(counts).reduce((a, b) => a + b, 0) },
        "totals",
      ),
    );
  }
  rotateInTransaction(s, extra = 2, force = false) {
    if (!this.production) return;
    if (
      !force &&
      this.now() - s.key_created < 89 * 86400000 &&
      s.encryptions + extra < 999000
    )
      return;
    // Check capacity without the old key-age stop: migration is the way out of that stop.
    this.admission({ ...s, encryptions: 0, key_created: this.now() });
    const partitions = this.partitions(),
      key = this.c.key(),
      version = (s.key_version || 1) + 1;
    for (const p of partitions) this.writePartition(p, key, version);
    this.store.set("data_key", this.c.seal("DATA_KEK", key, "analytics-dek|1"));
    requireThat(
      JSON.stringify(this.partitions(undefined, key, version)) ===
        JSON.stringify(partitions),
      503,
      "key_rotation_required",
    );
    s.key_version = version;
    s.key_created = this.now();
    s.encryptions = partitions.length * 2;
    this.admission(s);
  }
  rotateDataKey() {
    requireThat(this.production, 403, "forbidden");
    return this.store.tx(() => {
      const s = this.state();
      this.rotateInTransaction(s, 0, true);
      this.store.set("capacity", s);
      return { key_version: s.key_version, rotated_at: s.key_created };
    });
  }
  pruneInTransaction(s) {
    const cutoff = dayOf(this.now() - 399 * 86400000);
    const expired = this.store.rows().filter((r) => r.day < cutoff);
    if (expired.length) {
      const last = expired.at(-1).day;
      this.store.deleteThrough(last);
      s.cutoff = s.cutoff > last ? s.cutoff : last;
      s.pruned += expired.length / 2;
    }
    s.cutoff =
      s.cutoff > dayOf(this.now() - 400 * 86400000)
        ? s.cutoff
        : dayOf(this.now() - 400 * 86400000);
  }
  maintain() {
    return this.store.tx(() => {
      const s = this.state();
      this.pruneInTransaction(s);
      this.rotateInTransaction(s, 0);
      this.store.set("capacity", s);
    });
  }
  report(query) {
    period(query);
    this.maintain();
    const report = project(this.partitions(), this.routes, query, this.now());
    report.synthetic = this.synthetic;
    if (this.production)
      report.coverage.collection_policy =
        this.status().measurement_mode === "production"
          ? "Production collection enabled"
          : "Production collection disabled";
    return report;
  }
  erase(through) {
    requireThat(validDay(through));
    return this.store.tx(() => {
      const s = this.state();
      this.store.deleteThrough(through);
      s.cutoff = s.cutoff > through ? s.cutoff : through;
      s.fence++;
      this.store.set("capacity", s);
      return { erased_through: s.cutoff };
    });
  }
  status() {
    const s = this.state(),
      m = this.store.meter(),
      rows = this.store.rows();
    let capacityGap = null;
    try {
      this.admission({ ...s, encryptions: 0, key_created: this.now() });
    } catch {
      capacityGap =
        "Physical accounting or key/work budget unavailable; collection paused";
    }
    return {
      measurement_mode:
        s.enabled && !capacityGap && (this.synthetic || this.qualified)
          ? this.synthetic
            ? "local_synthetic"
            : "production"
          : "disabled",
      synthetic: this.synthetic,
      runtime_mode: this.production ? "production" : "local",
      key_version: s.key_version || 1,
      blocked_reason: this.qualified
        ? s.gap || capacityGap || (s.enabled ? null : "Collection disabled")
        : this.synthetic
          ? s.gap || capacityGap || "Synthetic fixture only"
          : "Production policy and provider qualification absent",
      key_maintenance: this.production
        ? "Automatic atomic rotation at 89 days or 999,000 encryptions; private rotateDataKey RPC retries after restoring physical headroom"
        : "Local rotation maintenance required at 90 days / 1M encryptions",
      storage: {
        ...m,
        reserved_journal_bytes: 8388608,
        per_mutation_reservation: 393216,
        primary_stop_bytes: 6000000,
        primary_hard_bytes: 8388608,
        managed_total_stop_bytes: 20000000,
        earliest_aggregate_date: rows[0]?.day || null,
        pruned_dates: s.pruned,
        delete_reclaims_allocation: false,
        raw: "Not stored",
        cutoff: s.cutoff,
      },
      backup: {
        last_generated: s.backup_generated || null,
        last_verified_restore: s.restore_verified || null,
        mode: this.production
          ? "Workers bounded encrypted buffered archive; maximum 2 MB; no streaming guarantee"
          : "Local bounded archive; production streaming unavailable",
        maximum_archive_bytes: 2000000,
      },
      auth: "TOTP possession only; no password or OAuth",
      cloudflare: this.production
        ? "Single SQLite Durable Object; physical database metered; shared quotas, replication/PITR and privacy qualification are external"
        : "Collection disabled: growth, reclamation, shared quotas and privacy unqualified",
    };
  }
  backup() {
    return this.store.tx(() => {
      const s = this.state();
      this.pruneInTransaction(s);
      this.rotateInTransaction(s, 0);
      const snapshot = {
        version: 1,
        created: this.now(),
        cutoff: s.cutoff,
        key: this.store.get("data_key"),
        key_version: s.key_version || 1,
        rows: this.store.rows(),
      };
      const id = this.c.random(),
        key = this.c.key(),
        wrapped = this.c.seal("DATA_KEK", key, "backup-key|" + id),
        payload = this.c.seal(key, snapshot, "backup|" + id);
      const body = { format: "quietstats-local-1", id, wrapped, payload };
      const signed = JSON.stringify(body);
      const archive = JSON.stringify({
        body,
        mac: this.c.mac("BACKUP_AUTH_KEY", signed),
      });
      requireThat(
        new TextEncoder().encode(archive).length <= 2000000,
        503,
        "archive_capacity_exceeded",
      );
      s.backup_generated = this.now();
      this.store.set("capacity", s);
      return new TextEncoder().encode(archive);
    });
  }
  decodeArchive(bytes) {
    requireThat(bytes.byteLength <= 2000000, 413, "body_too_large");
    let envelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw Error("Invalid archive");
    }
    requireThat(
      envelope.body?.format === "quietstats-local-1" &&
        this.c.equal(
          envelope.mac,
          this.c.mac("BACKUP_AUTH_KEY", JSON.stringify(envelope.body)),
        ),
      400,
      "invalid_archive",
    );
    const b = envelope.body,
      key = this.c.open("DATA_KEK", b.wrapped, "backup-key|" + b.id),
      snapshot = this.c.open(key, b.payload, "backup|" + b.id);
    requireThat(
      snapshot.version === 1 &&
        validDay(snapshot.cutoff) &&
        Array.isArray(snapshot.rows) &&
        snapshot.rows.length <= 800,
      400,
      "invalid_archive",
    );
    const dataKey = this.c.open("DATA_KEK", snapshot.key, "analytics-dek|1");
    const partitions = this.partitions(
      snapshot.rows,
      dataKey,
      snapshot.key_version || 1,
    );
    return { snapshot, partitions };
  }
  restore(bytes) {
    const { snapshot, partitions } = this.decodeArchive(bytes);
    const current = this.state();
    const cutoff = [
      current.cutoff,
      snapshot.cutoff,
      dayOf(this.now() - 400 * 86400000),
    ]
      .sort()
      .at(-1);
    const retained = partitions.filter(
      (p) => p.day > cutoff && p.day <= dayOf(this.now()),
    );
    requireThat(retained.length <= 400, 400, "invalid_archive");
    const m = this.store.meter();
    requireThat(
      Number.isFinite(m.bytes) &&
        m.bytes + bytes.byteLength * 3 + 8388608 < 20000000,
      503,
      "temporarily_unavailable",
    );
    // Adapter performs a bounded isolated durable candidate verification before live transaction.
    if (this.production)
      this.admission({ ...current, encryptions: 0, key_created: this.now() });
    this.store.verifyCandidate?.(retained, this.c, this.key());
    return this.store.tx(() => {
      const s = this.state();
      requireThat(s.cutoff <= cutoff, 409, "state_conflict");
      this.rotateInTransaction(s, retained.length * 2);
      this.admission(s);
      this.store.deleteThrough("9999-12-31");
      for (const p of retained)
        this.writePartition(p, this.key(), s.key_version || 1);
      s.cutoff = cutoff;
      s.fence++;
      s.restore_verified = this.now();
      s.encryptions += retained.length * 2;
      this.store.set("capacity", s);
      this.admission(s);
      return { restored_dates: retained.length, erasure_cutoff: cutoff };
    });
  }
}
