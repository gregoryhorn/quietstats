import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  statSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { requireThat } from "../../core/contracts.mjs";
export class LocalStore {
  constructor(dir, clock = Date.now) {
    this.dir = dir;
    this.clock = clock;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.path = join(dir, "state.sqlite");
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=2048; PRAGMA busy_timeout=2000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS aggregates(day TEXT NOT NULL,family TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(day,family));",
    );
  }
  get(k) {
    const r = this.db.prepare("SELECT value FROM state WHERE key=?").get(k);
    return r ? JSON.parse(r.value) : null;
  }
  set(k, v) {
    const s = JSON.stringify(v);
    requireThat(Buffer.byteLength(s) <= 262144, 503, "temporarily_unavailable");
    this.db
      .prepare(
        "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(k, s);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  rows() {
    return this.db
      .prepare("SELECT day,family,envelope FROM aggregates ORDER BY day,family")
      .all()
      .map((r) => ({ ...r, envelope: JSON.parse(r.envelope) }));
  }
  put(day, family, envelope) {
    const value = JSON.stringify(envelope);
    requireThat(
      Buffer.byteLength(value) <= 4096,
      503,
      "temporarily_unavailable",
    );
    this.db
      .prepare(
        "INSERT INTO aggregates VALUES(?,?,?) ON CONFLICT(day,family) DO UPDATE SET envelope=excluded.envelope",
      )
      .run(day, family, value);
  }
  deleteThrough(day) {
    this.db.prepare("DELETE FROM aggregates WHERE day<=?").run(day);
  }
  meter() {
    let bytes = 0;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name),
        s = lstatSync(path);
      requireThat(
        s.isFile() && !s.isSymbolicLink(),
        503,
        "temporarily_unavailable",
      );
      bytes += Math.max(s.size, s.blocks * 512);
    }
    const pages =
      this.db.prepare("PRAGMA page_count").get().page_count *
      this.db.prepare("PRAGMA page_size").get().page_size;
    return {
      bytes: Math.max(bytes, pages),
      database_bytes: pages,
      at: this.clock(),
      source:
        "Local filesystem allocated blocks + SQLite pages; DELETE journal reserve separate",
    };
  }
  verifyCandidate(partitions, crypto, key) {
    const path = join(this.dir, "restore-candidate.sqlite");
    let candidate;
    try {
      candidate = new DatabaseSync(path);
      chmodSync(path, 0o600);
      candidate.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=1024; CREATE TABLE parts(day TEXT PRIMARY KEY,envelope TEXT NOT NULL)",
      );
      const put = candidate.prepare("INSERT INTO parts VALUES(?,?)");
      for (const p of partitions)
        put.run(
          p.day,
          JSON.stringify(crypto.seal(key, p, "candidate|" + p.day)),
        );
      for (const row of candidate.prepare("SELECT * FROM parts").all()) {
        const value = crypto.open(
          key,
          JSON.parse(row.envelope),
          "candidate|" + row.day,
        );
        requireThat(value.day === row.day, 400, "invalid_archive");
      }
      requireThat(
        statSync(path).size <= 4194304,
        503,
        "temporarily_unavailable",
      );
    } finally {
      candidate?.close();
      rmSync(path, { force: true });
      rmSync(path + "-journal", { force: true });
    }
  }
  close() {
    this.db.close();
  }
}
