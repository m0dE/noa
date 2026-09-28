// An install saved with the account server's earlier default address moves to the current one by
// itself. The first launch leaves chrome.storage as an old install has it (settings and a signed-in
// session at PREVIOUS_ACCOUNT_API_BASES[0]); the second launch of the same profile is the extension
// starting after an update. Then storage says the current address, the session is still signed in,
// every request goes to the current address, and "Choose a plan" and the dashboard link open it.
// Both addresses are a local https stub (--host-resolver-rules): nothing reaches the real servers.
//
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/account-migration.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { selfSignedCert } from "../../../test/fixtures/tls.mjs";
import { build } from "esbuild";

// The addresses, from the one place they are defined (packages/shared/src/settings.ts), bundled for Node.
const settingsTs = join(import.meta.dirname, "../../../packages/shared/src/settings.ts").replaceAll("\\", "/");
const bundled = await build({
  stdin: { contents: `export { ACCOUNT_API_BASE, PREVIOUS_ACCOUNT_API_BASES } from "${settingsTs}";`, resolveDir: import.meta.dirname },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const { ACCOUNT_API_BASE, PREVIOUS_ACCOUNT_API_BASES } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const OLD = PREVIOUS_ACCOUNT_API_BASES[0];
const NEW = ACCOUNT_API_BASE;
const hostOf = (url) => new URL(url).host;
const FREE = { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false };
const CREDIT = { subscriptionCents: 0, topupCents: 250, totalCents: 250, periodGrantCents: 0, periodEnd: null };
const USER = { id: "u-old-install", email: "old-install@example.com", name: "Old Install", pictureUrl: null };

// The account server at both addresses: records which address each request used.
const requests = [];
const stub = createServer(selfSignedCert([hostOf(NEW), hostOf(OLD)]), (req, res) => {
  const path = new URL(req.url, "https://x").pathname;
  requests.push({ host: req.headers.host, path, auth: req.headers.authorization ?? "" });
  const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (path === "/v1/me") return json({ ...USER, plan: FREE, credit: CREDIT });
  if (path === "/v1/me/billing") return json({ plan: FREE, credit: CREDIT, stripeConfigured: true });
  if (path === "/billing" || path === "/") return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Dashboard</h1>");
  res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

const profile = mkdtempSync(join(tmpdir(), "noa-migration-"));
const launch = () =>
  launchExtension({
    name: "migration",
    profile,
    ignoreHTTPSErrors: true,
    args: [`--host-resolver-rules=MAP ${hostOf(NEW)} 127.0.0.1:${port}, MAP ${hostOf(OLD)} 127.0.0.1:${port}`, "--ignore-certificate-errors"],
  });
const stored = (sw) => sw.evaluate(async () => chrome.storage.local.get(["settings", "account"]));

const { step, finish } = createSuite("account server migration");
let ext = null;
try {
  await step("an install saved with the old default address (settings and a signed-in session)", async () => {
    ext = await launch();
    const expiresAt = new Date(Date.now() + 30 * 864e5).toISOString();
    await ext.sw.evaluate(
      ({ old, user, expiresAt }) =>
        chrome.storage.local.set({
          settings: { accountApiBase: old, brain: "auto", intervalMinutes: 30 },
          account: { session: { token: "bt_s_old_install", user, expiresAt, apiBase: old } },
        }),
      { old: OLD, user: USER, expiresAt },
    );
    const s = await stored(ext.sw);
    assert.equal(s.settings.accountApiBase, OLD);
    assert.equal(s.account.session.apiBase, OLD);
    await ext.close();
    ext = null;
    return `stored ${OLD}`;
  });

  await step("the extension starts again (as after an update): storage moved to the current address", async () => {
    requests.length = 0;
    ext = await launch();
    const s = await waitFor(async () => {
      const got = await stored(ext.sw);
      return got.settings?.accountApiBase === NEW && got.account?.session?.apiBase === NEW ? got : null;
    }, "settings and session at the current address");
    // Only the address changed.
    assert.deepEqual(s.settings, { accountApiBase: NEW, brain: "auto", intervalMinutes: 30 });
    assert.equal(s.account.session.token, "bt_s_old_install");
    return `settings and session: ${NEW}`;
  });

  let options = null;
  await step("still signed in; the account loads from the current address only", async () => {
    options = await ext.context.newPage();
    await options.goto(`chrome-extension://${ext.extensionId}/options.html#account`);
    await options.waitForSelector("#acct-in:not([hidden])", { timeout: 20_000 });
    await waitFor(async () => (await options.textContent("#acct-plan")) === "Free", "the plan from the account server", { timeout: 20_000 });
    assert.equal(await options.textContent("#acct-name"), USER.name);
    const hosts = [...new Set(requests.map((r) => r.host))];
    assert.deepEqual(hosts, [hostOf(NEW)], `request hosts ${JSON.stringify(requests)}`);
    assert.ok(requests.some((r) => r.path === "/v1/me" && r.auth === "Bearer bt_s_old_install"), "the kept session authenticates");
    return `${requests.length} requests, all to ${hostOf(NEW)}`;
  });

  /** Clicks `selector` and returns the URL of the tab that opens. */
  const opensTab = async (selector) => {
    const [tab] = await Promise.all([ext.context.waitForEvent("page", { timeout: 10_000 }), options.click(selector)]);
    await tab.waitForLoadState("domcontentloaded");
    const url = tab.url();
    await tab.close();
    return url;
  };

  await step('"Choose a plan" opens the Billing page at the current address', async () => {
    assert.equal(await options.textContent("#acct-billing-open"), "Choose a plan");
    const url = await opensTab("#acct-billing-open");
    assert.equal(url, `${NEW}/billing`);
    return url;
  });

  await step("the dashboard link and the API keys tab's button use it too", async () => {
    assert.equal(await opensTab("#acct-dashboard"), `${NEW}/`);
    await options.click("#tab-keys");
    await options.waitForSelector("#keys-locked:not([hidden])");
    assert.equal(await opensTab("#keys-billing-open"), `${NEW}/billing`);
    assert.equal(requests.filter((r) => r.host === hostOf(OLD)).length, 0, "nothing went to the old address");
    return "dashboard and keys tab: current address";
  });
} finally {
  await ext?.close();
  stub.close();
  rmSync(profile, { recursive: true, force: true });
}
finish();
