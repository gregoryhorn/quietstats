import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createSystem } from "../server/system.mjs";
import { makeSecrets } from "../adapters/local/crypto.mjs";
import { nodeServer } from "../server/node-server.mjs";
import { TOTP, Secret } from "otpauth";
const root = resolve(".test-state");
const previousTemporary = process.env.TMPDIR;
const browserTemporary = previousTemporary || join(root, "b");
mkdirSync(browserTemporary, { recursive: true, mode: 0o700 });
process.env.TMPDIR = browserTemporary;
const { chromium } = await import("playwright");
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync("evidence", { recursive: true });
let browser, server, system, dir;
let now = Date.now();
const origin = "https://127.0.0.1:4319";
const otp = (seed) =>
  new TOTP({
    secret: Secret.fromBase32(seed),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  }).generate({ timestamp: now });
let phase = "browser launch";
try {
  browser = await chromium.launch({
    executablePath: process.env.QUIETSTATS_CHROME || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    timeout: 15000,
  });
  dir = mkdtempSync(join(root, "browser-"));
  system = createSystem({
    dir,
    secrets: makeSecrets(),
    clock: () => now,
    synthetic: true,
  });
  phase = "loopback HTTPS listener";
  server = nodeServer(system, {
    origin,
    key: readFileSync(".local/tls-key.pem"),
    cert: readFileSync(".local/tls-cert.pem"),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4319, "127.0.0.1", resolve);
  });
  phase = "browser journeys";
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "doNotTrack", { value: "0" });
    Object.defineProperty(navigator, "globalPrivacyControl", { value: false });
  });
  const page = await context.newPage();
  let dialogs = 0,
    popups = 0;
  page.on("dialog", (d) => {
    dialogs++;
    d.dismiss();
  });
  page.on("popup", (p) => {
    popups++;
    p.close();
  });
  async function ordinary() {
    assert.equal(
      await page.locator('[role="dialog"],[aria-modal="true"],dialog').count(),
      0,
    );
    assert.equal(dialogs + popups, 0);
  }
  await page.goto(origin);
  await ordinary();
  assert.equal(
    await page.getByRole("link", { name: "Admin", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("link", { name: "Privacy", exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: "evidence/public-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await page
    .getByRole("heading", { name: "Privacy, in plain view." })
    .waitFor();
  await ordinary();
  assert.equal(await page.locator("form").count(), 0);
  await page.screenshot({
    path: "evidence/privacy-desktop.png",
    fullPage: true,
  });
  for (const [width, height] of [
    [390, 844],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin);
    await ordinary();
    const widthOk = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    assert.ok(widthOk);
    await page.screenshot({
      path: `evidence/public-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/setup");
  await page.locator("input[type=password]").fill(system.access.issueGrant());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL("**/access");
  await ordinary();
  async function stages() {
    await page
      .getByRole("button", { name: "Show staged authenticator" })
      .click();
    const seed = await page.locator("output.secret").textContent();
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(otp(seed));
    await page.getByRole("button", { name: "Confirm staged seed" }).click();
    await page.getByRole("button", { name: "Generate recovery codes" }).click();
    await page.locator("ol.codes li").nth(9).waitFor();
    const codes = await page.locator("ol.codes li").allTextContents();
    assert.equal(codes.length, 10);
    await ordinary();
    await page.getByLabel("I saved this generation securely").check();
    now += 30000;
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(otp(seed));
    await page.getByRole("button", { name: "Commit replacement" }).click();
    await page.waitForURL("**/login");
    return { seed, codes };
  }
  const active = await stages();
  now += 30000;
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(otp(active.seed));
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await page.waitForURL("**/admin");
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await ordinary();
  await page.screenshot({
    path: "evidence/dashboard-empty-desktop.png",
    fullPage: true,
  });
  const publicContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await publicContext.addInitScript(() => {
    Object.defineProperty(navigator, "doNotTrack", { value: "0" });
    Object.defineProperty(navigator, "globalPrivacyControl", { value: false });
  });
  const visitor = await publicContext.newPage();
  const reports = [];
  visitor.on("request", (r) => {
    if (r.url().endsWith("/measure")) reports.push(r.postDataJSON());
  });
  await visitor.goto(origin + "/fixture.html");
  await visitor.getByRole("link", { name: "Library", exact: true }).click();
  await visitor.getByRole("link", { name: "Studio", exact: true }).click();
  await visitor.getByRole("link", { name: "Utility (excluded)" }).click();
  assert.ok(reports.length >= 1);
  for (const value of reports)
    assert.deepEqual(Object.keys(value), [
      "schema_version",
      "type",
      "route_id",
    ]);
  assert.equal(
    await visitor.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  // Actual same-origin HTTP writes into the isolated test backend, never fixture JSON in UI.
  await visitor.evaluate(async () => {
    for (const route_id of ["landing", "library", "studio"])
      for (let i = 0; i < 6; i++) {
        const r = await fetch("/api/metrics/v1/measure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: 2,
            type: "route_view",
            route_id,
          }),
        });
        if (r.status !== 204) throw Error("Synthetic report refused");
      }
  });
  // Seed six prior synthetic server days through the actual collector, not a mocked API response.
  const currentTime = now;
  for (let day = 1; day <= 6; day++) {
    now = currentTime - day * 86400000;
    const count = 12 + (day * 7) % 19;
    for (let i = 0; i < count; i++) system.data.collect({schema_version:2,type:'route_view',route_id:'landing'},'historical-synthetic-fixture');
  }
  now = currentTime;
  await page.reload();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.getByLabel("Inspect chart date").selectOption({index:1});
  await page.locator('.chart-readout b').waitFor();
  await page.screenshot({
    path: "evidence/dashboard-data-desktop.png",
    fullPage: true,
  });
  await page.getByRole('button',{name:'30 days',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.trend [role="button"]').length===30);
  await page.getByRole('button',{name:'7 days',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.trend [role="button"]').length===7);
  await page.locator('.trend [role="button"]').nth(2).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.trend [role="button"]').nth(3).getAttribute('aria-pressed'),'true');
  for (const [width,height] of [[1920,1080],[1280,720],[960,540],[768,1024],[390,844],[320,740]]) {
    await page.setViewportSize({width,height});
    await page.waitForFunction(()=>Math.abs(document.querySelector('.trend').viewBox.baseVal.width-document.querySelector('.trend').getBoundingClientRect().width)<2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`dashboard overflow at ${width}`);
    await ordinary();
  }
  for (const name of ["Content", "Storage", "Coverage", "Security & data"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await ordinary();
  }
  const backupReady=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download encrypted backup',exact:true}).click();
  const backup=await backupReady;
  assert.equal(backup.suggestedFilename(),'quietstats.qsb');
  assert.ok(readFileSync(await backup.path()).includes(Buffer.from('quietstats-local-1')));
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const csvReady=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download current CSV',exact:true}).click();
  const csvDownload=await csvReady;
  assert.equal(csvDownload.suggestedFilename(),'quietstats-routes.csv');
  assert.match(readFileSync(await csvDownload.path(),'utf8'),/Sample landing/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.screenshot({
    path: "evidence/dashboard-data-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.waitForURL(origin + "/");
  await page.goto(origin + "/recovery");
  await page.locator("input[type=password]").fill(active.codes[0]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL("**/access");
  const replacement = await stages();
  assert.ok(replacement.seed !== active.seed);
  now += 30000;
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(otp(replacement.seed));
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await page.waitForURL("**/admin");
  now += 1800001;
  await page.reload();
  await page.waitForURL("**/login?expired=1");
  await ordinary();
  await publicContext.close();
  await context.close();
  writeFileSync(
    "evidence/browser-result.json",
    JSON.stringify(
      {
        status: "passed",
        journeys:
          "public/privacy/setup/login/dashboard/fixture/recovery/expiry",
        screenshots:
          "Only public and authenticated aggregate views; no secrets captured",
      },
      null,
      2,
    ),
  );
  console.log(
    "Browser journeys passed. Sanitised screenshots saved under evidence/.",
  );
} catch (error) {
  if (phase === "browser launch") console.error(error.message);
  const environment =
    /EPERM|Operation not permitted|SIGTRAP|Target page, context or browser has been closed/.test(
      error.message,
    );
  const result = {
    status: environment ? "environment-blocked" : "failed",
    phase,
    failure_type: error.name,
    locations: [...new Set(error.stack?.match(/browser\.mjs:\d+:\d+/g) || [])],
    reason: environment
      ? "Sandbox denies local socket/browser system calls"
      : "Journey assertion or runtime failure; inspect locally without credential capture",
  };
  writeFileSync(
    "evidence/browser-result.json",
    JSON.stringify(result, null, 2),
  );
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server?.listening) await new Promise((r) => server.close(r));
  system?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (!previousTemporary) rmSync(browserTemporary, { recursive: true, force: true });
  if (previousTemporary === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTemporary;
}
