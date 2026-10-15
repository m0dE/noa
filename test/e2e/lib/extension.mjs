// The built extension in Playwright's Chromium: launching it, talking to its service worker and
// side panel, and registering the native helper for a run.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./suite.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The build output (`pnpm --filter @noa/extension build`); Chrome's "Load unpacked" points here. NOA_E2E_DIST: another build (e.g. an older one, for a before/after). */
export const DIST = process.env.NOA_E2E_DIST || join(REPO, "dist");
/** The ID the manifest's key pins. */
export const EXTENSION_ID = readFileSync(join(REPO, "apps/extension/extension-id.txt"), "utf8").trim();
const COMMANDS = JSON.parse(readFileSync(join(REPO, "apps/extension/static/manifest.json"), "utf8")).commands;
/** The panel's keyboard shortcuts as the manifest suggests them (Chrome assigns them when no other extension has the keys). */
export const SUGGESTED_SHORTCUT = COMMANDS["open-chat"].suggested_key.default;
export const SUGGESTED_VOICE_SHORTCUT = COMMANDS.voice.suggested_key.default;
/** How the extension's pages write them: Chrome's word for a punctuation key reads as the character ("Ctrl+Period" is "Ctrl+."). */
const keyLabel = (key) => key.split("+").map((k) => ({ Period: ".", Comma: "," })[k] ?? k).join("+");
export const SHORTCUT_LABEL = keyLabel(SUGGESTED_SHORTCUT);
export const VOICE_SHORTCUT_LABEL = keyLabel(SUGGESTED_VOICE_SHORTCUT);

const isOurWorker = (w) => w.url().endsWith("/background.js");

/**
 * Chromium with the built extension in a fresh profile.
 * - headed: a real window (default: --headed on the command line)
 * - extensions: more unpacked extensions to load beside it
 * - args, env, ignoreDefaultArgs, ignoreHTTPSErrors: passed to Chromium / Playwright (env: default process.env;
 *   NOA_HOME, unless set, is <profile>/helper-home)
 * - prefs: the profile's Default/Preferences, written before launch
 * - name: in the profile directory's name
 * - profile: an existing profile directory to start with (e.g. one a previous launch left data in);
 *   close() then keeps it (default: a fresh one, removed by close())
 * - beforeStart: keep the side panel's "Before you start" screen (a fresh install shows it over the whole panel until
 *   I understand is pressed). Default: it is marked understood before anything opens, as every run but a test of the
 *   screen itself wants the panel usable (apps/extension/test/before-start.e2e.mjs tests the screen).
 * Returns { context, sw (the extension's service worker), extensionId, profile, close }.
 */
export async function launchExtension({
  headed = process.argv.includes("--headed"),
  extensions = [],
  args = [],
  env,
  prefs,
  ignoreDefaultArgs,
  ignoreHTTPSErrors,
  name = "e2e",
  profile: existing,
  beforeStart = false,
} = {}) {
  const profile = existing ?? mkdtempSync(join(tmpdir(), `noa-${name}-`));
  if (prefs) {
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify(prefs));
  }
  const loaded = [DIST, ...extensions].join(",");
  // A helper Chromium starts inherits its environment: one registered on this machine (not by the run) keeps its
  // logs, runs and helper.json in the profile, never in the machine's own helper folder.
  const browserEnv = { ...(env ?? process.env) };
  browserEnv.NOA_HOME ??= join(profile, "helper-home");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // the new headless mode, which supports extensions
    headless: !headed,
    env: browserEnv,
    ...(ignoreDefaultArgs ? { ignoreDefaultArgs } : {}),
    ...(ignoreHTTPSErrors ? { ignoreHTTPSErrors } : {}),
    args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`, ...args],
  });
  const sw =
    context.serviceWorkers().find(isOurWorker) ?? (await context.waitForEvent("serviceworker", { predicate: isOurWorker, timeout: 15_000 }));
  if (!beforeStart) await acceptBeforeStart(sw);
  const close = async () => {
    await context.close();
    // Retried: the helper may still be closing its log in the profile's helper-home.
    if (!existing) rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
  };
  return { context, sw, extensionId: new URL(sw.url()).host, profile, close };
}

/** Presses "I understand" for the run: the side panel's first-open screen (settings.disclaimerAccepted) stays away. */
async function acceptBeforeStart(sw) {
  // The background's router is there once background.js has run; the worker can be reported before that.
  await waitFor(() => sw.evaluate(() => !!globalThis.__noa?.router), "the background's router");
  await routerUi(sw)({ type: "settings.save", settings: { disclaimerAccepted: true } });
}

const unwrap = (msg, res) => {
  if (!res?.ok) throw new Error(`${msg.type}: ${res?.error ?? "no response"}`);
  return res.data;
};

/** UI requests handled by the background's router directly (what chrome.runtime.onMessage hands it). */
export const routerUi = (sw) => async (msg) => unwrap(msg, await sw.evaluate((m) => globalThis.__noa.router.handle(m), msg));

/** UI requests sent from an extension page with chrome.runtime.sendMessage, as the side panel sends them. */
export const pageUi = (page) => async (msg) => unwrap(msg, await page.evaluate((m) => chrome.runtime.sendMessage(m), msg));

/** The agent's browser driver in the service worker: call("readPage"), call("click", { index }), ... */
export const driverCall = (sw) => (method, params = {}) =>
  sw.evaluate(async ([m, p]) => globalThis.__noa.driver[m](p), [method, params]).catch((err) => {
    // Which call failed, for the step's message.
    err.message = `driver.${method}: ${err.message}`;
    throw err;
  });

/** A session record from the background's session store. */
/**
 * Keeps the scheduler's alarms from starting due jobs (the test runs them itself with run.due, and checks things in
 * between). The product has no pause of every scheduled run: this replaces the runner's alarm start in the service
 * worker only, and release() puts it back. Test-only.
 */
export async function holdAlarmRuns(sw) {
  await sw.evaluate(() => {
    const r = globalThis.__noa.runner;
    if (r.__alarmHeld) return;
    const start = r.runDue.bind(r);
    r.__alarmHeld = true;
    r.runDue = (trigger) => (trigger === "alarm" ? Promise.resolve({ started: false, detail: "e2e: alarm runs held" }) : start(trigger));
  });
  return {
    release: () =>
      sw.evaluate(() => {
        const r = globalThis.__noa.runner;
        delete r.runDue;
        delete r.__alarmHeld;
      }),
  };
}

export const sessionOf = (sw, id) => sw.evaluate(async (i) => globalThis.__noa.sessions.get(i), id);

/** Waits until session `id` matches `until` (default: it ended) and returns it; timeout/every as for waitFor. */
export const sessionWhen = (sw, id, what, { until = (s) => s.endedAt, ...wait } = {}) =>
  waitFor(async () => {
    const s = await sessionOf(sw, id);
    return s && until(s) ? s : null;
  }, what, wait);

/**
 * The side panel page as a tab, then a tab for each URL, all in one window (the panel page shows
 * the chat of that window's active tab). Returns { panel, pages, ids: { panel, tabs, windowId } }.
 */
export async function openPanelWithTabs({ context, sw, extensionId }, urls) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const pages = [];
  for (const url of urls) {
    const page = await context.newPage();
    await page.goto(url);
    pages.push(page);
  }
  const ids = await sw.evaluate(async (urls) => {
    const find = async (url) => (await chrome.tabs.query({ url }))[0];
    const p = await find(`chrome-extension://${chrome.runtime.id}/sidepanel.html`);
    const tabs = [];
    for (const url of urls) {
      const t = await find(url);
      if (t.windowId !== p.windowId) await chrome.tabs.move(t.id, { windowId: p.windowId, index: -1 });
      tabs.push(t.id);
    }
    return { panel: p.id, tabs, windowId: p.windowId };
  }, urls);
  return { panel, pages, ids };
}

/**
 * Opens Chrome's real side panel of window `windowId` as the toolbar button does (one panel per window, on screen on
 * every tab; its content follows the active tab). sidePanel.open() needs a user gesture, and a trusted click in an
 * extension page is one, so this adds a button to `page` (an extension page, in that window) and clicks it. Resolves
 * once the window's side panel page is running.
 */
export async function openSidePanel(sw, page, windowId) {
  const before = await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }).then((c) => c.length));
  await page.evaluate((windowId) => {
    const b = document.createElement("button");
    b.id = "gesture-open";
    b.textContent = "open";
    b.style.cssText = "position:fixed;top:0;left:0;z-index:99999";
    b.onclick = () => chrome.sidePanel.open({ windowId }).catch((e) => (window.__openErr = e.message));
    document.body.append(b);
  }, windowId);
  await page.click("#gesture-open");
  await waitFor(async () => {
    const refused = await page.evaluate(() => window.__openErr);
    if (refused) throw new Error(`sidePanel.open: ${refused}`);
    return (await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }))).length > before;
  }, "a side panel context");
}

/**
 * A keyboard shortcut as a key press delivers it: the command handler (panelCommands.onCommand) run in a
 * real user gesture of the service worker. Playwright's key presses do not reach Chrome's extension shortcuts,
 * but CDP's Extensions.triggerAction clicks the extension's toolbar button, and Chrome dispatches
 * action.onClicked like chrome.commands.onCommand: to the service worker, a user gesture for the listener's
 * synchronous part only. So the toolbar button is pointed at the command handler (instead of opening the
 * panel itself). Returns press(url, command = "open-chat"): that
 * command's shortcut pressed in the tab at `url` (a URL only one tab has; the active one, as for a real key press);
 * resolves to the handler's outcome ("opened", "reopened", "focused", "voice").
 */
export async function shortcutPresser({ context, sw, extensionId }) {
  const cdp = await context.browser().newBrowserCDPSession();
  await sw.evaluate(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    const outcomes = (globalThis.__shortcutOutcomes = []);
    chrome.action.onClicked.addListener((tab) => outcomes.push(globalThis.__noa.panelCommands.onCommand(globalThis.__shortcutCommand, tab)));
  });
  return async (url, command = "open-chat") => {
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const tabs = targetInfos.filter((t) => t.url === url);
    if (tabs.length !== 1) throw new Error(`${tabs.length} tabs have ${url}`);
    const n = await sw.evaluate((c) => ((globalThis.__shortcutCommand = c), globalThis.__shortcutOutcomes.length), command);
    await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: tabs[0].targetId });
    return waitFor(() => sw.evaluate((i) => globalThis.__shortcutOutcomes[i], n), "the command handler to run");
  };
}

/** The keys install.js points at its manifest (apps/helper/src/install.ts REGISTRY_KEYS; Chrome for Testing reads one of them). */
const HELPER_REG_KEYS = ["Google\\Chrome", "Chromium"].map((b) => ["HKCU", "Software", b, "NativeMessagingHosts", "com.noa.helper"].join("\\"));
/** NOA_E2E_HELPER_DIST: a helper built elsewhere (NOA_HELPER_DIST), not the installed one's apps/helper/dist. */
const HELPER_INSTALL = join(process.env.NOA_E2E_HELPER_DIST || join(REPO, "apps/helper/dist"), "install.js");
/** Held by the run that registered the helper, with the registry values it replaced (one registration at a time). */
const REGISTRY_LOCK = join(tmpdir(), "noa-e2e-native-host.lock");
const REGISTRY_LOCK_WAIT_MS = 30 * 60_000;
/** The home of the helper this run registered (its helper.json names its process); null: none registered. */
let registeredHome = null;

/** A registry key's default value, or null when the key is absent. */
function regValue(key) {
  try {
    return /REG_SZ\s+(.*?)\s*$/m.exec(execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Puts the registry keys back as `values` (key -> value, null: absent) says. */
function restoreRegistry(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) {
      if (regValue(key) !== null) execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
    } else execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
  }
}

/** The helper's registration: each key's value (null: absent), in HELPER_REG_KEYS order (Chrome, Chromium). */
export const helperRegistration = () => HELPER_REG_KEYS.map(regValue);

export const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readLock = () => {
  try {
    return JSON.parse(readFileSync(REGISTRY_LOCK, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Takes the registry lock: waits for another run that holds it; a lock left by a run that died is taken over after
 * putting back the registry values it had replaced.
 */
function lockRegistry() {
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  let said = false;
  for (;;) {
    try {
      writeFileSync(REGISTRY_LOCK, JSON.stringify({ pid: process.pid, previous: null }), { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const held = readLock();
    if (held?.pid === process.pid) throw new Error("the helper is registered already in this process");
    if (held && !processAlive(held.pid)) {
      if (held.previous) restoreRegistry(held.previous);
      rmSync(REGISTRY_LOCK, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`another e2e run (pid ${held?.pid}) still holds ${REGISTRY_LOCK}`);
    if (!said) console.log(`waiting for the e2e run with pid ${held?.pid} to unregister its helper (${REGISTRY_LOCK})`);
    said = true;
    sleepSync(500);
  }
}

/**
 * Registers the built helper (apps/helper/dist) as the extension's native messaging host (Windows), with a home of
 * its own (NOA_HOME: its launcher, manifest, logs, runs and helper.json), so a run never touches the
 * installation or the data of the helper this machine has. Concurrent runs wait for each other (REGISTRY_LOCK).
 * Returns unregister(): the registry is put back as it was and the home removed.
 */
export function registerHelperTemporarily(extensionId = EXTENSION_ID) {
  lockRegistry();
  const previous = Object.fromEntries(HELPER_REG_KEYS.map((k) => [k, regValue(k)]));
  writeFileSync(REGISTRY_LOCK, JSON.stringify({ pid: process.pid, previous }));
  const home = mkdtempSync(join(tmpdir(), "noa-e2e-helper-"));
  try {
    execFileSync(process.execPath, [HELPER_INSTALL, "--extension-id", extensionId, "--env", `NOA_HOME=${home}`], {
      stdio: "ignore",
      env: { ...process.env, NOA_HOME: home },
    });
  } catch (err) {
    restoreRegistry(previous);
    rmSync(REGISTRY_LOCK, { force: true });
    throw err;
  }
  registeredHome = home;
  return () => {
    try {
      restoreRegistry(previous);
      rmSync(REGISTRY_LOCK, { force: true });
    } catch (err) {
      console.error(`could not put the helper's registration back (${JSON.stringify(previous)}): ${err.message}`);
    }
    registeredHome = null;
    rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  };
}

/**
 * Registers the built helper for one browser profile (Linux, macOS): Chromium with its own profile reads
 * <profile>/NativeMessagingHosts, so the installer runs with a throwaway HOME and its manifest is copied there. The
 * machine's own registration is never touched. The helper's home (NOA_HOME) is its own, like the Windows one.
 * Returns the cleanup.
 */
export function registerHelperInProfile(profile, extensionId = EXTENSION_ID) {
  const home = mkdtempSync(join(tmpdir(), "noa-e2e-helper-"));
  const installHome = mkdtempSync(join(tmpdir(), "noa-e2e-install-home-"));
  execFileSync(process.execPath, [HELPER_INSTALL, "--extension-id", extensionId, "--env", `NOA_HOME=${home}`], {
    stdio: "ignore",
    env: { ...process.env, HOME: installHome, NOA_HOME: home },
  });
  // Where the installer writes Chromium's manifest for that HOME (apps/helper/src/install.ts).
  const hosts = process.platform === "darwin" ? join(installHome, "Library", "Application Support", "Chromium", "NativeMessagingHosts") : join(installHome, ".config", "chromium", "NativeMessagingHosts");
  const manifest = join(hosts, "com.noa.helper.json");
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  copyFileSync(manifest, join(profile, "NativeMessagingHosts", "com.noa.helper.json"));
  registeredHome = home;
  return () => {
    registeredHome = null;
    rmSync(home, { recursive: true, force: true, maxRetries: 10 });
    rmSync(installHome, { recursive: true, force: true });
  };
}

/** Kills the process of the helper this run registered (what a crash or a closed laptop lid looks like to the extension). */
export function killHelper() {
  if (!registeredHome) throw new Error("killHelper: no helper registered by this run");
  const file = join(registeredHome, "helper.json");
  const { pid } = JSON.parse(readFileSync(file, "utf8"));
  process.kill(pid);
  // A killed helper cannot remove its file: the pid in it would be stale (and may be reused).
  rmSync(file, { force: true });
}

/**
 * Signs the extension in through a fake Google: the build's Google client id and
 * chrome.identity.launchWebAuthFlow are replaced by `clientId` and a flow that gets an ID token
 * from `mintUrl` (the fake Google signs one with the request's nonce and audience). The rest of the
 * extension's sign-in (state/nonce/audience checks, POST /v1/auth/google) is the real one.
 */
export async function fakeGoogleSignIn(sw, { mintUrl, clientId }) {
  await sw.evaluate(
    ({ mintUrl, clientId }) => {
      globalThis.__noa.setIdentity({
        clientId,
        identity: {
          redirectUri: () => chrome.identity.getRedirectURL(),
          async launch(url) {
            const q = new URL(url).searchParams;
            const mint = new URL(mintUrl);
            mint.searchParams.set("nonce", q.get("nonce"));
            mint.searchParams.set("aud", q.get("client_id"));
            const idToken = await (await fetch(mint)).text();
            return `${q.get("redirect_uri")}#${new URLSearchParams({ id_token: idToken, state: q.get("state") })}`;
          },
        },
      });
    },
    { mintUrl, clientId },
  );
}
