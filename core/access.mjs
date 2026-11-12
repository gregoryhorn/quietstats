import { Fault, requireThat, dayOf } from "./contracts.mjs";
const fail = () => {
  throw new Fault(401, "access_failed");
};
export class AccessService {
  constructor(store, crypto, clock, { hosted = false } = {}) {
    this.hosted = hosted;
    this.store = store;
    this.c = crypto;
    this.now = clock;
    if (!store.get("authority"))
      store.tx(() => {
        store.set("authority", {
          epoch: 0,
          seed: null,
          last: -1,
          codes: [],
          pending: null,
          grant: null,
          clock: clock(),
        });
        store.set("sessions", []);
        store.set("limits", []);
      });
  }
  state() {
    const s = this.store.get("authority");
    requireThat(this.now() >= s.clock - 30000, 503, "temporarily_unavailable");
    return s;
  }
  save(s) {
    s.clock = Math.max(s.clock, this.now());
    this.store.set("authority", s);
  }
  space() {
    const m = this.store.meter();
    requireThat(
      Number.isFinite(m.bytes) &&
        this.now() - m.at <= 60000 &&
        m.bytes + 524288 < 6000000,
      503,
      "temporarily_unavailable",
    );
  }
  prune(s) {
    if (s.pending && s.pending.expires <= this.now()) {
      s.pending = null;
      this.save(s);
    }
    const sessions = this.store
      .get("sessions")
      .filter(
        (x) =>
          x.expires > this.now() &&
          x.epoch === s.epoch &&
          (x.kind !== "normal" || x.touched + 600000 > this.now()),
      );
    this.store.set("sessions", sessions);
    return sessions;
  }
  csrf(token) {
    return this.c.mac("LIMIT_PEPPER", "csrf|" + token);
  }
  mint(kind, s, sessions) {
    const token = this.c.random(),
      csrf = this.csrf(token),
      now = this.now();
    sessions.push({
      id: this.c.digest(token),
      csrf: this.c.digest(csrf),
      kind,
      epoch: s.epoch,
      created: now,
      touched: now,
      expires:
        now + (kind === "pre" ? 300000 : kind === "normal" ? 1800000 : 600000),
    });
    if (kind === "normal") {
      const normals = sessions
        .filter((x) => x.kind === "normal")
        .sort((a, b) => a.created - b.created);
      while (normals.length > 5) {
        const victim = normals.shift();
        sessions.splice(
          sessions.findIndex((x) => x.id === victim.id),
          1,
        );
      }
    }
    requireThat(sessions.length <= 128, 429, "try_later");
    this.store.set("sessions", sessions);
    return { token, csrf, kind };
  }
  maintain() {
    return this.store.tx(() => {
      const s = this.state();
      this.prune(s);
      this.store.set(
        "limits",
        (this.store.get("limits") || []).filter((x) => x.until > this.now()),
      );
    });
  }
  challenge() {
    return this.store.tx(() => {
      this.space();
      const s = this.state(),
        sessions = this.prune(s);
      return this.mint("pre", s, sessions);
    });
  }
  authorize(token, kind, csrf) {
    const s = this.state(),
      sessions = this.store.get("sessions");
    const session = sessions.find((x) =>
      this.c.equal(x.id, this.c.digest(token || "")),
    );
    if (
      !session ||
      session.epoch !== s.epoch ||
      session.expires <= this.now() ||
      session.kind !== kind ||
      (kind === "normal" && session.touched + 600000 <= this.now())
    )
      fail();
    if (csrf && !this.c.equal(session.csrf, this.c.digest(csrf)))
      throw new Fault(403, "forbidden");
    return session;
  }
  guard(token, kind, csrf) {
    requireThat(typeof csrf === "string" && csrf.length > 0, 403, "forbidden");
    return this.authorize(token, kind, csrf);
  }
  rate(source, lane = "login") {
    this.store.tx(() => {
      this.space();
      const now = this.now(),
        key = this.c.mac("LIMIT_PEPPER", `${lane}|${dayOf(now)}|${source}`),
        list = (this.store.get("limits") || []).filter((x) => x.until > now);
      const rules =
        lane === "login"
          ? [
              [300000, 3, 12],
              [3600000, 10, 120],
            ]
          : lane === "measure"
            ? [
                [60000, 60, 2000],
                [86400000, 2000, 2000],
              ]
            : [
                [900000, 5, 1000],
                [3600000, 10, 1000],
              ];
      const updates = [];
      for (const [window, per, global] of rules) {
        const start = Math.floor(now / window) * window;
        for (const [id, max] of [
          [key, per],
          ["global:" + lane, global],
        ]) {
          let r = list.find(
            (x) => x.key === id && x.start === start && x.window === window,
          );
          if (!r) {
            requireThat(
              list.length < 2048 &&
                (id.startsWith("global:") ||
                  list.some((x) => x.key === id) ||
                  new Set(
                    list
                      .filter((x) => !x.key.startsWith("global:"))
                      .map((x) => x.key),
                  ).size < 512),
              429,
              "try_later",
            );
            r = { key: id, start, window, until: start + window, count: 0 };
            list.push(r);
          }
          requireThat(r.count < max, 429, "try_later");
          updates.push(r);
        }
      }
      for (const r of updates) r.count++;
      this.store.set("limits", list);
    });
  }
  step(seed, code, last) {
    const matches = this.c.matches(seed, code, this.now());
    if (!matches.length || matches.some((s) => s <= last)) fail();
    return Math.max(...matches);
  }
  issueGrant(replace = false) {
    return this.store.tx(() => {
      this.space();
      const s = this.state();
      requireThat(!s.seed || replace, 409, "state_conflict");
      if (replace) {
        s.seed = null;
        s.last = -1;
        s.codes = [];
        s.pending = null;
        s.epoch++;
        this.store.set("sessions", []);
      }
      const grant = this.c.random();
      s.grant = { digest: this.c.digest(grant), expires: this.now() + 600000 };
      this.save(s);
      return grant;
    });
  }
  login(pre, csrf, code, source) {
    this.rate(source);
    return this.store.tx(() => {
      this.space();
      this.guard(pre, "pre", csrf);
      const s = this.state();
      if (!s.seed) fail();
      const seed = this.c.open("AUTH_KEK", s.seed, "active-seed");
      s.last = this.step(seed, code, s.last);
      const sessions = this.prune(s).filter((x) => x.id !== this.c.digest(pre));
      this.save(s);
      return this.mint("normal", s, sessions);
    });
  }
  start(pre, csrf, input, source, kind) {
    this.rate(source, "recovery");
    return this.store.tx(() => {
      this.space();
      this.guard(pre, "pre", csrf);
      const s = this.state(),
        sessions = this.prune(s);
      requireThat(!s.pending, 409, "state_conflict");
      if (kind === "setup") {
        if (
          s.seed ||
          !s.grant ||
          s.grant.expires <= this.now() ||
          !this.c.equal(s.grant.digest, this.c.digest(input || ""))
        )
          fail();
        s.grant = null;
      } else {
        const canonical = this.c.canonical(input);
        const code = canonical
          ? s.codes.find(
              (x) =>
                !x.used &&
                this.c.equal(
                  x.verifier,
                  this.c.mac("RECOVERY_PEPPER", `${s.generation}|${canonical}`),
                ),
            )
          : null;
        if (!code) fail();
        code.used = true;
      }
      s.pending = {
        id: this.c.random(),
        epoch: s.epoch,
        expires: this.now() + 600000,
        seed: null,
        last: -1,
        confirmed: false,
        codes: [],
        generation: null,
        kind,
      };
      this.save(s);
      return this.mint(
        "access",
        s,
        sessions.filter((x) => x.id !== this.c.digest(pre)),
      );
    });
  }
  exchange(pre, csrf, grant, source) {
    return this.start(pre, csrf, grant, source, "setup");
  }
  recover(pre, csrf, code, source) {
    return this.start(pre, csrf, code, source, "recovery");
  }
  pending(token, csrf) {
    this.guard(token, "access", csrf);
    const s = this.state();
    requireThat(
      s.pending &&
        s.pending.epoch === s.epoch &&
        s.pending.expires > this.now(),
      401,
      "access_failed",
    );
    return s;
  }
  accessState(token) {
    const s = this.pending(token, this.csrf(token)),
      p = s.pending;
    return {
      attempt_id: p.id,
      stage: p.generation
        ? "codes"
        : p.confirmed
          ? "confirmed"
          : p.seed
            ? "seed"
            : "open",
      expires_at: p.expires,
      csrf_token: this.csrf(token),
      codes_generation: p.generation,
    };
  }
  seed(token, csrf, rotate = false) {
    return this.store.tx(() => {
      this.space();
      const s = this.pending(token, csrf),
        p = s.pending;
      if (!p.seed || rotate) {
        p.seed = this.c.seal(
          "AUTH_KEK",
          this.c.newSeed(),
          "pending-seed|" + p.id,
        );
        p.last = -1;
        p.confirmed = false;
        p.codes = [];
        p.generation = null;
        this.save(s);
      }
      const seed = this.c.open("AUTH_KEK", p.seed, "pending-seed|" + p.id);
      const issuer = this.hosted ? "QuietStats" : "QuietStats local example";
      const label = this.hosted ? "Owner" : "Synthetic owner";
      return {
        seed,
        attempt_id: p.id,
        issuer,
        label,
        uri: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${seed}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
      };
    });
  }
  confirm(token, csrf, code) {
    return this.store.tx(() => {
      const s = this.pending(token, csrf),
        p = s.pending;
      requireThat(p.seed, 409, "state_conflict");
      p.last = this.step(
        this.c.open("AUTH_KEK", p.seed, "pending-seed|" + p.id),
        code,
        p.last,
      );
      p.confirmed = true;
      this.save(s);
      return { stage: "confirmed" };
    });
  }
  codes(token, csrf) {
    return this.store.tx(() => {
      this.space();
      const s = this.pending(token, csrf),
        p = s.pending;
      requireThat(p.confirmed, 409, "state_conflict");
      const codes = Array.from({ length: 10 }, () => this.c.recovery());
      p.generation = this.c.random();
      p.codes = codes.map((code) => ({
        verifier: this.c.mac(
          "RECOVERY_PEPPER",
          p.generation + "|" + this.c.canonical(code),
        ),
        used: false,
      }));
      this.save(s);
      return { codes, generation: p.generation };
    });
  }
  commit(token, csrf, input) {
    return this.store.tx(() => {
      this.space();
      const s = this.pending(token, csrf),
        p = s.pending;
      requireThat(
        p.confirmed &&
          p.generation &&
          input.codes_saved === true &&
          input.codes_generation === p.generation &&
          input.attempt_id === p.id,
        409,
        "state_conflict",
      );
      const seed = this.c.open("AUTH_KEK", p.seed, "pending-seed|" + p.id);
      const last = this.step(seed, input.code, p.last);
      s.seed = this.c.seal("AUTH_KEK", seed, "active-seed");
      s.last = last;
      s.codes = p.codes;
      s.generation = p.generation;
      s.epoch++;
      s.pending = null;
      s.grant = null;
      this.save(s);
      this.store.set("sessions", []);
      return { committed: true };
    });
  }
  cancel(token, csrf) {
    return this.store.tx(() => {
      const s = this.pending(token, csrf);
      s.pending = null;
      this.save(s);
      this.store.set(
        "sessions",
        this.store.get("sessions").filter((x) => x.kind !== "access"),
      );
      return { cancelled: true };
    });
  }
  logout(token, csrf) {
    return this.store.tx(() => {
      this.guard(token, "normal", csrf);
      this.store.set(
        "sessions",
        this.store.get("sessions").filter((x) => x.id !== this.c.digest(token)),
      );
      return { logged_out: true };
    });
  }
  touch(token, csrf) {
    return this.store.tx(() => {
      const session = this.guard(token, "normal", csrf);
      const sessions = this.store.get("sessions");
      const row = sessions.find((x) => x.id === session.id);
      if (this.now() - row.touched >= 60000) row.touched = this.now();
      this.store.set("sessions", sessions);
      return {
        idle_expires_at: row.touched + 600000,
        absolute_expires_at: row.expires,
      };
    });
  }
}
