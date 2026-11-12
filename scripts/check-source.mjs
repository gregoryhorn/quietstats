import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import * as prettier from "prettier";
export function safeText(text, denylist = []) {
  const decoded = text
    .replace(/\\u([a-fA-F0-9]{4})/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    )
    .replace(/%([a-fA-F0-9]{2})/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    );
  const variants = [text, decoded];
  for (const token of decoded.match(/[A-Za-z0-9+/]{24,}={0,2}/g) || []) {
    try {
      variants.push(Buffer.from(token, "base64").toString());
    } catch {}
  }
  if (
    variants.some((s) =>
      denylist.some((d) => s.toLowerCase().includes(d.toLowerCase())),
    )
  )
    return false;
  return (
    !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(text) &&
    !/(?:sk-proj-|github_pat_|ghp_)[A-Za-z0-9_-]{15,}/.test(text) &&
    !/otpauth:\/\/totp\/[^\s"']*\?secret=[A-Z2-7]{16,}/i.test(text)
  );
}
export function walk(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name),
      s = lstatSync(path);
    if (s.isSymbolicLink() || (s.nlink !== 1 && s.isFile()))
      throw Error("Unexpected linked source member");
    if (s.isDirectory()) files.push(...walk(path));
    else if (s.isFile()) files.push(path);
    else throw Error("Unexpected source member");
  }
  return files;
}
export async function checkFunctions(files) {
  let maximum = 0,
    count = 0;
  for (const file of files.filter(
    (f) => /\.(mjs|jsx|js)$/.test(f) && !f.startsWith("vendor/"),
  )) {
    const { ast } = await prettier.__debug.parse(readFileSync(file, "utf8"), {
      parser: "babel",
      filepath: file,
    });
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (/Function|Method/.test(node.type || "") && node.loc) {
        const span = node.loc.end.line - node.loc.start.line + 1;
        maximum = Math.max(span, maximum);
        count++;
        if (span > 300) throw Error(`Function exceeds 300 lines in ${file}`);
      }
      for (const [k, v] of Object.entries(node)) {
        if (["loc", "tokens", "comments"].includes(k)) continue;
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === "object") visit(v);
      }
    };
    visit(ast);
  }
  return { functions: count, maximum_lines: maximum };
}
