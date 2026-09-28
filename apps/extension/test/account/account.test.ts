import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_API_BASE, DEFAULT_SETTINGS, parseSettings, PREVIOUS_ACCOUNT_API_BASES, type ExtensionSettings } from "@noa/shared";
import { ACCOUNT_KEY, AccountService, type AccountLocalTasks } from "../../src/account/account.js";
import { SIGN_IN_NOT_SET_UP, SIGN_IN_WINDOW_OPEN } from "../../src/account/google-auth.js";
import { memoryStorageArea } from "../chrome-fake.js";
import { taskFixture as task } from "../fixtures.js";
import { FREE_PLAN, PLUS_PLAN, USER, credit, fakeApi, jwt } from "./fake-api.js";

const CLIENT = "123-abc.apps.googleusercontent.com";
const REDIRECT = "https://bfffghamekalimhllmeeigmmcoghhfke.chromiumapp.org/";

/** A Google that answers with an ID token for whatever nonce and state it was asked for. */
function google(over: { nonce?: string; state?: string; aud?: string } = {}) {
  const launch = vi.fn(async (url: string) => {
    const q = new URL(url).searchParams;
    const token = jwt({ iss: "https://accounts.google.com", aud: over.aud ?? q.get("client_id"), sub: "g1", nonce: over.nonce ?? q.get("nonce") });
    return `${REDIRECT}#id_token=${token}&state=${over.state ?? q.get("state")}&token_type=Bearer`;
  });
  return { redirectUri: () => REDIRECT, launch };
}

function localTasks(): AccountLocalTasks & { rows: any[]; deleted: string[] } {
  const rows: any[] = [];
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    list: async () => rows,
    getMedia: async (ids) => ids.map((id) => ({ id, name: `${id}.jpg`, blob: new Blob(["img"], { type: "image/jpeg" }) })),
    delete: async (id) => {
      deleted.push(id);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    },
  };
}

function setup(opts: { clientId?: string; identity?: ReturnType<typeof google>; plan?: typeof FREE_PLAN | typeof PLUS_PLAN } = {}) {
  const api = fakeApi();
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS, accountApiBase: api.base };
  const storage = memoryStorageArea();
  const local = localTasks();
  const onChange = vi.fn();
  const identity = opts.identity ?? google();
  let clock = new Date("2026-09-24T12:00:00.000Z");
  /** What GET /v1/me and /v1/me/billing answer: the plan (Free unless given). */
  const onPlan = (plan: typeof FREE_PLAN | typeof PLUS_PLAN) => {
    api.on("GET /v1/me", { body: { ...USER, plan, credit: credit(0, 0) } });
    api.on("GET /v1/me/billing", { body: { plan, credit: credit(0, 0), stripeConfigured: true } });
  };
  const account = new AccountService({
    loadSettings: async () => settings,
    clientId: opts.clientId ?? CLIENT,
    identity,
    localTasks: local,
    storage,
    fetch: api.fetch,
    now: () => clock,
    timeZone: () => "Asia/Seoul",
    onChange,
  });
  api.on("POST /v1/auth/google", { body: { token: "bt_s_abc", user: USER, expiresAt: "2026-11-23T12:00:00.000Z" } });
  onPlan(opts.plan ?? FREE_PLAN);
  api.on("POST /v1/auth/logout", { status: 204 });
  return {
    api,
    account,
    storage,
    local,
    onChange,
    identity,
    setSettings: (p: Partial<ExtensionSettings>) => (settings = { ...settings, ...p }),
    onPlan,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
}

describe("AccountService sign-in", () => {
  it("exchanges the Google ID token for a session, stores it, and loads plan and credit", async () => {
    const t = setup();
    await t.account.signIn();
    const auth = t.api.calls.find((c) => c.path === "/v1/auth/google")!;
    expect(auth.method).toBe("POST");
    expect(auth.headers.authorization).toBeUndefined();
    expect((auth.body as { idToken: string }).idToken.split(".")).toHaveLength(3);
    expect((t.storage.data[ACCOUNT_KEY] as any).session).toMatchObject({ token: "bt_s_abc", apiBase: t.api.base, user: { email: USER.email } });
    // The session token authenticates the follow-up calls.
    const me = t.api.calls.find((c) => c.path === "/v1/me")!;
    expect(me.headers.authorization).toBe("Bearer bt_s_abc");
    const view = await t.account.view();
    expect(view).toMatchObject({ signedIn: true, user: { email: USER.email }, plan: FREE_PLAN, stripeConfigured: true, dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing" });
    expect(t.onChange).toHaveBeenCalled();
  });

  it("asks Google for an ID token with openid email profile, a nonce and the chromiumapp redirect", async () => {
    const t = setup();
    await t.account.signIn();
    const url = new URL(t.identity.launch.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT, response_type: "id_token", scope: "openid email profile", redirect_uri: REDIRECT });
    expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses an ID token whose nonce does not match, and stores nothing", async () => {
    const t = setup({ identity: google({ nonce: "someone-elses" }) });
    await expect(t.account.signIn()).rejects.toThrow(/nonce/);
    expect(t.api.calls).toHaveLength(0);
    expect(t.storage.data[ACCOUNT_KEY]).toBeUndefined();
  });

  it("a second click while signing in waits for the same sign-in (one Google window)", async () => {
    const t = setup();
    const [a, b] = [t.account.signIn(), t.account.signIn()];
    await Promise.all([a, b]);
    expect(t.identity.launch).toHaveBeenCalledTimes(1);
  });

  it("says what to do when Chrome already has a sign-in window open", async () => {
    const identity = { redirectUri: () => "https://x.chromiumapp.org/", launch: vi.fn(async () => Promise.reject(new Error("Only one web auth flow is allowed at a time."))) };
    await expect(setup({ identity: identity as unknown as ReturnType<typeof google> }).account.signIn()).rejects.toThrow(SIGN_IN_WINDOW_OPEN);
  });

  it("refuses a mismatched state and a token for another client", async () => {
    await expect(setup({ identity: google({ state: "x" }) }).account.signIn()).rejects.toThrow(/state/);
    await expect(setup({ identity: google({ aud: "other.apps.googleusercontent.com" }) }).account.signIn()).rejects.toThrow(/another app/);
  });

  it("without a built-in client ID, signs in with the account server's (GET /v1/config)", async () => {
    const t = setup({ clientId: "" });
    t.api.on("GET /v1/config", { body: { googleClientId: ` ${CLIENT} `, stripeConfigured: true, dashboard: true } });
    expect(await t.account.view()).toMatchObject({ signedIn: false, signInConfigured: true });
    await t.account.signIn();
    const config = t.api.calls.find((c) => c.path === "/v1/config")!;
    expect(config.headers.authorization).toBeUndefined();
    expect(new URL(t.identity.launch.mock.calls[0]![0]).searchParams.get("client_id")).toBe(CLIENT);
    expect((await t.account.view()).signedIn).toBe(true);
  });

  it("with a built-in client ID, does not ask the server for one", async () => {
    const t = setup();
    await t.account.signIn();
    expect(t.api.calls.some((c) => c.path === "/v1/config")).toBe(false);
  });

  it("without a client ID anywhere, says sign-in is not set up on that server (and never opens Google)", async () => {
    const t = setup({ clientId: "" });
    t.api.on("GET /v1/config", { body: { googleClientId: "", stripeConfigured: false, dashboard: true } });
    await expect(t.account.signIn()).rejects.toThrow("Google sign-in is not set up on the account server (https://api.test)");
    expect(t.identity.launch).not.toHaveBeenCalled();
    t.setSettings({ accountApiBase: "" });
    await expect(t.account.signIn()).rejects.toThrow(SIGN_IN_NOT_SET_UP);
    expect(await t.account.view()).toMatchObject({ signedIn: false, signInConfigured: false });
  });

  it("an unreachable account server is named when it has to supply the client ID", async () => {
    const t = setup({ clientId: "" });
    t.api.on("GET /v1/config", { status: 500, body: { error: "boom" } });
    await expect(t.account.signIn()).rejects.toThrow(/Could not reach the account server \(https:\/\/api\.test\)/);
    expect(t.identity.launch).not.toHaveBeenCalled();
  });

  it("503 from the server (no GOOGLE_CLIENT_ID there) is shown plainly", async () => {
    const t = setup();
    t.api.on("POST /v1/auth/google", { status: 503, body: { error: "Google sign-in is not configured on this server" } });
    await expect(t.account.signIn()).rejects.toThrow("Google sign-in is not configured on this server (https://api.test)");
    expect((await t.account.view()).signedIn).toBe(false);
  });

  it("a cancelled Google window is reported as cancelled", async () => {
    const identity = { redirectUri: () => REDIRECT, launch: vi.fn(async () => Promise.reject(new Error("The user did not approve access."))) };
    await expect(setup({ identity: identity as any }).account.signIn()).rejects.toThrow("Sign-in was cancelled");
  });

  it("sign out revokes the session on the server and forgets it", async () => {
    const t = setup();
    await t.account.signIn();
    await t.account.signOut();
    const logout = t.api.calls.find((c) => c.path === "/v1/auth/logout")!;
    expect(logout.headers.authorization).toBe("Bearer bt_s_abc");
    expect(t.storage.data[ACCOUNT_KEY]).toEqual({});
    expect((await t.account.view()).signedIn).toBe(false);
  });

  it("a session belongs to its server: changing the account server URL signs out", async () => {
    const t = setup();
    await t.account.signIn();
    t.setSettings({ accountApiBase: "https://self-hosted.example" });
    expect((await t.account.view()).signedIn).toBe(false);
    expect(await t.account.runnerApi()).toBeNull();
  });

  it("a session issued at an earlier default address stays signed in at the current one, stored there", async () => {
    const old = PREVIOUS_ACCOUNT_API_BASES[0]!;
    const storage = memoryStorageArea();
    storage.data[ACCOUNT_KEY] = { session: { token: "bt_s_old", user: USER, expiresAt: "2026-11-23T12:00:00.000Z", apiBase: old } };
    const account = new AccountService({
      // What loadSettings reads from settings stored with the old default.
      loadSettings: async () => parseSettings({ accountApiBase: old }),
      clientId: CLIENT,
      localTasks: localTasks(),
      storage,
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    });
    expect(await account.view()).toMatchObject({
      signedIn: true,
      apiBase: ACCOUNT_API_BASE,
      dashboardUrl: `${ACCOUNT_API_BASE}/`,
      billingUrl: `${ACCOUNT_API_BASE}/billing`,
    });
    expect(account.session()).toMatchObject({ token: "bt_s_old", apiBase: ACCOUNT_API_BASE });
    expect((storage.data[ACCOUNT_KEY] as any).session.apiBase).toBe(ACCOUNT_API_BASE);
  });

  it("a 401 from the server ends the session", async () => {
    const t = setup();
    await t.account.signIn();
    t.api.on("GET /v1/me", { status: 401, body: { error: "invalid or expired session" } });
    await t.account.refresh(true);
    expect((await t.account.view()).signedIn).toBe(false);
  });
});

describe("AccountService plan, credit and billing", () => {
  async function signedIn(me: object, billing?: { status?: number; body?: unknown }) {
    const t = setup();
    t.api.on("GET /v1/me", { body: { ...USER, ...me } });
    if (billing) t.api.on("GET /v1/me/billing", billing);
    await t.account.signIn();
    return t;
  }

  it("brainAccount: credit or an active paid plan makes the hosted AI usable", async () => {
    const free0 = await signedIn({ plan: FREE_PLAN, credit: credit(0, 0) }, { body: { plan: FREE_PLAN, credit: credit(0, 0), stripeConfigured: true } });
    expect(free0.account.brainAccount()).toEqual({ signedIn: true, hostedUsable: false, outOfCredit: true });
    const topped = await signedIn({}, { body: { plan: FREE_PLAN, credit: credit(0, 1000), stripeConfigured: true } });
    expect(topped.account.brainAccount()).toEqual({ signedIn: true, hostedUsable: true, outOfCredit: false });
    const plus = await signedIn({}, { body: { plan: PLUS_PLAN, credit: credit(0, 0), stripeConfigured: true } });
    expect(plus.account.brainAccount().hostedUsable).toBe(true);
    expect(setup().account.brainAccount()).toEqual({ signedIn: false, hostedUsable: false, outOfCredit: false });
  });

  it("a 402 marks the account out of credit until the credit is back; Top up goes to the dashboard's Billing page", async () => {
    const t = await signedIn({}, { body: { plan: FREE_PLAN, credit: credit(0, 500), stripeConfigured: true } });
    await t.account.markOutOfCredit();
    expect(t.account.brainAccount()).toMatchObject({ hostedUsable: false, outOfCredit: true });
    expect(await t.account.view()).toMatchObject({ outOfCredit: true, billingUrl: "https://api.test/billing" });
    t.api.on("GET /v1/me/billing", { body: { plan: FREE_PLAN, credit: credit(0, 2500), stripeConfigured: true } });
    await t.account.refresh(true);
    expect((await t.account.view()).outOfCredit).toBeUndefined();
    expect(t.account.brainAccount().hostedUsable).toBe(true);
  });

  it("a server without billing (404 on /v1/me/billing) reports stripeConfigured false and uses /v1/me's plan", async () => {
    const t = await signedIn({ plan: FREE_PLAN, credit: credit(0, 0) }, { status: 404, body: { error: "not found" } });
    expect(await t.account.view()).toMatchObject({ stripeConfigured: false, plan: FREE_PLAN });
  });

  it("API keys: list, create (the key is returned once), revoke", async () => {
    const t = await signedIn({});
    t.api.on("GET /v1/me/keys", { body: { keys: [{ id: "k1", name: "laptop", role: "runner", createdAt: "2026-09-01T00:00:00Z", revokedAt: null }] } });
    t.api.on("POST /v1/me/keys", (c) => ({ status: 201, body: { id: "k2", ...(c.body as object), key: "bt_newkey" } }));
    t.api.on("DELETE /v1/me/keys/k1", { status: 204 });
    expect(await t.account.listKeys()).toHaveLength(1);
    expect(await t.account.createKey("scheduler", "creator")).toEqual({ id: "k2", name: "scheduler", role: "creator", key: "bt_newkey" });
    await t.account.revokeKey("k1");
    expect(t.api.calls.filter((c) => c.path.startsWith("/v1/me/keys")).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/me/keys",
      "POST /v1/me/keys",
      "DELETE /v1/me/keys/k1",
    ]);
  });
});

describe("AccountService: moving local tasks into the account", () => {
  it("offers the pending and paused local tasks, uploads them with their files, then deletes them locally", async () => {
    const t = setup({ plan: PLUS_PLAN });
    t.local.rows.push(
      { id: "L1", status: "pending", instructions: "Post gm", account: "alpha", notBefore: "2026-09-25T09:00:00.000Z", mediaIds: ["m1"], repeat: { dailyAt: ["09:00"] } },
      { id: "L2", status: "paused", instructions: "Check mail", account: null, notBefore: null, mediaIds: [], repeat: null },
      { id: "L3", status: "done", instructions: "Old", account: null, notBefore: null, mediaIds: [], repeat: null },
    );
    await t.account.signIn();
    expect((await t.account.view()).localTasks).toBe(2);
    let n = 0;
    t.api.on("POST /v1/media", () => ({ status: 201, body: { id: `M${++n}`, filename: "m1.jpg", contentType: "image/jpeg", size: 3 } }));
    t.api.on("POST /v1/tasks", (c) => ({ status: 201, body: task(`A${n}`, c.body as object) }));
    const r = await t.account.migrateLocalTasks();
    expect(r).toEqual({ moved: 2, failed: 0, errors: [] });
    const creates = t.api.calls.filter((c) => c.path === "/v1/tasks").map((c) => c.body);
    expect(creates).toEqual([
      // A task stored with the old { dailyAt } rule moves as cron in the browser's zone.
      { instructions: "Post gm", account: "alpha", mediaIds: ["M1"], schedule: { at: "2026-09-25T09:00:00.000Z", repeat: { cron: "0 9 * * *", tz: "Asia/Seoul" } } },
      { instructions: "Check mail" },
    ]);
    expect(t.api.calls.find((c) => c.path === "/v1/media")!.body).toEqual({ file: { name: "m1.jpg", size: 3, type: "image/jpeg" } });
    expect(t.local.deleted).toEqual(["L1", "L2"]);
    expect((await t.account.view()).localTasks).toBeUndefined();
  });

  it("keeps the tasks that failed to upload, and keeps offering", async () => {
    const t = setup({ plan: PLUS_PLAN });
    t.local.rows.push(
      { id: "L1", status: "pending", instructions: "ok", account: null, notBefore: null, mediaIds: [], repeat: null },
      { id: "L2", status: "pending", instructions: "bad", account: null, notBefore: null, mediaIds: [], repeat: null },
    );
    await t.account.signIn();
    t.api.on("POST /v1/tasks", (c) => ((c.body as any).instructions === "bad" ? { status: 400, body: { error: "invalid" } } : { status: 201, body: task("A1") }));
    const r = await t.account.migrateLocalTasks();
    expect(r.moved).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toMatch(/bad: .*invalid/);
    expect(t.local.deleted).toEqual(["L1"]);
    expect((await t.account.view()).localTasks).toBe(1);
  });

  it("Not now hides the offer until the next sign-in", async () => {
    const t = setup({ plan: PLUS_PLAN });
    t.local.rows.push({ id: "L1", status: "pending", instructions: "x", account: null, notBefore: null, mediaIds: [], repeat: null });
    await t.account.signIn();
    await t.account.dismissMigration();
    expect((await t.account.view()).localTasks).toBeUndefined();
    await t.account.signOut();
    await t.account.signIn();
    expect((await t.account.view()).localTasks).toBe(1);
  });
});

describe("AccountService: the TODO list is a paid feature", () => {
  it("on Free: no runner for the account's list, and no offer to move local tasks into it", async () => {
    const t = setup();
    t.local.rows.push({ id: "L1", status: "pending", instructions: "x", account: null, notBefore: null, mediaIds: [], repeat: null });
    await t.account.signIn();
    expect(t.account.todoAllowed()).toBe(false);
    expect((await t.account.view()).localTasks).toBeUndefined();
    const before = t.api.calls.length;
    expect(await t.account.runnerApi()).toBeNull();
    expect(t.api.calls.slice(before).filter((c) => !c.path.startsWith("/v1/me"))).toEqual([]);
  });

  it("subscribing unlocks it: runnerApi refetches a plan older than a minute", async () => {
    const t = setup();
    await t.account.signIn();
    expect(await t.account.runnerApi()).toBeNull();
    t.onPlan(PLUS_PLAN);
    // Fetched a moment ago: not asked again yet.
    expect(await t.account.runnerApi()).toBeNull();
    t.advance(61_000);
    expect(await t.account.runnerApi()).not.toBeNull();
    expect(t.account.todoAllowed()).toBe(true);
    // A canceled subscription locks it again.
    t.onPlan({ ...FREE_PLAN, status: "canceled" } as never);
    t.advance(61_000);
    expect(await t.account.runnerApi()).toBeNull();
  });
});

describe("AccountService.runnerApi", () => {
  it("claims with the session token as the bearer; a 401 signs out", async () => {
    const t = setup({ plan: PLUS_PLAN });
    await t.account.signIn();
    t.api.on("POST /v1/runner/claim", { status: 204 });
    const runner = (await t.account.runnerApi())!;
    expect(await runner.claim("r1")).toBeNull();
    expect(t.api.calls.at(-1)!.headers.authorization).toBe("Bearer bt_s_abc");
    t.api.on("POST /v1/runner/claim", { status: 401, body: { error: "expired" } });
    await expect(runner.claim("r1")).rejects.toThrow(/401/);
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.account.runnerApi()).toBeNull();
  });
});
