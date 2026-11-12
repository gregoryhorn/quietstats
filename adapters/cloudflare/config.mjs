import { requireThat } from "../../core/contracts.mjs";
import { roles } from "../local/crypto.mjs";
export const objectName = "quietstats-site-v1";
export const basename = "/quietstats";
export function configuration(env) {
  const origin = env.TRUSTED_ORIGIN;
  requireThat(
    typeof origin === "string" &&
      new URL(origin).protocol === "https:" &&
      new URL(origin).origin === origin,
    503,
    "invalid_configuration",
  );
  requireThat(
    env.RUNTIME_MODE === "production" &&
      typeof env.DATASET_NAMESPACE === "string" &&
      /^[a-zA-Z0-9_-]{8,80}$/.test(env.DATASET_NAMESPACE),
    503,
    "invalid_configuration",
  );
  const routes = JSON.parse(env.ROUTES_JSON || "null");
  requireThat(
    Array.isArray(routes) &&
      routes.length > 0 &&
      routes.length <= 32 &&
      new Set(routes.map((r) => r.id)).size === routes.length,
    503,
    "invalid_configuration",
  );
  for (const r of routes)
    requireThat(
      r &&
        Object.keys(r).sort().join() === "id,label" &&
        /^[a-z][a-z0-9_-]{0,39}$/.test(r.id) &&
        typeof r.label === "string" &&
        r.label.length > 0 &&
        r.label.length <= 100,
      503,
      "invalid_configuration",
    );
  requireThat(
    env.PRODUCTION_QUALIFIED === undefined ||
      ["true", "false"].includes(env.PRODUCTION_QUALIFIED),
    503,
    "invalid_configuration",
  );
  return {
    origin,
    routes,
    qualified: env.PRODUCTION_QUALIFIED === "true",
    secrets: Object.fromEntries(roles.map((r) => [r, env[r]])),
  };
}
