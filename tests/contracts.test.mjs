import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, period, project, csv } from "../core/contracts.mjs";
test("baseline accepts only schema2 allowlisted route reports", () => {
  assert.deepEqual(
    validateEvent(
      { schema_version: 2, type: "route_view", route_id: "library" },
      ["library"],
    ),
    { schema_version: 2, type: "route_view", route_id: "library" },
  );
  for (const value of [
    { schema_version: 1, type: "route_view", route_id: "library" },
    { schema_version: 2, type: "route_view", route_id: "library", url: "x" },
    [],
    { schema_version: 2, type: "route_view", route_id: "unknown" },
  ])
    assert.throws(() => validateEvent(value, ["library"]));
});
test("UTC range is exact and bounded", () => {
  assert.equal(period({ from: "2026-01-01", to: "2026-01-02" }).days, 2);
  for (const q of [
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2025-01-01", to: "2026-11-01" },
    { from: "2026-01-02", to: "2026-01-01" },
    { from: "2026-01-01", to: "2026-01-02", bad: "x" },
  ])
    assert.throws(() => period(q));
});
test("suppression propagates to totals and series; missing is not zero; CSV safe", () => {
  const routes = [
    { id: "landing", label: "=unsafe" },
    { id: "library", label: "Library" },
  ];
  const r = project(
    [{ day: "2026-01-01", counts: { landing: 2, library: 8 } }],
    routes,
    { from: "2026-01-01", to: "2026-01-02" },
  );
  assert.equal(r.total, null);
  assert.equal(r.rows[0].count, null);
  assert.equal(r.series[0].value, null);
  assert.equal(r.series[1].reason, "Not observed");
  assert.ok(csv(r).includes("'=unsafe"));
  assert.ok(!csv(r).includes(",2,"));
});
