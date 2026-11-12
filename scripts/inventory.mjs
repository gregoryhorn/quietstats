import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")),
  items = [];
mkdirSync("public/third-party", { recursive: true });
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || info.link) continue;
  const file = join(path, "package.json");
  if (!existsSync(file)) continue;
  const p = JSON.parse(readFileSync(file, "utf8")),
    notices = [];
  for (const f of readdirSync(path)) {
    if (
      /^(licen[cs]e|notice|copying)([._-]|$)/i.test(f) &&
      statSync(join(path, f)).isFile()
    ) {
      const target = (p.name + "-" + p.version + "-" + f).replaceAll("/", "__");
      copyFileSync(join(path, f), join("public/third-party", target));
      notices.push("public/third-party/" + target);
    }
  }
  items.push({
    name: p.name,
    version: p.version,
    license: p.license || "UNKNOWN",
    development: !!info.dev,
    source: info.resolved || "npm registry",
    notices,
  });
}
items.push({
  name: "otpauth",
  version: "9.4.1",
  license: "MIT",
  development: false,
  source: "https://github.com/hectorm/otpauth/tree/v9.4.1",
  notices: ["vendor/otpauth/LICENSE.md"],
});
items.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  "DEPENDENCIES.json",
  JSON.stringify({ format: 1, packages: items }, null, 2) + "\n",
);
console.log("Dependency/licence inventory:", items.length, "packages");
