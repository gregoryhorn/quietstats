import { Fault, requireThat, shape, csv } from "../core/contracts.mjs";
export const base = "/api/metrics/v1";
const cookieNames = {
  pre: "__Host-qs_pre",
  normal: "__Host-qs_sid",
  access: "__Host-qs_access",
};
const common = {
  "cache-control": "no-store, private, no-transform",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
};
function cookie(kind, token, max = 600) {
  return `${cookieNames[kind]}=${token}; Path=/; Max-Age=${max}; Secure; HttpOnly; SameSite=Strict`;
}
function cookies(request) {
  const text = request.headers.get("cookie") || "";
  requireThat(text.length <= 4096);
  const out = {};
  for (const pair of text.split(";").filter(Boolean)) {
    const [k, v] = pair.trim().split("=");
    requireThat(!Object.hasOwn(out, k));
    out[k] = v;
  }
  return out;
}
function response(data, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      ...common,
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
async function body(req, limit = 1024) {
  requireThat(
    !req.headers.has("content-encoding"),
    415,
    "unsupported_media_type",
  );
  requireThat(
    req.headers.get("content-type") === "application/json",
    415,
    "unsupported_media_type",
  );
  const length = Number(req.headers.get("content-length") || 0);
  requireThat(
    Number.isFinite(length) && length <= limit,
    413,
    "body_too_large",
  );
  const reader = req.body?.getReader();
  let size = 0,
    chunks = [];
  if (reader)
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Fault(413, "body_too_large");
      }
      chunks.push(r.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Fault();
  }
}
export function createHandler(system, { origin }) {
  const expected = new URL(origin);
  requireThat(
    expected.protocol === "https:" && expected.origin === origin,
    503,
    "invalid_configuration",
  );
  return async function handle(req, { source = "unknown" } = {}) {
    let admitted = false;
    try {
      const url = new URL(req.url);
      requireThat(url.origin === origin, 403, "forbidden");
      requireThat(url.pathname.startsWith(base + "/"), 404, "not_found");
      requireThat(
        ["GET", "POST"].includes(req.method),
        405,
        "method_not_allowed",
      );
      requireThat(
        req.headers.get("sec-fetch-site") === "same-origin" &&
          ["cors", "same-origin"].includes(req.headers.get("sec-fetch-mode")),
        403,
        "forbidden",
      );
      if (req.method === "POST")
        requireThat(req.headers.get("origin") === origin, 403, "forbidden");
      const path = url.pathname.slice(base.length),
        cs = cookies(req),
        token = (kind) => cs[cookieNames[kind]],
        csrf = req.headers.get("x-csrf-token");
      const get = req.method === "GET";
      const routeMethods = {
        "/auth/challenge": "GET",
        "/auth/session": "GET",
        "/auth/login": "POST",
        "/auth/logout": "POST",
        "/auth/touch": "POST",
        "/setup/exchange": "POST",
        "/recovery/start": "POST",
        "/access/state": "GET",
        "/access/seed": "POST",
        "/access/confirm": "POST",
        "/access/codes": "POST",
        "/access/commit": "POST",
        "/access/cancel": "POST",
        "/measure": "POST",
        "/reports": "GET",
        "/export": "GET",
        "/status": "GET",
        "/backup": "POST",
        "/restore": "POST",
        "/erase": "POST",
      };
      requireThat(Object.hasOwn(routeMethods, path), 404, "not_found");
      requireThat(routeMethods[path] === req.method, 405, "method_not_allowed");
      const query = {};
      for (const [k, v] of url.searchParams) {
        requireThat(!Object.hasOwn(query, k));
        query[k] = v;
      }
      if (!["/reports", "/export"].includes(path))
        requireThat(Object.keys(query).length === 0);
      const a = system.access,
        d = system.data;
      const normal = () => a.authorize(token("normal"), "normal");
      const mutation = () => a.guard(token("normal"), "normal", csrf);
      const access = () => a.guard(token("access"), "access", csrf);
      if (path === "/auth/challenge") {
        a.rate(source, "challenge");
        const p = a.challenge();
        return response(
          { csrf_token: p.csrf, expires_at: system.now() + 300000 },
          200,
          { "set-cookie": cookie("pre", p.token, 300) },
        );
      }
      if (path === "/auth/session") {
        const s = normal();
        return response({
          kind: "normal",
          csrf_token: a.csrf(token("normal")),
          epoch: s.epoch,
          idle_expires_at: s.touched + 600000,
          absolute_expires_at: s.expires,
        });
      }
      if (path === "/access/state")
        return response(a.accessState(token("access")));
      if (path === "/status") {
        normal();
        return response(d.status());
      }
      if (path === "/reports" || path === "/export") {
        normal();
        if (path === "/export") mutation();
        const data = d.report(query);
        normal();
        if (path === "/export")
          return new Response(csv(data), {
            headers: {
              ...common,
              "content-type": "text/csv; charset=utf-8",
              "content-disposition":
                'attachment; filename="quietstats-routes.csv"',
            },
          });
        return response(data);
      }
      if (path === "/restore") {
        mutation();
        const input = await body(req, 2800000);
        shape(input, ["archive"]);
        requireThat(
          typeof input.archive === "string" && input.archive.length <= 2000000,
          413,
          "body_too_large",
        );
        const result = d.restore(new TextEncoder().encode(input.archive));
        normal();
        return response(result);
      }
      const input = await body(req, path === "/measure" ? 512 : 1024);
      if (path === "/auth/login") {
        shape(input, ["code"]);
        requireThat(typeof input.code === "string" && input.code.length <= 128);
        const p = a.login(token("pre"), csrf, input.code, source);
        const r = response(null, 204);
        r.headers.append("set-cookie", cookie("normal", p.token, 1800));
        r.headers.append("set-cookie", cookie("pre", "", 0));
        return r;
      }
      if (path === "/setup/exchange" || path === "/recovery/start") {
        const key = path === "/setup/exchange" ? "grant" : "recovery_code";
        shape(input, [key]);
        requireThat(typeof input[key] === "string" && input[key].length <= 128);
        const p =
          key === "grant"
            ? a.exchange(token("pre"), csrf, input[key], source)
            : a.recover(token("pre"), csrf, input[key], source);
        const r = response(null, 204);
        r.headers.append("set-cookie", cookie("access", p.token));
        r.headers.append("set-cookie", cookie("pre", "", 0));
        return r;
      }
      if (path.startsWith("/access/")) {
        access();
        if (path === "/access/seed") {
          shape(input, ["rotate_pending"], []);
          requireThat(
            input.rotate_pending === undefined ||
              typeof input.rotate_pending === "boolean",
          );
          return response(a.seed(token("access"), csrf, input.rotate_pending));
        }
        if (path === "/access/confirm") {
          shape(input, ["code"]);
          return response(a.confirm(token("access"), csrf, input.code));
        }
        if (path === "/access/codes") {
          shape(input, []);
          return response(a.codes(token("access"), csrf));
        }
        if (path === "/access/commit") {
          shape(input, [
            "attempt_id",
            "codes_generation",
            "codes_saved",
            "code",
          ]);
          a.commit(token("access"), csrf, input);
          return response(null, 204, { "set-cookie": cookie("access", "", 0) });
        }
        shape(input, []);
        a.cancel(token("access"), csrf);
        return response(null, 204, { "set-cookie": cookie("access", "", 0) });
      }
      if (path === "/measure") {
        for (const kind of ["normal", "access"]) {
          let owner = false;
          try {
            a.authorize(token(kind), kind);
            owner = true;
          } catch {}
          requireThat(!owner, 403, "forbidden");
        }
        a.rate(source, "measure");
        admitted = true;
        d.collect(input, source);
        return response(null, 204);
      }
      mutation();
      if (path === "/erase") {
        shape(input, ["through"]);
        return response(d.erase(input.through));
      }
      shape(input, []);
      if (path === "/auth/logout") {
        a.logout(token("normal"), csrf);
        return response(null, 204, { "set-cookie": cookie("normal", "", 0) });
      }
      if (path === "/auth/touch")
        return response(a.touch(token("normal"), csrf));
      if (path === "/backup") {
        const bytes = d.backup();
        normal();
        return new Response(bytes, {
          headers: {
            ...common,
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="quietstats.qsb"',
          },
        });
      }
      throw new Fault(404, "not_found");
    } catch (error) {
      if (!admitted && [400, 413, 415].includes(error.status)) {
        const suffix = new URL(req.url).pathname;
        const lane = suffix.endsWith("/auth/login")
          ? "login"
          : suffix.endsWith("/measure")
            ? "measure"
            : "recovery";
        try {
          system.access.rate(source, lane);
        } catch (limit) {
          error = limit;
        }
      }
      return response(
        {
          schema_version: 1,
          error:
            error instanceof Fault ? error.code : "temporarily_unavailable",
        },
        error instanceof Fault ? error.status : 503,
        error.status === 429 ? { "retry-after": "300" } : {},
      );
    }
  };
}
