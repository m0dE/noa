import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@noa/shared";
import { AccountService } from "../../src/account/account.js";
import { answerDashboardSignIn, isDashboardSignInMessage, syncDashboardBridge } from "../../src/account/dashboard-sign-in.js";
import { memoryStorageArea } from "../chrome-fake.js";
import { FREE_PLAN, USER, credit, fakeApi, jwt } from "./fake-api.js";

const CODE = { code: `bt_c_${"a".repeat(64)}`, expiresAt: "2026-09-24T12:01:00.000Z" };

async function signedIn() {
  const api = fakeApi();
  const account = new AccountService({
    loadSettings: async () => ({ ...DEFAULT_SETTINGS, accountApiBase: api.base }),
    clientId: "123-abc.apps.googleusercontent.com",
    identity: {
      redirectUri: () => "https://x.chromiumapp.org/",
      launch: async (url) => {
        const q = new URL(url).searchParams;
        const t = jwt({ iss: "https://accounts.google.com", aud: q.get("client_id"), sub: "g1", nonce: q.get("nonce") });
        return `https://x.chromiumapp.org/#id_token=${t}&state=${q.get("state")}`;
      },
    },
    localTasks: { list: async () => [], getMedia: async () => [], delete: async () => false },
    storage: memoryStorageArea(),
    fetch: api.fetch,
    now: () => new Date("2026-09-24T12:00:00.000Z"),
  });
  api.on("POST /v1/auth/google", { body: { token: "bt_s_abc", user: USER, expiresAt: "2026-11-23T12:00:00.000Z" } });
  api.on("GET /v1/me", { body: { ...USER, plan: FREE_PLAN, credit: credit(0, 0) } });
  api.on("GET /v1/me/billing", { body: { plan: FREE_PLAN, credit: credit(0, 0), stripeConfigured: true } });
  api.on("POST /v1/auth/code", { body: CODE });
  api.on("POST /v1/auth/logout", { status: 204 });
  await account.signIn();
  return { api, account, origin: new URL(api.base).origin };
}

const SELF = "bfffghamekalimhllmeeigmmcoghhfke";
/** The bridge script in a tab's top frame at `origin`. */
const bridge = (origin: string, over: object = {}) => ({ id: SELF, origin, frameId: 0, tab: { id: 1 }, ...over });
const via = (t: Awaited<ReturnType<typeof signedIn>>, log?: (m: string) => void) => ({ selfId: SELF, code: (o: string) => t.account.dashboardSignInCode(o), log });

describe("dashboard sign-in with the extension's account", () => {
  it("gives the account server's dashboard a code, asked for with the session token", async () => {
    const t = await signedIn();
    expect(await answerDashboardSignIn(bridge(t.origin), via(t))).toEqual(CODE);
    const call = t.api.calls.find((c) => c.path === "/v1/auth/code")!;
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer bt_s_abc");
  });

  it("gives nothing to any other origin, even a look-alike", async () => {
    const t = await signedIn();
    for (const origin of ["https://evil.test", `${t.origin}.evil.test`, t.origin.replace("https:", "http:"), "null"]) {
      expect(await answerDashboardSignIn(bridge(origin), via(t))).toEqual({ error: "signed-out" });
    }
    expect(t.api.calls.some((c) => c.path === "/v1/auth/code")).toBe(false);
  });

  it("answers only its own bridge in a tab's top frame", async () => {
    const code = vi.fn(async () => CODE);
    const o = "https://app.noa.bot";
    for (const over of [{ frameId: 3 }, { tab: undefined }, { id: "otherextensionid" }, { id: undefined }, { origin: undefined }]) {
      expect(await answerDashboardSignIn(bridge(o, over), { selfId: SELF, code })).toEqual({ error: "signed-out" });
    }
    expect(code).not.toHaveBeenCalled();
    expect(await answerDashboardSignIn(bridge(o), { selfId: SELF, code })).toEqual(CODE);
    expect(code).toHaveBeenCalledWith(o);
  });

  it("recognizes only the sign-in message", () => {
    expect(isDashboardSignInMessage({ type: "noa.dashboardSignIn" })).toBe(true);
    expect(isDashboardSignInMessage({ type: "other" })).toBe(false);
    expect(isDashboardSignInMessage(null)).toBe(false);
  });

  it("signed out: no code", async () => {
    const t = await signedIn();
    await t.account.signOut();
    expect(await answerDashboardSignIn(bridge(t.origin), via(t))).toEqual({ error: "signed-out" });
  });

  it("a session the server no longer accepts: signed out, no code", async () => {
    const t = await signedIn();
    t.api.on("POST /v1/auth/code", { status: 401, body: { error: "invalid key" } });
    expect(await answerDashboardSignIn(bridge(t.origin), via(t))).toEqual({ error: "signed-out" });
    expect((await t.account.view()).signedIn).toBe(false);
  });

  it("a server error is a failure, logged", async () => {
    const t = await signedIn();
    t.api.on("POST /v1/auth/code", { status: 500, body: { error: "internal error" } });
    const log = vi.fn();
    expect(await answerDashboardSignIn(bridge(t.origin), via(t, log))).toEqual({ error: "failed" });
    expect(log).toHaveBeenCalled();
  });
});

describe("the dashboard bridge's registration", () => {
  function scripting() {
    const registered: chrome.scripting.RegisteredContentScript[][] = [];
    const unregistered: unknown[] = [];
    vi.stubGlobal("chrome", {
      scripting: {
        registerContentScripts: vi.fn(async (s: chrome.scripting.RegisteredContentScript[]) => void registered.push(s)),
        unregisterContentScripts: vi.fn(async (f: unknown) => void unregistered.push(f)),
      },
    });
    return { registered, unregistered };
  }

  it("runs only on the account server's origin, top frames, replacing the previous one", async () => {
    const s = scripting();
    await syncDashboardBridge("https://my-noa.example.com/some/path");
    expect(s.unregistered).toEqual([{ ids: ["noa-dashboard-bridge"] }]);
    expect(s.registered).toEqual([[{ id: "noa-dashboard-bridge", matches: ["https://my-noa.example.com/*"], js: ["dashboard-bridge.js"], runAt: "document_start", allFrames: false }]]);
    vi.unstubAllGlobals();
  });

  it("none without an http(s) account server", async () => {
    for (const base of ["", "not a url", "file:///etc", "chrome-extension://abc"]) {
      const s = scripting();
      await syncDashboardBridge(base);
      expect(s.registered).toEqual([]);
      expect(s.unregistered).toHaveLength(1);
    }
    vi.unstubAllGlobals();
  });
});
