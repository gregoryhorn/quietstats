export class Fault extends Error {
  constructor(status = 400, code = "invalid_request") {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export function requireThat(ok, status = 400, code = "invalid_request") {
  if (!ok) throw new Fault(status, code);
}
export function shape(value, keys, required = keys) {
  requireThat(value && typeof value === "object" && !Array.isArray(value));
  requireThat(
    Object.keys(value).every((k) => keys.includes(k)) &&
      required.every((k) => Object.hasOwn(value, k)),
  );
  return value;
}
export function validateEvent(value, ids) {
  shape(value, ["schema_version", "type", "route_id"]);
  requireThat(
    value.schema_version === 2 &&
      value.type === "route_view" &&
      ids.includes(value.route_id),
  );
  return value;
}
export function dayOf(time) {
  return new Date(time).toISOString().slice(0, 10);
}
export function validDay(d) {
  return (
    typeof d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d)) &&
    dayOf(Date.parse(d)) === d
  );
}
export function period(q) {
  shape(
    q,
    ["from", "to", "section", "route", "page", "page_size", "sort"],
    ["from", "to"],
  );
  requireThat(validDay(q.from) && validDay(q.to), 422, "invalid_period");
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1;
  requireThat(days >= 1 && days <= 366, 422, "invalid_period");
  requireThat(
    !q.section || ["overview", "content", "coverage"].includes(q.section),
  );
  requireThat(!q.sort || ["route", "count"].includes(q.sort));
  const page = Number(q.page || 1),
    page_size = Number(q.page_size || 10);
  requireThat(
    Number.isInteger(page) &&
      page >= 1 &&
      page <= 100 &&
      [10, 25].includes(page_size),
  );
  return { ...q, days, page, page_size };
}
export const exclusions = {
  outbound:
    "Not collected: outbound actions are outside the route-only baseline.",
  sources: "Not collected: no referrers or acquisition dimensions.",
  people: "Not collected: no visitor identifiers or unique-person estimates.",
  activity:
    "Not collected: no heartbeat, scroll, device or engagement observations.",
};
export function project(partitions, routes, q, now = Date.now()) {
  const p = period(q);
  requireThat(!p.route || routes.some((r) => r.id === p.route));
  const byDay = new Map(partitions.map((d) => [d.day, d]));
  const sums = Object.fromEntries(routes.map((r) => [r.id, 0]));
  let missing = 0,
    small = 0;
  const series = [];
  for (let i = 0; i < p.days; i++) {
    const day = dayOf(Date.parse(p.from) + i * 86400000),
      row = byDay.get(day);
    if (!row) {
      missing++;
      series.push({ date: day, value: null, reason: "Not observed" });
      continue;
    }
    const counts = routes.map((r) => row.counts[r.id] || 0);
    const hidden = counts.some((v) => v > 0 && v < 5);
    for (const r of routes) sums[r.id] += row.counts[r.id] || 0;
    const value = p.route
      ? row.counts[p.route] || 0
      : counts.reduce((a, b) => a + b, 0);
    series.push({
      date: day,
      value: hidden || (value > 0 && value < 5) ? null : value,
      reason: hidden ? "Small sample" : null,
    });
  }
  let rows = routes
    .filter((r) => !p.route || r.id === p.route)
    .map((r) => {
      const n = sums[r.id];
      const hidden = n > 0 && n < 5;
      if (hidden) small++;
      return {
        route_id: r.id,
        label: r.label,
        count: missing === p.days || hidden || n === 0 ? null : n,
        reason:
          missing === p.days
            ? "Not observed"
            : hidden
              ? "Small sample"
              : n === 0
                ? "No observed reports; coverage incomplete"
                : missing
                  ? "Partial coverage"
                  : null,
      };
    });
  const hiddenAny = Object.values(sums).some((n) => n > 0 && n < 5);
  const total =
    hiddenAny || missing === p.days || Object.values(sums).every((n) => n === 0)
      ? null
      : rows.reduce((sum, r) => sum + (r.count || 0), 0);
  if (p.sort === "count")
    rows.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  const total_rows = rows.length;
  rows = rows.slice((p.page - 1) * p.page_size, p.page * p.page_size);
  return {
    schema_version: 2,
    period: { from: p.from, to: p.to, timezone: "UTC" },
    total,
    total_reason: hiddenAny
      ? "Small sample"
      : missing === p.days
        ? "Not observed"
        : missing
          ? "Partial coverage"
          : null,
    series,
    rows,
    coverage: {
      missing_days: missing,
      suppressed_cells: small,
      partial_today: p.to >= dayOf(now),
      collection_policy: "Local synthetic only; production disabled",
      owner_exclusion_limit:
        "Recognized owner cookies excluded; a new browser has no owner identity.",
    },
    comparison: {
      available: false,
      reason: "Comparisons omitted to avoid deriving hidden cells.",
    },
    exclusions,
    pagination: { page: p.page, page_size: p.page_size, total_rows },
  };
}
export function csv(report) {
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^(?:\s*[=+@-]|[\t\r\n])/u, "'$&")
      .replaceAll('"', '""') +
    '"';
  return (
    [
      ["Route", "Reported loads", "Status"],
      ...report.rows.map((r) => [r.label, r.count, r.reason || "Observed"]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") + "\r\n"
  );
}
