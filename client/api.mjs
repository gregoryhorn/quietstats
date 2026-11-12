const base = "/api/metrics/v1";
export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
export async function api(
  path,
  { method = "GET", body, csrf, raw = false } = {},
) {
  const result = await fetch(base + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!result.ok) {
    let code = "temporarily_unavailable";
    try {
      code = (await result.json()).error;
    } catch {}
    throw new ApiError(result.status, code);
  }
  return raw ? result : result.status === 204 ? null : result.json();
}
export function message(error) {
  return error.status === 429
    ? "Too many attempts. Wait a few minutes before trying again."
    : error.status === 401
      ? "Access failed or expired. Use the next unused authenticator code."
      : error.status === 403
        ? "Request denied. Open the trusted local origin and try again."
        : error.message === "state_conflict"
          ? "This stage has changed. Refresh the page before continuing."
          : "Temporarily unavailable. No private fallback data is shown.";
}
