import {
  mkdirSync,
  existsSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { makeSecrets } from "../adapters/local/crypto.mjs";
import { createSystem } from "../server/system.mjs";
const flags = process.argv.slice(2);
if (flags.some((x) => !["--synthetic", "--replace-access"].includes(x)))
  throw Error("Only --synthetic and --replace-access are supported locally");
const dir = resolve(".local");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const configPath = join(dir, "config.json");
if (!existsSync(configPath)) {
  const config = {
    version: 1,
    local_only: true,
    origin: "https://127.0.0.1:4318",
    synthetic: flags.includes("--synthetic"),
    secrets: makeSecrets(),
  };
  writeFileSync(configPath, JSON.stringify(config), {
    mode: 0o600,
    flag: "wx",
  });
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!config.local_only) throw Error("Local fixture only");
const s = createSystem({ dir, ...config });
try {
  const grant = s.access.issueGrant(flags.includes("--replace-access"));
  writeFileSync(join(dir, "setup-grant.txt"), grant, { mode: 0o600 });
  chmodSync(join(dir, "setup-grant.txt"), 0o600);
} finally {
  s.close();
}
if (!existsSync(join(dir, "tls-cert.pem"))) {
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "tls-key.pem"),
        "-out",
        join(dir, "tls-cert.pem"),
        "-days",
        "30",
        "-subj",
        "/CN=QuietStats local example",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  } catch {
    if (!existsSync(join(dir, "tls-cert.pem")))
      throw Error("Local TLS generation unavailable; no server started");
  }
}
new X509Certificate(readFileSync(join(dir, "tls-cert.pem")));
chmodSync(join(dir, "tls-key.pem"), 0o600);
chmodSync(join(dir, "tls-cert.pem"), 0o600);
console.log(
  "Local setup material saved in protected .local/ files. No values printed. Open the normal setup page after build/start.",
);
