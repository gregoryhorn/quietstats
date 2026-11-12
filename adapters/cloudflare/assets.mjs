import { basename } from "./config.mjs";
export const security = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store, private, no-transform",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-resource-policy": "same-origin",
};
export function plain(text, status = 404, headers = {}) {
  return new Response(text, { status, headers: { ...security, ...headers } });
}
export async function serveAssets(request, env, authority) {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method))
    return plain("Method not allowed", 405);
  if (url.pathname === basename)
    return plain(null, 308, { location: basename + "/" });
  const path = url.pathname.slice(basename.length);
  if (["/admin", "/access"].includes(path)) {
    if (
      !(await authority.authorizePage(
        request,
        path === "/admin" ? "normal" : "access",
      ))
    )
      return plain(null, 303, { location: basename + "/login?expired=1" });
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
  const html =
    pages.includes(path) || ["/privacy", "/privacy.html"].includes(path);
  if (
    (url.search && !(pages.includes(path) && url.search === "?expired=1")) ||
    (!html &&
      !/^\/(assets\/[a-zA-Z0-9_.-]+|quietstats-logo-dark\.webp|privacy\.css|manrope\.woff2)$/.test(
        path,
      ))
  )
    return plain("Not found");
  url.pathname = pages.includes(path)
    ? "/index.html"
    : path === "/privacy"
      ? "/privacy.html"
      : path;
  url.search = "";
  const asset = await env.ASSETS.fetch(
    new Request(url, { method: request.method }),
  );
  const headers = new Headers(asset.headers);
  for (const [k, v] of Object.entries(security)) headers.set(k, v);
  if (!html && path.startsWith("/assets/") && asset.ok)
    headers.set("cache-control", "public, max-age=31536000, immutable");
  if (html) headers.delete("etag");
  return new Response(asset.body, { status: asset.status, headers });
}
