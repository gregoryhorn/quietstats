import { describe, it, expect } from "vitest";
import { validateEvent, project } from "../core/contracts.mjs";
import { configuration } from "../adapters/cloudflare/config.mjs";
describe("portable contracts", () => {
  it("rejects telemetry expansion and suppresses hidden totals", () => {
    expect(() =>
      validateEvent(
        {
          schema_version: 2,
          type: "route_view",
          route_id: "landing",
          source: "x",
        },
        ["landing"],
      ),
    ).toThrow();
    const r = project(
      [{ day: "2026-11-12", counts: { landing: 1, library: 8 } }],
      [
        { id: "landing", label: "Landing" },
        { id: "library", label: "Library" },
      ],
      { from: "2026-11-12", to: "2026-11-12" },
    );
    expect(r.total).toBeNull();
    expect(r.series[0].value).toBeNull();
  });
  it("defaults hosted qualification off and rejects ambiguous configuration", () => {
    const env = {
      TRUSTED_ORIGIN: "https://runtime.example.invalid",
      RUNTIME_MODE: "production",
      DATASET_NAMESPACE: "quietstats-test",
      ROUTES_JSON: JSON.stringify([{ id: "landing", label: "Landing" }]),
      enabled: true,
    };
    expect(configuration(env).qualified).toBe(false);
    expect(() =>
      configuration({ ...env, PRODUCTION_QUALIFIED: "yes" }),
    ).toThrow();
    expect(
      configuration({ ...env, PRODUCTION_QUALIFIED: "true" }).qualified,
    ).toBe(true);
  });
});
