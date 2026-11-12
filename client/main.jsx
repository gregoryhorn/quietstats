import { appPath, pagePath, hosted } from "./paths.mjs";
import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import Icon from "./Icons.jsx";
import { api, message } from "./api.mjs";
import { Dashboard } from "./views.jsx";
import "./style.css";
function useAction() {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}
function Frame({ children }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="utility">
        <a href={appPath("/")} className="brand">
          <img
            src={appPath("/quietstats-logo-dark.webp")}
            alt="QuietStats"
            width="174"
          />
        </a>
        <a href={appPath("/help")}>Help</a>
        <a href={appPath("/")}>Back to example</a>
      </header>
      <main id="main" tabIndex="-1">
        {children}
      </main>
      <footer>
        Powered by QuietStats{" "}
        <span>
          Created by Gregory Horn · {hosted ? "QuietStats" : "Local candidate"}
        </span>
        <a href={appPath("/privacy.html")}>Privacy</a>
      </footer>
    </>
  );
}
function Code({ value, onChange, label = "Authenticator code" }) {
  return (
    <label>
      {label}
      <input
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength="6"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        placeholder="Six digits"
      />
    </label>
  );
}
function Login({ kind = "login" }) {
  const { error, busy, run } = useAction();
  const [csrf, setCsrf] = useState(""),
    [value, setValue] = useState("");
  useEffect(() => {
    run(async () => setCsrf((await api("/auth/challenge")).csrf_token));
  }, []);
  async function submit(e) {
    e.preventDefault();
    await run(async () => {
      if (kind === "login") {
        await api("/auth/login", {
          method: "POST",
          body: { code: value },
          csrf,
        });
        location.assign(appPath("/admin"));
      } else {
        await api(kind === "setup" ? "/setup/exchange" : "/recovery/start", {
          method: "POST",
          body: kind === "setup" ? { grant: value } : { recovery_code: value },
          csrf,
        });
        location.assign(appPath("/access"));
      }
    });
    setValue("");
  }
  return (
    <Frame>
      <section className="access-page">
        <p className="eyebrow">Private aggregate counts</p>
        <h1>
          {kind === "login"
            ? "Owner access"
            : kind === "setup"
              ? hosted
                ? "Set up access"
                : "Set up local access"
              : "Replace authenticator"}
        </h1>
        <p>
          {kind === "login"
            ? "Use the next six-digit code from your authenticator. This is possession-only access, without a password or Google sign-in."
            : kind === "setup"
              ? hosted
                ? "Use the one-use grant supplied privately by your operator. Keep this grant confidential."
                : "Use the single-use grant from the protected local setup file. This is an isolated example, never a real owner enrolment."
              : "An unused recovery code opens a restricted replacement session. Your existing authenticator stays active until final commit."}
        </p>
        {location.search && (
          <p role="status">
            Your session is unavailable or expired. Private data has been
            cleared.
          </p>
        )}
        <form onSubmit={submit}>
          {kind === "login" ? (
            <Code value={value} onChange={setValue} />
          ) : (
            <label>
              {kind === "setup"
                ? hosted
                  ? "Setup grant"
                  : "Local setup grant"
                : "Recovery code"}
              <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                maxLength="128"
              />
            </label>
          )}
          <button className="primary" disabled={busy || !csrf}>
            {busy
              ? "Working…"
              : kind === "login"
                ? "Open dashboard"
                : "Continue"}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="access-links">
          <a href={appPath("/login")}>Sign in</a>
          <a href={appPath("/recovery")}>Lost authenticator?</a>
          <a href={appPath("/setup")}>
            {hosted ? "Set up access" : "Local setup"}
          </a>
        </div>
        <p className="fine">
          {hosted
            ? "Only use the trusted application origin."
            : "Only use the trusted loopback origin."}{" "}
          TOTP can be phished. Keep codes, seeds and grants out of chat and
          screenshots.
        </p>
      </section>
    </Frame>
  );
}
function Access() {
  const { error, busy, run } = useAction();
  const [state, setState] = useState(null),
    [seed, setSeed] = useState(null),
    [qr, setQr] = useState(""),
    [code, setCode] = useState(""),
    [codes, setCodes] = useState(null),
    [saved, setSaved] = useState(false);
  async function refresh() {
    setState(await api("/access/state"));
  }
  useEffect(() => {
    run(refresh);
    return () => {
      setSeed(null);
      setCodes(null);
      setQr("");
    };
  }, []);
  const post = (path, body = {}) =>
    api("/access/" + path, { method: "POST", body, csrf: state.csrf_token });
  async function stage() {
    const s = await post("seed");
    setSeed(s);
    setQr(
      await QRCode.toDataURL(s.uri, {
        width: 220,
        margin: 2,
        color: { dark: "#000000", light: "#f3efeb" },
      }),
    );
    await refresh();
  }
  return (
    <Frame>
      <section className="access-page">
        <p className="eyebrow">Restricted access · No report permissions</p>
        <h1>Secure {hosted ? "authenticator" : "local"} enrolment</h1>
        <p>
          {hosted
            ? "Enrol your authenticator on your phone."
            : "Use a synthetic test authenticator only."}{" "}
          The staged seed stays inactive until you save a recovery set and
          confirm with another unused code. Cancelling preserves the existing
          credentials; the entry recovery code remains spent.
        </p>
        {state && (
          <>
            <p className="status">
              Stage: {state.stage} · Expires{" "}
              {new Date(state.expires_at).toLocaleTimeString()}
            </p>
            {!seed && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => run(stage)}
              >
                Show staged authenticator
              </button>
            )}
            {seed && (
              <>
                <h2>1. Staged authenticator</h2>
                {qr && (
                  <img
                    className="qr"
                    src={qr}
                    alt={
                      hosted
                        ? "Staged authenticator QR code"
                        : "Staged local authenticator QR code"
                    }
                  />
                )}
                <label>
                  Manual seed <output className="secret">{seed.seed}</output>
                </label>
                {!["confirmed", "codes"].includes(state.stage) && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(async () => {
                        await post("confirm", { code });
                        setCode("");
                        await refresh();
                      });
                    }}
                  >
                    <Code value={code} onChange={setCode} />
                    <button className="primary" disabled={busy}>
                      Confirm staged seed
                    </button>
                  </form>
                )}
              </>
            )}
            {["confirmed", "codes"].includes(state.stage) && (
              <>
                <h2>2. Save recovery codes</h2>
                <p>
                  The ten codes appear once. If this display was lost, generate
                  a new pending set; any earlier pending set becomes invalid.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setCodes(await post("codes"));
                      setSaved(false);
                      await refresh();
                    })
                  }
                >
                  {codes
                    ? "Replace pending recovery set"
                    : "Generate recovery codes"}
                </button>
                {codes && (
                  <>
                    <ol className="secret codes">
                      {codes.codes.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ol>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={saved}
                        onChange={(e) => setSaved(e.target.checked)}
                      />
                      I saved this generation securely
                    </label>
                    <h2>3. Commit with a fresh code</h2>
                    <p>
                      Wait for the next unused authenticator code. Commit
                      replaces credentials and revokes old sessions. Analytics
                      encryption keys stay unchanged.
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(async () => {
                          await post("commit", {
                            attempt_id: state.attempt_id,
                            codes_generation: codes.generation,
                            codes_saved: saved,
                            code,
                          });
                          setSeed(null);
                          setCodes(null);
                          location.assign(appPath("/login"));
                        });
                      }}
                    >
                      <Code value={code} onChange={setCode} />
                      <button className="primary" disabled={busy || !saved}>
                        Commit replacement
                      </button>
                    </form>
                  </>
                )}
              </>
            )}
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await post("cancel");
                  location.assign(appPath("/login"));
                })
              }
            >
              Cancel staged enrolment
            </button>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </Frame>
  );
}
function Public() {
  return (
    <>
      <a
        className="corner admin-control"
        href={appPath("/login")}
        aria-label="Admin"
      >
        <Icon name="shield" />
      </a>
      <main id="main" className="public-home">
        <p className="eyebrow">
          {hosted
            ? "Private aggregate analytics"
            : "An isolated integration example"}
        </p>
        <img
          src={appPath("/quietstats-logo-dark.webp")}
          alt="QuietStats"
          width="240"
        />
        <h1>
          A little signal.
          <br />A quieter footprint.
        </h1>
        <p>
          Private route counts, no visitor profiles.{" "}
          {hosted ? "This application" : "This local example"} starts with
          measurement off and no imported traffic.
        </p>
        <nav>
          <a href="#landing">Landing</a>
          <a href="#library">Library</a>
          <a href="#studio">Studio</a>
        </nav>
        <p className="fine">
          {hosted ? "" : "Synthetic content only. "}The public reporter is
          disabled by default. Outbound, source and audience metrics are not
          collected.
        </p>
      </main>
      <a
        className="corner privacy-control"
        href={appPath("/privacy.html")}
        aria-label="Privacy"
      >
        <Icon name="info" />
      </a>
    </>
  );
}
function Help() {
  return (
    <Frame>
      <section className="reading">
        <p className="eyebrow">QuietStats guide</p>
        <h1>Small counts, clear boundaries.</h1>
        <h2>What a reported load means</h2>
        <p>
          An untrusted route report increments a daily UTC aggregate. It does
          not prove a human visit. No visitor identity, session, referrer,
          scroll or outbound action is measured.
        </p>
        <h2>Small sample and missing data</h2>
        <p>
          Counts one through four are hidden. Totals and trends are hidden when
          they could reveal those counts. Missing and blocked periods are
          unavailable, never invented zeros. Repeated date windows can still
          permit inference; this is not differential privacy.
        </p>
        <h2>Access and recovery</h2>
        <p>
          Use the next unused code, with automatic phone time. A future-window
          success may require waiting. Recovery grants replacement scope only.
          Old credentials remain valid until final commit. If both phone and
          codes are lost, local operator authority must explicitly freeze and
          replace access.
        </p>
        <h2>Data and keys</h2>
        <p>
          Encrypted backups contain analytics only. Restores preserve current
          erasure cutoffs and never restore old authentication authority.
          Recovery codes cannot reconstruct lost data keys. Keep the protected
          key configuration separately from archives in existing custody.
        </p>
        <h2>Local and provider limitations</h2>
        <p>
          The local server binds only to loopback using self-signed TLS. Browser
          trust must be established for that local certificate; this does not
          qualify it for production. The hosted runtime uses a single SQLite
          Durable Object with bounded encrypted backups. Shared provider quotas
          and production eligibility must be checked by the operator; full-scale
          streaming is unavailable.
        </p>
      </section>
    </Frame>
  );
}
const path = pagePath(location.pathname);
createRoot(document.getElementById("root")).render(
  path === "/admin" ? (
    <Dashboard Frame={Frame} />
  ) : path === "/access" ? (
    <Access />
  ) : path === "/help" ? (
    <Help />
  ) : ["/login", "/setup", "/recovery"].includes(path) ? (
    <Login kind={path.slice(1)} />
  ) : (
    <Public />
  ),
);
