import { appPath, hosted } from "./paths.mjs";
import React, { useEffect, useState, useRef } from "react";
import { api, message } from "./api.mjs";
import Icon from "./Icons.jsx";
import Trend from "./Trend.jsx";
const today = () => new Date().toISOString().slice(0, 10),
  ago = (n) =>
    new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10);
const display = (n, reason) =>
  n === null || n === undefined ? reason || "Not observed" : n.toLocaleString();
async function download(response, name, max) {
  const blob = await response.blob();
  if (blob.size > max) throw Error("capacity");
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function useDashboard() {
  const [view, setView] = useState("Overview"),
    [range, setRange] = useState({ from: ago(7), to: today() }),
    [route, setRoute] = useState(""),
    [page, setPage] = useState(1),
    [session, setSession] = useState(null),
    [report, setReport] = useState(null),
    [status, setStatus] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [through, setThrough] = useState("");
  const generation = useRef(0);
  const query = new URLSearchParams({
    ...range,
    page: String(page),
    page_size: "10",
    ...(route ? { route } : {}),
  }).toString();
  function blank() {
    generation.current++;
    setReport(null);
    setStatus(null);
  }
  async function load() {
    const g = ++generation.current;
    setBusy(true);
    setError("");
    setReport(null);
    setStatus(null);
    try {
      const s = await api("/auth/session");
      const [r, t] = await Promise.all([
        api("/reports?" + query),
        api("/status"),
      ]);
      if (g !== generation.current || document.hidden) return;
      setSession(s);
      setReport(r);
      setStatus(t);
      setExpired(false);
    } catch (e) {
      if (g !== generation.current) return;
      setError(message(e));
      if (e.status === 401) {
        setExpired(true);
        setSession(null);
      }
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    load();
    const change = () => {
        blank();
        if (!document.hidden) load();
      },
      pageShow = () => load();
    document.addEventListener("visibilitychange", change);
    window.addEventListener("pagehide", blank);
    window.addEventListener("pageshow", pageShow);
    return () => {
      generation.current++;
      document.removeEventListener("visibilitychange", change);
      window.removeEventListener("pagehide", blank);
      window.removeEventListener("pageshow", pageShow);
    };
  }, [query]);
  useEffect(() => {
    if (!session) return;
    const delay =
      Math.min(session.idle_expires_at, session.absolute_expires_at) -
      Date.now();
    const t = setTimeout(
      () => {
        blank();
        setSession(null);
        setExpired(true);
      },
      Math.max(0, delay),
    );
    return () => clearTimeout(t);
  }, [session]);
  async function action(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      blank();
      setError(message(e));
      if (e.status === 401) setExpired(true);
    } finally {
      setBusy(false);
    }
  }
  const post = (path, body = {}, raw = false) =>
    api(path, { method: "POST", body, csrf: session.csrf_token, raw });
  return {
    view,
    setView,
    range,
    setRange,
    route,
    setRoute,
    page,
    setPage,
    session,
    report,
    status,
    error,
    busy,
    expired,
    exportOpen,
    setExportOpen,
    notice,
    setNotice,
    through,
    setThrough,
    query,
    blank,
    load,
    action,
    post,
  };
}
export function Dashboard({ Frame }) {
  const {
    view,
    setView,
    range,
    setRange,
    route,
    setRoute,
    page,
    setPage,
    session,
    report,
    status,
    error,
    busy,
    expired,
    exportOpen,
    setExportOpen,
    notice,
    setNotice,
    through,
    setThrough,
    query,
    blank,
    load,
    action,
    post,
  } = useDashboard();
  if (expired)
    return (
      <Frame>
        <section className="access-page">
          <h1>Session expired</h1>
          <p>
            Private data has been cleared. Sign in with the next unused
            authenticator code.
          </p>
          <a className="primary" href={appPath("/login")}>
            Sign in
          </a>
        </section>
      </Frame>
    );
  return (
    <Frame>
      <nav className="dashboard-nav" aria-label="Analytics sections">
        {["Overview", "Content", "Storage", "Coverage", "Security & data"].map(
          (name) => (
            <button
              key={name}
              aria-current={view === name ? "page" : undefined}
              onClick={() => {
                setView(name);
                setExportOpen(false);
              }}
            >
              {name}
            </button>
          ),
        )}
        <button
          disabled={busy || !session}
          onClick={() =>
            action(async () => {
              await post("/auth/logout");
              blank();
              location.assign(appPath("/"));
            })
          }
        >
          Log out
        </button>
      </nav>
      <section className="heading">
        <div>
          <p className="eyebrow">
            Private workspace ·{" "}
            {status?.measurement_mode === "local_synthetic"
              ? "Synthetic local data"
              : status?.measurement_mode === "production"
                ? "Production aggregate data"
                : "Measurement disabled by default"}
          </p>
          <h1>{view}</h1>
          <p className="subtitle">
            Aggregate route reports. No visitor profiles or imported sample
            values.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh and extend idle session"
          disabled={busy || !session}
          onClick={() =>
            action(async () => {
              await post("/auth/touch");
              await load();
            })
          }
        >
          <Icon name="refresh" />
        </button>
      </section>
      {busy && <p role="status">Loading current server-authorised data…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {report && status && (
        <>
          <p className="collection-note">
            <Icon name="info" />
            {hosted ? "Hosted runtime" : "Local candidate"} ·{" "}
            {status.measurement_mode === "local_synthetic"
              ? "Synthetic test collection only. These are actual isolated database counts."
              : status.blocked_reason || "Production collection enabled"}
          </p>
          {["Overview", "Content", "Coverage"].includes(view) && (
            <form className="filters" onSubmit={(e) => e.preventDefault()}>
              <label>
                From (UTC)
                <input
                  type="date"
                  value={range.from}
                  onChange={(e) => {
                    setPage(1);
                    setRange({ ...range, from: e.target.value });
                  }}
                  required
                />
              </label>
              <label>
                To (UTC)
                <input
                  type="date"
                  value={range.to}
                  onChange={(e) => {
                    setPage(1);
                    setRange({ ...range, to: e.target.value });
                  }}
                  required
                />
              </label>
              <div className="period">
                {[7, 30].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setPage(1);
                      setRange({ from: ago(n), to: today() });
                    }}
                  >
                    {n} days
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setExportOpen(!exportOpen)}>
                Export CSV
              </button>
            </form>
          )}
          {exportOpen && (
            <section className="inline-confirm">
              <h2>Export this report</h2>
              <p>
                CSV contains the same suppressed, paginated route projection and
                current filters shown here. It is a deliberate plaintext
                download. Keep total local scratch and CSV files under 20 MB and
                delete unwanted copies.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await download(
                      await api("/export?" + query, {
                        csrf: session.csrf_token,
                        raw: true,
                      }),
                      "quietstats-routes.csv",
                      1000000,
                    );
                    setNotice(
                      "CSV download requested. Download is not proof of custody.",
                    );
                    setExportOpen(false);
                  })
                }
              >
                Download current CSV
              </button>
            </section>
          )}
          {view === "Overview" && (
            <Overview
              report={report}
              route={route}
              setRoute={setRoute}
              page={page}
              setPage={setPage}
            />
          )}
          {view === "Content" && (
            <ContentView
              report={report}
              route={route}
              setRoute={setRoute}
              page={page}
              setPage={setPage}
            />
          )}
          {view === "Coverage" && <Coverage report={report} />}
          {view === "Storage" && <Storage status={status} />}
          {view === "Security & data" && (
            <SecurityData
              status={status}
              busy={busy}
              action={action}
              post={post}
              setNotice={setNotice}
              load={load}
              through={through}
              setThrough={setThrough}
            />
          )}
        </>
      )}
    </Frame>
  );
}
function Content({ report, route, setRoute, page, setPage }) {
  return (
    <section className="content">
      <div className="section-heading">
        <div>
          <h2>Content</h2>
          <p>Allowlisted routes · reported loads only</p>
        </div>
        {route && (
          <button
            onClick={() => {
              setRoute("");
              setPage(1);
            }}
          >
            Clear route filter
          </button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Route</th>
            <th>Reported loads</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r) => (
            <tr key={r.route_id}>
              <th>
                <button
                  className="text-button"
                  onClick={() => {
                    setRoute(r.route_id);
                    setPage(1);
                  }}
                >
                  {r.label}
                  <Icon name="arrow" size={16} />
                </button>
              </th>
              <td>{display(r.count, r.reason)}</td>
              <td>{r.reason || "Observed"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} · {report.pagination.total_rows} routes
        </span>
        <button
          disabled={page * 10 >= report.pagination.total_rows}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </section>
  );
}

function Overview({ report, route, setRoute, page, setPage }) {
  return (
    <>
      <section className="metrics">
        <div>
          <span>Reported route loads</span>
          <strong>{display(report.total, report.total_reason)}</strong>
          <small>
            {report.total_reason ||
              "Observed aggregate; untrusted reports, not verified people"}
          </small>
        </div>
        <div>
          <span>Coverage</span>
          <strong>
            {report.period.from === report.period.to
              ? "1"
              : Math.round(
                  (Date.parse(report.period.to) -
                    Date.parse(report.period.from)) /
                    86400000,
                ) + 1}
            <small>UTC days requested</small>
          </strong>
          <small>
            {report.coverage.missing_days} days not observed · Today is partial
            when included
          </small>
        </div>
        <div>
          <span>Unique visitors</span>
          <strong className="unavailable">Not collected</strong>
          <small>No identifiers or person-level estimates</small>
        </div>
      </section>
      <Trend series={report.series} />
      <Content
        report={report}
        route={route}
        setRoute={setRoute}
        page={page}
        setPage={setPage}
      />
    </>
  );
}

function ContentView({ report, route, setRoute, page, setPage }) {
  return (
    <>
      <label className="route-filter">
        Route filter
        <select
          value={route}
          onChange={(e) => {
            setRoute(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All routes</option>
          <option value="landing">Sample landing</option>
          <option value="library">Sample library</option>
          <option value="studio">Sample studio</option>
        </select>
      </label>
      <Content
        report={report}
        route={route}
        setRoute={setRoute}
        page={page}
        setPage={setPage}
      />
      <Trend series={report.series} />
    </>
  );
}

function Coverage({ report }) {
  return (
    <section className="reading">
      <h2>What is measured</h2>
      <p>
        Schema 2 route reports totalled by server UTC receipt date. Missing
        days, collection pauses, and partial periods are not zero-filled. Counts
        one through four and derived totals are hidden. No comparison deltas are
        released.
      </p>
      <p>
        Current period: {report.coverage.missing_days} missing days;{" "}
        {report.coverage.suppressed_cells} suppressed route cells. Today{" "}
        {report.coverage.partial_today
          ? "is included and partial"
          : "is outside this period"}
        .
      </p>
      {Object.entries(report.exclusions).map(([key, text]) => (
        <div className="fact" key={key}>
          <h3>{key}</h3>
          <p>{text}</p>
        </div>
      ))}
      <h2>Owner exclusion</h2>
      <p>{report.coverage.owner_exclusion_limit}</p>
      <h2>Policy and inference</h2>
      <p>
        Production measurement is blocked pending factual privacy and provider
        qualification. This template is not a legal assessment. Repeated
        overlapping ranges may still permit inference; suppression is
        minimisation, not a proof of anonymity.
      </p>
    </section>
  );
}

function Storage({ status }) {
  return (
    <section className="reading storage">
      <h2>Measured {hosted ? "database" : "local"} allocation</h2>
      <strong className="big-number">
        {(status.storage.bytes / 1000000).toFixed(3)} <small>MB</small>
      </strong>
      <p>
        Measured {new Date(status.storage.at).toISOString()} ·{" "}
        {status.storage.source}
      </p>
      <dl>
        {[
          ["Database allocated", status.storage.database_bytes + " bytes"],
          [
            hosted
              ? "Conservative unmeasured-internals reserve"
              : "Reserved rollback journal",
            status.storage.reserved_journal_bytes + " bytes",
          ],
          [
            "Per-mutation growth reserve",
            status.storage.per_mutation_reservation + " bytes",
          ],
          [
            "Stop primary growth before",
            status.storage.primary_stop_bytes + " bytes",
          ],
          [
            hosted ? "Transactional physical ceiling" : "Primary hard page cap",
            status.storage.primary_hard_bytes + " bytes",
          ],
          [
            "Managed total stop",
            status.storage.managed_total_stop_bytes + " bytes",
          ],
          [
            "Earliest aggregate",
            status.storage.earliest_aggregate_date || "None",
          ],
          ["Pruned dates", status.storage.pruned_dates],
          ["Erasure / prune cutoff", status.storage.cutoff],
          ["Raw events", status.storage.raw],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p>
        DELETE does not mean allocation was reclaimed. Security state is
        preserved.
        {hosted
          ? " The database meter excludes provider replication, PITR and shared account usage. A conservative reserve is a local admission budget, not a measurement of provider internals."
          : " Filesystem allocation, database pages and a full journal reserve are counted separately."}
      </p>
      <h2>Cloudflare</h2>
      <p>{status.cloudflare}</p>
    </section>
  );
}

function SecurityData({
  status,
  busy,
  action,
  post,
  setNotice,
  load,
  through,
  setThrough,
}) {
  return (
    <section className="reading">
      <h2>Access and data are independent</h2>
      <p>
        {status.auth}. Session idle 10 minutes, absolute 30 minutes; maximum
        five normal sessions. Status refresh does not extend access.
        Authenticator replacement keeps the analytics key unchanged.
      </p>
      <a href={appPath("/recovery")}>
        Replace authenticator using a recovery code
      </a>
      <h2>Encrypted {hosted ? "analytics" : "local"} backup</h2>
      <p>
        {status.backup.mode}. Archive limit 2 MB. This bounded local buffered
        download does not claim production streaming support. Keep at most two
        archives, combined below 4 MB, and remove archives older than 35 days.
        The app cannot erase unmanaged downloaded copies. Keep key configuration
        in separate protected existing custody. A lost DATA_KEK cannot be
        recovered from a phone code.
      </p>
      <p>
        Last generated:{" "}
        {status.backup.last_generated
          ? new Date(status.backup.last_generated).toISOString()
          : "Never"}
        . Last isolated verified restore:{" "}
        {status.backup.last_verified_restore
          ? new Date(status.backup.last_verified_restore).toISOString()
          : "Never"}
        .
      </p>
      <button
        disabled={busy}
        onClick={() =>
          action(async () => {
            await download(
              await post("/backup", {}, true),
              "quietstats.qsb",
              2000000,
            );
            setNotice(
              "Encrypted download requested. Independently verify and retain it; no off-device custody is claimed.",
            );
          })
        }
      >
        Download encrypted backup
      </button>
      <h2>Restore analytics only</h2>
      <p>
        An isolated durable candidate is verified before the atomic live change.
        Current erasure and retention cutoffs remain in force. No auth sessions,
        seeds, replay state or recovery verifiers are imported.
      </p>
      <label>
        Encrypted local archive (maximum 2 MB)
        <input
          type="file"
          accept=".qsb"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files[0];
            if (file)
              action(async () => {
                if (file.size > 2000000) throw Error("capacity");
                const archive = await file.text();
                await post("/restore", { archive });
                setNotice(
                  "Isolated candidate verified and analytics restored. Authentication authority preserved.",
                );
                await load();
              });
            e.target.value = "";
          }}
        />
      </label>
      <h2>Erase aggregate dates</h2>
      <p>
        This permanently removes analytics through the selected UTC day.
        Restores retain this cutoff. Existing downloaded archives remain under
        your custody.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            await post("/erase", { through });
            setThrough("");
            await load();
            setNotice(
              "Date cutoff saved. Earlier aggregate dates erased. Allocation may remain unchanged.",
            );
          });
        }}
      >
        <label>
          Erase through (UTC)
          <input
            type="date"
            required
            value={through}
            onChange={(e) => setThrough(e.target.value)}
          />
        </label>
        <button disabled={busy}>Erase through this date</button>
      </form>
    </section>
  );
}
