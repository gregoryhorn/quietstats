import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { requireThat } from "../core/contracts.mjs";
export const stateDir = resolve(".local");
export function loadLocal() {
  requireThat(
    !process.env.NODE_ENV ||
      ["development", "test"].includes(process.env.NODE_ENV),
    503,
    "production_unqualified",
  );
  const path = join(stateDir, "config.json"),
    s = lstatSync(path);
  requireThat(
    s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0,
    503,
    "unsafe_local_state",
  );
  const c = JSON.parse(readFileSync(path, "utf8"));
  requireThat(
    c.local_only === true &&
      c.version === 1 &&
      c.origin === "https://127.0.0.1:4318",
    503,
    "invalid_configuration",
  );
  return { ...c, dir: stateDir };
}
