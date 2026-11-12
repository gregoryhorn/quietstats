import { Buffer } from "node:buffer";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { TOTP, Secret } from "otpauth";
export const roles = [
  "DATA_KEK",
  "AUTH_KEK",
  "RECOVERY_PEPPER",
  "LIMIT_PEPPER",
  "BACKUP_AUTH_KEY",
];
export function makeSecrets() {
  return Object.fromEntries(
    roles.map((k) => [k, randomBytes(32).toString("base64url")]),
  );
}
export function makeCrypto(secrets, namespace = "quietstats-local-v1") {
  for (const role of roles)
    if (
      typeof secrets[role] !== "string" ||
      Buffer.from(secrets[role], "base64url").length !== 32
    )
      throw Error("Missing secret role");
  if (new Set(roles.map((r) => secrets[r])).size !== roles.length)
    throw Error("Keys must be independent");
  const key = (r) =>
    secrets[r]
      ? Buffer.from(secrets[r], "base64url")
      : Buffer.from(r, "base64url");
  const equal = (a, b) => {
    const aa = Buffer.from(String(a)),
      bb = Buffer.from(String(b));
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  };
  const mac = (role, value) =>
    createHmac("sha256", key(role))
      .update(namespace + "|" + value)
      .digest("base64url");
  return {
    random: () => randomBytes(32).toString("base64url"),
    key: () => randomBytes(32).toString("base64url"),
    digest: (v) => createHash("sha256").update(v).digest("base64url"),
    mac,
    equal,
    seal(role, value, context) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key(role), nonce);
      cipher.setAAD(Buffer.from(`${namespace}|v1|${context}`));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return {
        v: 1,
        nonce: nonce.toString("base64url"),
        data: data.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      };
    },
    open(role, e, context) {
      if (e?.v !== 1) throw Error("Invalid envelope");
      const d = createDecipheriv(
        "aes-256-gcm",
        key(role),
        Buffer.from(e.nonce, "base64url"),
      );
      d.setAAD(Buffer.from(`${namespace}|v1|${context}`));
      d.setAuthTag(Buffer.from(e.tag, "base64url"));
      return JSON.parse(
        Buffer.concat([
          d.update(Buffer.from(e.data, "base64url")),
          d.final(),
        ]).toString("utf8"),
      );
    },
    newSeed: () => new Secret({ size: 20 }).base32,
    matches(seed, code, now) {
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) return [];
      const t = new TOTP({
        secret: Secret.fromBase32(seed),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const step = Math.floor(now / 30000);
      return [-1, 0, 1]
        .map((d) => step + d)
        .filter((s) => equal(t.generate({ timestamp: s * 30000 }), code));
    },
    recovery() {
      const b = randomBytes(16);
      const raw = new Secret({
        buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      }).base32;
      return raw.match(/.{1,5}/g).join("-");
    },
    canonical(v) {
      if (typeof v !== "string") return null;
      const s = v.replace(/[ -]/g, "").toUpperCase();
      if (!/^[A-Z2-7]{25}[AEIMQUY4]$/.test(s)) return null;
      try {
        return Secret.fromBase32(s).base32 === s ? s : null;
      } catch {
        return null;
      }
    },
  };
}
