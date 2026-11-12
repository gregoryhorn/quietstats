import { readFileSync, writeFileSync, lstatSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { walk, safeText, checkFunctions } from "./check-source.mjs";
const folders = [
  "core",
  "adapters",
  "server",
  "client",
  "public",
  "vendor",
  "tests",
];
const fixed = [
  ".gitignore",
  ".npmrc",
  "package.json",
  "package-lock.json",
  "index.html",
  "vite.config.js",
  "wrangler.example.jsonc",
  "vitest.config.js",
  "README.md",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "DEPENDENCIES.json",
  "scripts/setup.mjs",
  "scripts/package.mjs",
  "scripts/check-source.mjs",
  "scripts/inventory.mjs",
];
const files = [...folders.flatMap(walk), ...fixed].sort();
const denylist = process.env.QUIETSTATS_PRIVATE_DENYLIST
  ? JSON.parse(process.env.QUIETSTATS_PRIVATE_DENYLIST)
  : [];
let bytes = 0;
const manifest = [];
for (const path of files) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Unexpected source member");
  const data = readFileSync(path);
  bytes += data.length;
  if (bytes > 20000000) throw Error("Source package exceeds budget");
  if (!safeText(data.toString("utf8"), denylist))
    throw Error("Source boundary scan failed");
  manifest.push({
    path,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const functionEvidence = await checkFunctions(files);
const manifestData = Buffer.from(
  JSON.stringify({ format: 1, members: manifest }, null, 2) + "\n",
);
const members = [
  ...files.map((path) => ({ path, data: readFileSync(path) })),
  { path: "SOURCE-MANIFEST.json", data: manifestData },
];
const blocks = [];
function oct(n, len) {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}
for (const { path, data } of members) {
  const name = "quietstats/" + path;
  if (Buffer.byteLength(name) > 100) throw Error("Member path too long");
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(oct(0o644, 8), 100);
  h.write(oct(0, 8), 108);
  h.write(oct(0, 8), 116);
  h.write(oct(data.length, 12), 124);
  h.write(oct(0, 12), 136);
  h.fill(32, 148, 156);
  h[156] = 48;
  h.write("ustar\0", 257);
  h.write("00", 263);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
blocks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/quietstats-source.tgz", archive);
writeFileSync("evidence/source-manifest.json", manifestData);
const plain = gunzipSync(archive),
  names = [];
for (let pos = 0; pos < plain.length;) {
  const h = plain.subarray(pos, pos + 512);
  const name = h.subarray(0, 100).toString().replace(/\0.*$/s, "");
  if (!name) break;
  names.push(name);
  const size = parseInt(
    h.subarray(124, 136).toString().replace(/\0.*$/s, ""),
    8,
  );
  pos += 512 + Math.ceil(size / 512) * 512;
}
if (
  JSON.stringify(names) !==
  JSON.stringify(members.map((x) => "quietstats/" + x.path))
)
  throw Error("Archive enumeration mismatch");
const result = {
  status: "passed",
  files: members.length,
  source_bytes: bytes,
  archive_bytes: archive.length,
  sha256: createHash("sha256").update(archive).digest("hex"),
  ...functionEvidence,
  history: "No Git metadata accessed or included; no history certification",
};
writeFileSync("evidence/package-result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
