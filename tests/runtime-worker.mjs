// TEST-ONLY entrypoint. Never use this class in a deployment configuration.
import worker, { QuietStatsAuthority } from "../adapters/cloudflare/worker.mjs";
import { AccessService } from "../core/access.mjs";
import { DataService } from "../core/data.mjs";
import { createHandler } from "../server/http.mjs";
import { configuration } from "../adapters/cloudflare/config.mjs";
export class RuntimeAuthority extends QuietStatsAuthority {
  testClock(time) {
    this.time = time;
    const clock = () => this.time;
    this.store.clock = clock;
    // This isolated fixture deliberately freezes time; no such RPC is exported by the deployed class.
    this.store.tx(() => {
      const authority = this.store.get("authority");
      authority.clock = Math.min(authority.clock, time);
      this.store.set("authority", authority);
    });
    const config = configuration(this.env);
    this.access = new AccessService(this.store, this.crypto, clock, {
      hosted: true,
    });
    this.data = new DataService(this.store, this.crypto, clock, config.routes, {
      production: true,
      qualified: config.qualified,
    });
    this.handler = createHandler(
      { access: this.access, data: this.data, now: clock },
      { origin: config.origin },
    );
  }
  testInspect() {
    const authority = this.store.get("authority");
    const rows = this.store.rows();
    return {
      authority: this.crypto.digest(JSON.stringify(authority)),
      key: this.crypto.digest(JSON.stringify(this.store.get("data_key"))),
      rows: this.crypto.digest(JSON.stringify(rows)),
      count: rows.length,
      versions: [...new Set(rows.map((r) => r.envelope.kv || 1))],
      capacity: this.data.state(),
      physical: this.store.meter().bytes,
      candidate: this.store.sql
        .exec("SELECT count(*) AS n FROM restore_candidate")
        .one().n,
    };
  }
  testCapacity(patch) {
    this.store.tx(() =>
      this.store.set("capacity", { ...this.data.state(), ...patch }),
    );
  }
  testOldPartition(day) {
    this.store.tx(() =>
      this.data.writePartition({ day, counts: { landing: 5, library: 0 } }),
    );
  }
  testMeter(mode) {
    if (!this.realMeter) this.realMeter = this.store.meter.bind(this.store);
    this.store.meter =
      mode === "normal"
        ? this.realMeter
        : () => ({
            ...this.realMeter(),
            ...(mode === "unknown"
              ? { bytes: NaN }
              : mode === "stale"
                ? { at: this.time - 60001 }
                : mode === "future"
                  ? { at: this.time + 1 }
                  : { bytes: 5800000, database_bytes: 5800000 }),
          });
  }
  testFailWrite(enabled) {
    if (!this.realPut) this.realPut = this.store.put.bind(this.store);
    let n = 0;
    this.store.put = enabled
      ? (...args) => {
          this.realPut(...args);
          if (++n === 2) throw Error("Injected transactional failure");
        }
      : this.realPut;
  }
  testPhysicalPressure() {
    this.store.tx(() => {
      this.store.sql.exec("CREATE TABLE IF NOT EXISTS pressure(value BLOB)");
      while (this.store.meter().bytes < 5700000)
        this.store.sql.exec("INSERT INTO pressure VALUES(zeroblob(32768))");
    });
    return this.store.meter().bytes;
  }
  testHardBudgetRollback() {
    try {
      this.store.tx(() => {
        for (let i = 0; i < 100; i++)
          this.store.sql.exec("INSERT INTO pressure VALUES(zeroblob(32768))");
      });
      return false;
    } catch {
      return true;
    }
  }
}
export default worker;

export { QuietStatsOperator } from "../adapters/cloudflare/worker.mjs";
