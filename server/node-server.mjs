import { createServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { Readable } from "node:stream";
import { createHandler, base } from "./http.mjs";
const types = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const security = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store, no-transform",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
export function nodeServer(
  system,
  { origin, key, cert, dist = resolve("dist") },
) {
  const handle = createHandler(system, { origin });
  return createServer({ key, cert }, async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(403, security);
        res.end("Forbidden");
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(["GET", "HEAD"].includes(req.method)
            ? {}
            : { body: Readable.toWeb(req), duplex: "half" }),
        });
        const result = await handle(request, {
          source: req.socket.remoteAddress,
        });
        const headers = Object.fromEntries(result.headers);
        const cookies = result.headers.getSetCookie();
        if (cookies.length) headers["set-cookie"] = cookies;
        res.writeHead(result.status, headers);
        res.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405, security);
        res.end();
        return;
      }
      if (url.pathname === "/admin" || url.pathname === "/access") {
        const kind = url.pathname === "/admin" ? "normal" : "access",
          name = kind === "normal" ? "__Host-qs_sid" : "__Host-qs_access";
        const cookie = (req.headers.cookie || "")
          .split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith(name + "="))
          ?.slice(name.length + 1);
        try {
          system.access.authorize(cookie, kind);
        } catch {
          res.writeHead(303, { ...security, location: "/login?expired=1" });
          res.end();
          return;
        }
      }
      const pages = [
        "/",
        "/login",
        "/setup",
        "/recovery",
        "/access",
        "/admin",
        "/help",
      ];
      let target = pages.includes(url.pathname)
        ? join(dist, "index.html")
        : resolve(dist, "." + url.pathname);
      if (!target.startsWith(dist + "/") || url.search || !existsSync(target)) {
        if (pages.includes(url.pathname) && url.search === "?expired=1")
          target = join(dist, "index.html");
        else {
          res.writeHead(404, security);
          res.end("Not found");
          return;
        }
      }
      const data = readFileSync(target);
      res.writeHead(200, {
        ...security,
        "content-type": types[extname(target)] || "application/octet-stream",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(503, security);
      res.end("Temporarily unavailable");
    }
  });
}
