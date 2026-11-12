import { requireThat } from "../../core/contracts.mjs";
const bytes = (v) => new TextEncoder().encode(v).length;
// One fixed site's authority and analytics share the same synchronous transaction.
export class AuthorityStore {
  constructor(storage, clock = Date.now) {
    this.storage = storage;
    this.sql = storage.sql;
    this.clock = clock;
    this.depth = 0;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS aggregates(day TEXT NOT NULL,family TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(day,family))",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS restore_candidate(day TEXT PRIMARY KEY,envelope TEXT NOT NULL)",
    );
  }
  get(key) {
    const rows = this.sql
      .exec("SELECT value FROM state WHERE key=?", key)
      .toArray();
    return rows.length ? JSON.parse(rows[0].value) : null;
  }
  set(key, value) {
    requireThat(
      [
        "authority",
        "sessions",
        "limits",
        "data_key",
        "capacity",
        "configuration",
      ].includes(key),
      503,
    );
    const text = JSON.stringify(value);
    requireThat(bytes(text) <= 262144, 503, "temporarily_unavailable");
    this.sql.exec(
      "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      text,
    );
  }
  tx(fn) {
    if (this.depth) return fn();
    return this.storage.transactionSync(() => {
      this.depth++;
      try {
        this.checkBudget();
        const result = fn();
        requireThat(!result?.then, 503);
        this.checkBudget();
        return result;
      } finally {
        this.depth--;
      }
    });
  }
  checkBudget() {
    const m = this.meter();
    requireThat(
      Number.isFinite(m.bytes) &&
        m.bytes >= 0 &&
        m.at <= this.clock() &&
        this.clock() - m.at <= 60000 &&
        m.bytes < 8388608,
      503,
      "temporarily_unavailable",
    );
  }
  rows() {
    const rows = this.sql
      .exec(
        "SELECT day,family,envelope FROM aggregates ORDER BY day,family LIMIT 801",
      )
      .toArray();
    requireThat(rows.length <= 800, 503, "temporarily_unavailable");
    return rows.map((r) => ({ ...r, envelope: JSON.parse(r.envelope) }));
  }
  put(day, family, envelope) {
    const text = JSON.stringify(envelope);
    requireThat(bytes(text) <= 4096, 503, "temporarily_unavailable");
    this.sql.exec(
      "INSERT INTO aggregates VALUES(?,?,?) ON CONFLICT(day,family) DO UPDATE SET envelope=excluded.envelope",
      day,
      family,
      text,
    );
    requireThat(
      this.sql.exec("SELECT count(*) AS n FROM aggregates").one().n <= 800,
      503,
    );
  }
  deleteThrough(day) {
    this.sql.exec("DELETE FROM aggregates WHERE day<=?", day);
  }
  meter() {
    const size = this.sql.databaseSize;
    return {
      bytes: size,
      database_bytes: size,
      at: this.clock(),
      source:
        "Durable Object sql.databaseSize; excludes provider replication/PITR/internal bytes; DELETE earns no allocation credit",
    };
  }
  verifyCandidate(partitions, crypto) {
    requireThat(partitions.length <= 400, 400, "invalid_archive");
    const key = crypto.key();
    this.tx(() => {
      const before = this.meter().bytes;
      requireThat(before + 393216 < 6000000, 503, "temporarily_unavailable");
      this.sql.exec("DELETE FROM restore_candidate");
      for (const p of partitions) {
        const text = JSON.stringify(crypto.seal(key, p, "candidate|" + p.day));
        requireThat(bytes(text) <= 4096, 503);
        this.sql.exec("INSERT INTO restore_candidate VALUES(?,?)", p.day, text);
      }
      const read = this.sql
        .exec("SELECT day,envelope FROM restore_candidate ORDER BY day")
        .toArray();
      requireThat(read.length === partitions.length, 400, "invalid_archive");
      for (let i = 0; i < read.length; i++) {
        const p = crypto.open(
          key,
          JSON.parse(read[i].envelope),
          "candidate|" + read[i].day,
        );
        requireThat(
          JSON.stringify(p) === JSON.stringify(partitions[i]),
          400,
          "invalid_archive",
        );
      }
      requireThat(
        this.meter().bytes + 393216 < 6000000,
        503,
        "temporarily_unavailable",
      );
      this.sql.exec("DELETE FROM restore_candidate");
    });
  }
}
