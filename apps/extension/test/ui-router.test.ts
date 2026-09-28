import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SCHEDULE_PLAN_REQUIRED, SCHEDULE_SIGN_IN, type ExtensionSettings, type HelperInfo, type SessionInfo } from "@noa/shared";
import { fakePort, installChromeFake, type FakePort } from "./chrome-fake.js";
import { resolveBrain } from "../src/engine/brain-resolver.js";
import { MemoryKvDb } from "./memory-kv.js";
import { LocalStore } from "../src/engine/local-store.js";
import type { AdhocInput } from "../src/engine/run/jobs.js";
import type { RunnerState } from "../src/engine/run/state.js";
import { SessionStore } from "../src/engine/sessions.js";
import { TraceStore } from "../src/engine/trace-store.js";
import { LocalTodo } from "../src/account/todo-source.js";
import { ApiRequestError, NotSignedInError } from "../src/http-client.js";
import { UiHub } from "../src/engine/ui-hub.js";
import { UiRouter, type RouterRunner, type UiRouterDeps } from "../src/engine/ui-router.js";
import { TabChats } from "../src/tab-chats.js";
import { applySettingsPatch } from "../src/settings-store.js";
import { WrongPassphraseError } from "../src/vault.js";
import { isStale, UI_PORT_NAME, type UiPush, type UiRequest, type UiResponse, type UiState } from "../src/ui-protocol.js";

const INFO: HelperInfo = { version: "2", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "L", selfTest: { ok: true, ms: 1, at: "x" } };

function setup() {
  const db = new MemoryKvDb();
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-secret", runnerKey: "bt_secret" };
  const rstate: RunnerState = { lastRunAt: "2026-09-24T09:00:00.000Z" };
  const running: SessionInfo | null = null;
  const runner = {
    running,
    runningSessions: [] as SessionInfo[],
    state: vi.fn(async () => ({ ...rstate })),
    runDue: vi.fn(async () => ({ started: true })),
    runAdhoc: vi.fn(async (_i: AdhocInput) => ({ sessionId: "adhoc-1" })),
    continueSession: vi.fn(async (_id: string, _note?: string) => ({ sessionId: "cont-1" })),
    message: vi.fn(async (sessionId: string | undefined, _text: string) => ({ sessionId: sessionId ?? "new-1", mode: sessionId ? ("turn" as const) : ("new" as const) })),
    newChat: vi.fn(async (_id?: string) => ({ ok: true })),
    stop: vi.fn(() => true),
    say: vi.fn(async () => true),
    runTask: vi.fn(async (_id: string) => ({ sessionId: "S-task" })),
  } satisfies RouterRunner;
  const helper = {
    info: null as HelperInfo | null,
    lastError: "Specified native messaging host not found." as string | null,
    connect: vi.fn(async (_t?: number, _o?: { selfTest?: boolean }) => {
      helper.info = INFO;
      helper.lastError = null;
      return INFO;
    }),
    call: vi.fn(async (_method: string, _p?: unknown, _o?: unknown): Promise<any> => ({ text: "log lines" })),
  };
  const localStore = new LocalStore({ db });
  const sessions = new SessionStore(db, { trace: new TraceStore(db) });
  const vault = {
    unlock: vi.fn(async (_passphrase: string) => {}),
    lock: vi.fn(async () => {}),
    list: vi.fn(async () => ({ exists: false, locked: true, sites: [] as string[] })),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  };
  const deps: UiRouterDeps = {
    loadSettings: async () => settings,
    saveSettingsPatch: async (patch) => (settings = applySettingsPatch(settings, patch)),
    runner,
    showAgent: async () => false,
    localStore,
    sessions,
    openConversations: () => ["S-open"],
    helper,
    brainStatus: (s) => resolveBrain({ settings: s, helper: helper.info, helperError: helper.lastError }),
    nextRunAt: async () => "2026-09-24T10:15:00.000Z",
    testClaude: async () => ({ ok: true, detail: "Key accepted" }),
    // Echoes the resolved brain it was given: the router must pass the settings' brain status.
    testJev: async (_s, brain) => ({ ok: false, detail: `No Jev key set (brain: ${brain.effective ?? "none"})` }),
    testCloud: async () => ({ ok: true, detail: "Connected" }),
    vault,
  };
  const router = new UiRouter(deps);
  const req = async <T = any>(r: UiRequest | { type: string; [k: string]: unknown }): Promise<T> => {
    const res = (await router.handle(r as UiRequest)) as UiResponse<T>;
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  return { router, deps, runner, helper, localStore, sessions, vault, req, get settings() { return settings; } };
}

beforeEach(() => {
  installChromeFake();
});

describe("UiRouter", () => {
  it("state.get: redacted settings, brain status, run state", async () => {
    const t = setup();
    const s = await t.req({ type: "state.get" });
    expect(s.settings.anthropicApiKey).toBe("set");
    expect(s.settings.runnerKey).toBe("set");
    expect(s.settings.jevApiKey).toBe("");
    expect(s.brain).toMatchObject({ effective: "claude-api", hasApiKey: true, helper: null, helperError: "Specified native messaging host not found." });
    expect(s).toMatchObject({ running: null, lastRunAt: "2026-09-24T09:00:00.000Z", nextRunAt: "2026-09-24T10:15:00.000Z" });
  });

  it("settings.save: partial update, secrets kept when omitted or 'set', cleared with ''", async () => {
    const t = setup();
    let s = await t.req({ type: "settings.save", settings: { intervalMinutes: 30, anthropicApiKey: "set", jevApiKey: "jk-new" } });
    expect(t.settings).toMatchObject({ intervalMinutes: 30, anthropicApiKey: "sk-secret", jevApiKey: "jk-new", runnerKey: "bt_secret" });
    expect(s.settings.jevApiKey).toBe("set");
    s = await t.req({ type: "settings.save", settings: { runnerKey: "", brain: "claude-code" } });
    expect(t.settings).toMatchObject({ runnerKey: "", brain: "claude-code", anthropicApiKey: "sk-secret" });
    expect(s.brain.effective).toBeNull();
  });

  it("settings tests pass through", async () => {
    const t = setup();
    expect(await t.req({ type: "settings.testClaude" })).toEqual({ ok: true, detail: "Key accepted" });
    expect(await t.req({ type: "settings.testJev" })).toEqual({ ok: false, detail: "No Jev key set (brain: claude-api)" });
    expect(await t.req({ type: "settings.testCloud" })).toEqual({ ok: true, detail: "Connected" });
  });

  it("helper.connect connects with the self-test and returns state, even when it fails", async () => {
    const t = setup();
    const s = await t.req({ type: "helper.connect" });
    expect(t.helper.connect).toHaveBeenCalledWith(undefined, { selfTest: true });
    expect(s.brain).toMatchObject({ effective: "claude-code", helper: INFO });
    t.helper.connect.mockRejectedValueOnce(new Error("nope"));
    await expect(t.req({ type: "helper.connect" })).resolves.toHaveProperty("brain");
  });

  it("run.* requests go to the runner", async () => {
    const t = setup();
    expect(await t.req({ type: "run.adhoc", instructions: "do", account: "@a", attachments: [{ name: "f.txt", type: "text/plain", dataBase64: btoa("hi"), text: "hi" }] })).toEqual({ sessionId: "adhoc-1" });
    const input = t.runner.runAdhoc.mock.calls[0]![0];
    expect(input).toMatchObject({ instructions: "do", account: "@a", attachments: [{ ref: { name: "f.txt", type: "text/plain", kind: "text" }, text: "hi" }] });
    expect(await input.attachments![0]!.blob.text()).toBe("hi");
    // The limits hold here too (the panel says so before sending, so here it is an error).
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, type: "text/plain", dataBase64: btoa("x") }));
    await expect(t.req({ type: "run.adhoc", instructions: "do", attachments: eleven })).rejects.toThrow(/At most 10 files per message/);
    expect(await t.req({ type: "run.due" })).toEqual({ started: true });
    expect(t.runner.runDue).toHaveBeenCalledWith("manual");
    expect(await t.req({ type: "run.stop" })).toEqual({ ok: true });
    expect(await t.req({ type: "run.say", text: "hello" })).toEqual({ ok: true });
    expect(t.runner.say).toHaveBeenCalledWith("hello", undefined);
    // One session of several: stop and say take its id.
    await t.req({ type: "run.stop", sessionId: "S2" });
    expect(t.runner.stop).toHaveBeenLastCalledWith("S2");
    await t.req({ type: "run.say", text: "hi", sessionId: "S2" });
    expect(t.runner.say).toHaveBeenLastCalledWith("hi", "S2");
  });

  it("run.continue passes the session id and the trimmed note; errors come back as { ok: false }", async () => {
    const t = setup();
    expect(await t.req({ type: "run.continue", sessionId: "s-old", text: "  it's typed already, just post  " })).toEqual({ sessionId: "cont-1" });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("s-old", "it's typed already, just post", {});
    await t.req({ type: "run.continue", sessionId: "s-old", text: "   " });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("s-old", undefined, {});
    await t.req({ type: "run.continue", sessionId: "s-old" });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("s-old", undefined, {});
    expect(await t.router.handle({ type: "run.continue" } as never)).toEqual({ ok: false, error: "sessionId is required" });
    t.runner.continueSession.mockRejectedValueOnce(new Error("Cloud tasks continue from the queue; use Retry on the server"));
    expect(await t.router.handle({ type: "run.continue", sessionId: "c" })).toEqual({
      ok: false,
      error: "Cloud tasks continue from the queue; use Retry on the server",
    });
  });

  it("run.adhoc errors come back as { ok: false, error }", async () => {
    const t = setup();
    t.runner.runAdhoc.mockRejectedValueOnce(new Error("A task is already running"));
    expect(await t.router.handle({ type: "run.adhoc", instructions: "x" })).toEqual({ ok: false, error: "A task is already running" });
  });

  it("has no pause of every scheduled run: no paused in the state, schedule.pause is not a request", async () => {
    const t = setup();
    const s = await t.req({ type: "state.get" });
    expect("paused" in s).toBe(false);
    expect("pauseMigration" in s).toBe(false);
    expect(await t.router.handle({ type: "schedule.pause" } as never)).toMatchObject({ ok: false });
  });

  it("tasks.pause / tasks.resume hold a waiting task and put it back on its schedule", async () => {
    const t = setup();
    const { task } = await t.req({ type: "tasks.add", instructions: "post a tip", notBefore: "2099-01-01T09:00:00.000Z" });
    expect((await t.req({ type: "tasks.pause", id: task.id })).task).toMatchObject({ status: "paused", pauseReason: "Paused by you" });
    expect((await t.req({ type: "tasks.resume", id: task.id })).task).toMatchObject({ status: "pending", pauseReason: null, notBefore: "2099-01-01T09:00:00.000Z" });
    expect(await t.router.handle({ type: "tasks.resume", id: task.id })).toMatchObject({ ok: false, error: expect.stringMatching(/only a paused task/) });
  });

  it("tasks.series lists one series of this browser's tasks, newest first, in one page", async () => {
    const t = setup();
    const { task } = await t.req({ type: "tasks.add", instructions: "post a tip", repeat: { cron: "0 9 * * *", tz: "UTC" } });
    await t.req({ type: "tasks.add", instructions: "another job" });
    const page = await t.req({ type: "tasks.series", seriesId: task.seriesId ?? task.id });
    expect(page).toEqual({ tasks: [expect.objectContaining({ id: task.id, instructions: "post a tip" })], nextCursor: null });
    expect(await t.req({ type: "tasks.series", seriesId: "nope" })).toEqual({ tasks: [], nextCursor: null });
  });

  it("tasks.* manage the local list", async () => {
    const t = setup();
    const { task } = await t.req({ type: "tasks.add", instructions: "post it", account: "@me", repeat: { cron: "0 9 * * *", tz: "UTC" }, media: [{ name: "a.png", type: "image/png", dataBase64: btoa("x") }] });
    expect(task).toMatchObject({ instructions: "post it", account: "@me", status: "pending" });
    const { tasks } = await t.req({ type: "tasks.list" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].media).toEqual([{ id: expect.any(String), name: "a.png", type: "image/png", size: 1 }]);
    expect((await t.req({ type: "tasks.update", id: task.id, patch: { instructions: "edited", repeat: null } })).task).toMatchObject({ instructions: "edited", repeat: null });
    expect((await t.req({ type: "tasks.retry", id: task.id })).task).toMatchObject({ status: "pending", notBefore: null });
    expect(await t.req({ type: "tasks.delete", id: task.id })).toEqual({ ok: true });
    expect(await t.req({ type: "tasks.delete", id: task.id })).toEqual({ ok: false });
    expect(await t.router.handle({ type: "tasks.add", instructions: "" })).toEqual({ ok: false, error: "Instructions are empty" });
    // Run on a row: the runner runs that task.
    expect(await t.req({ type: "tasks.run", id: "T9" })).toEqual({ sessionId: "S-task" });
    expect(t.runner.runTask).toHaveBeenCalledWith("T9");
    expect(await t.router.handle({ type: "tasks.run", id: "" } as never)).toEqual({ ok: false, error: "id is required" });
  });

  it("sessions.list / sessions.events", async () => {
    const t = setup();
    await t.sessions.create({ sessionId: "s1", source: "adhoc", title: "x", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    t.sessions.append("s1", { type: "status", text: "hi" });
    expect((await t.req({ type: "sessions.list", limit: 5 })).sessions.map((s: SessionInfo) => s.sessionId)).toEqual(["s1"]);
    const ev = await t.req({ type: "sessions.events", sessionId: "s1" });
    expect(ev.session.sessionId).toBe("s1");
    expect(ev.events).toEqual([expect.objectContaining({ type: "status", text: "hi", sessionId: "s1" })]);
    expect(await t.router.handle({ type: "sessions.events", sessionId: "nope" })).toEqual({ ok: false, error: "No session nope" });
  });

  it("run.message goes to the runner with the conversation (none: a new one); run.newChat too", async () => {
    const t = setup();
    expect(await t.req({ type: "run.message", sessionId: "S1", text: "now like it" })).toEqual({ sessionId: "S1", mode: "turn" });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "now like it", {});
    expect(await t.req({ type: "run.message", text: "post gm" })).toEqual({ sessionId: "new-1", mode: "new" });
    expect(t.runner.message).toHaveBeenLastCalledWith(undefined, "post gm", {});
    expect(await t.req({ type: "run.message", sessionId: "", text: "x" })).toMatchObject({ mode: "new" });
    t.runner.message.mockRejectedValueOnce(new Error("The message is empty"));
    expect(await t.router.handle({ type: "run.message", sessionId: "S1", text: " " })).toEqual({ ok: false, error: "The message is empty" });
    expect(await t.req({ type: "run.newChat", sessionId: "S1" })).toEqual({ ok: true });
    expect(t.runner.newChat).toHaveBeenLastCalledWith("S1");
    await t.req({ type: "run.newChat" });
    expect(t.runner.newChat).toHaveBeenLastCalledWith(undefined);
  });

  it("state lists the conversations whose agent session is still open", async () => {
    const t = setup();
    expect((await t.req({ type: "state.get" })).openConversations).toEqual(["S-open"]);
  });

  it("there is no raw log request any more (the helper's run logs stay on disk)", async () => {
    const t = setup();
    expect(await t.router.handle({ type: "session.log", sessionId: "cc" } as never)).toMatchObject({ ok: false });
    expect(t.helper.call).not.toHaveBeenCalled();
  });

  it("extra requests: helper.getLog and vault.*", async () => {
    const t = setup();
    expect(await t.req({ type: "helper.getLog", lines: 50 })).toEqual({ text: "" });
    t.helper.info = INFO;
    expect(await t.req({ type: "helper.getLog", lines: 50 })).toEqual({ text: "log lines" });
    expect(await t.req({ type: "vault.list" })).toEqual({ exists: false, locked: true, sites: [] });
    expect(await t.req({ type: "vault.set", site: "a.com", username: "u", password: "p" })).toEqual({ ok: true });
    expect(await t.req({ type: "vault.reset" })).toEqual({ ok: true });
    expect(t.vault.reset).toHaveBeenCalledOnce();
  });

  it("vault.unlock: a wrong passphrase is an answer (ok: false), other failures are errors", async () => {
    const t = setup();
    expect(await t.req({ type: "vault.unlock", passphrase: "right" })).toEqual({ ok: true });
    t.vault.unlock.mockRejectedValueOnce(new WrongPassphraseError());
    expect(await t.req({ type: "vault.unlock", passphrase: "wrong" })).toEqual({ ok: false });
    t.vault.unlock.mockRejectedValueOnce(new Error("Passphrase is empty"));
    expect(await t.router.handle({ type: "vault.unlock", passphrase: "" })).toEqual({ ok: false, error: "Passphrase is empty" });
  });

  it("unknown requests are errors", async () => {
    const t = setup();
    expect(await t.router.handle({ type: "nope" } as never)).toEqual({ ok: false, error: "Unknown request type: nope" });
  });
});

describe("UiHub", () => {
  const port = (name = UI_PORT_NAME) => fakePort(name);
  const pushes = (p: FakePort) => p.posted as UiPush[];

  it("sends state on attach, pushes events, coalesces state pushes, forgets closed ports", async () => {
    const getState = vi.fn(async () => ({ paused: false }) as never);
    const hub = new UiHub(getState, { stateDelayMs: 5 });
    const p = port();
    expect(hub.attach(port("other"))).toBe(false);
    expect(hub.attach(p)).toBe(true);
    await vi.waitFor(() => expect(p.posted).toEqual([{ type: "state", state: { paused: false } }]));
    hub.push({ type: "tasks.changed" });
    hub.event({ type: "status", text: "x", ts: "t", sessionId: "s" });
    hub.pushState();
    hub.pushState();
    hub.pushState();
    await new Promise((r) => setTimeout(r, 20));
    expect(pushes(p).map((m) => m.type)).toEqual(["state", "tasks.changed", "event", "state"]);
    p.hostDisconnect();
    expect(hub.size).toBe(0);
  });

  it("stamps every state with an increasing rev, so a UI keeps the newest whatever order states arrive in", async () => {
    const t = setup();
    const a = await t.req<UiState>({ type: "state.get" });
    const b = await t.req<UiState>({ type: "state.get" });
    expect(a.rev).toBeGreaterThan(0);
    expect(b.rev!).toBeGreaterThan(a.rev!);
    expect(isStale(a, b)).toBe(true);
    expect(isStale(b, a)).toBe(false);
    expect(isStale(a, null)).toBe(false);
    // States without a rev (made up by tests and older backgrounds) are always taken.
    expect(isStale({}, b)).toBe(false);
    expect(isStale(a, {})).toBe(false);
  });

  it("never lets an older state overwrite a newer one when reading it takes longer", async () => {
    // The first read is slow, the second (after a change) fast: the fast one's state must be the last pushed.
    const reads: Array<(s: never) => void> = [];
    let n = 0;
    const getState = vi.fn(() => new Promise<never>((resolve) => reads.push(resolve)));
    const hub = new UiHub(getState, { stateDelayMs: 1 });
    const p = port();
    hub.attach(p);
    reads.shift()!({ v: n++ } as never); // the attach's state
    await vi.waitFor(() => expect(pushes(p)).toHaveLength(1));
    hub.pushState();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    hub.pushState();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    const [older, newer] = reads;
    newer!({ v: "new" } as never);
    await vi.waitFor(() => expect(pushes(p)).toHaveLength(2));
    older!({ v: "old" } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(pushes(p).map((m) => (m as unknown as { state: { v: unknown } }).state.v)).toEqual([0, "new"]);
  });
});

describe("UiRouter: account", () => {
  function withAccount(signedIn: boolean) {
    const t = setup();
    const view = { signedIn, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing" };
    const account = {
      view: vi.fn(async () => view),
      signIn: vi.fn(async () => void (view.signedIn = true)),
      signOut: vi.fn(async () => void (view.signedIn = false)),
      refresh: vi.fn(async (_force?: boolean) => {}),
      migrateLocalTasks: vi.fn(async () => ({ moved: 2, failed: 0, errors: [] })),
      dismissMigration: vi.fn(async () => {}),
      listKeys: vi.fn(async () => []),
      createKey: vi.fn(async (name: string, role: string) => ({ id: "k1", name, role, key: "bt_new" })),
      revokeKey: vi.fn(async (_id: string) => {}),
      transcribe: vi.fn(async (wav: Uint8Array, _opts: unknown) => ({ text: `heard ${wav.length} bytes` })),
      voiceEngines: vi.fn(async () => ({ engines: [], default: "standard" as const })),
      realtimeSession: vi.fn(async () => {
        if (!view.signedIn) throw new NotSignedInError();
        return { apiBase: "https://api.test", token: "tok" };
      }),
    };
    const accountTodo = {
      kind: "account" as const,
      list: vi.fn(async () => ({ tasks: [], locked: false })),
      add: vi.fn(async (i: any) => ({ id: "A1", ...i })),
      update: vi.fn(),
      delete: vi.fn(async () => true),
      retry: vi.fn(),
      cancel: vi.fn(async (id: string) => ({ id, status: "cancelled" })),
    };
    t.deps.account = account;
    t.deps.todo = async () => (view.signedIn ? (accountTodo as never) : (new LocalTodo(t.localStore) as never));
    return { ...t, account, accountTodo, view };
  }

  it("state carries the account; sign-in and sign-out return the new state", async () => {
    const t = withAccount(false);
    expect((await t.req({ type: "state.get" })).account).toMatchObject({ signedIn: false, signInConfigured: true });
    expect((await t.req({ type: "account.signIn" })).account.signedIn).toBe(true);
    expect((await t.req({ type: "account.signOut" })).account.signedIn).toBe(false);
    await t.req({ type: "account.refresh", force: true });
    expect(t.account.refresh).toHaveBeenCalledWith(true);
  });

  it("the TODO list comes from the account when signed in, from this browser otherwise", async () => {
    const t = withAccount(true);
    expect(await t.req({ type: "tasks.list" })).toEqual({ tasks: [], locked: false, source: "account" });
    // A plan without the TODO list: the kept tasks come with locked.
    t.accountTodo.list.mockResolvedValueOnce({ tasks: [], locked: true });
    expect(await t.req({ type: "tasks.list" })).toEqual({ tasks: [], locked: true, source: "account" });
    await t.req({ type: "tasks.add", instructions: "x", repeat: { cron: "0 9 * * *", tz: "UTC" } });
    expect(t.accountTodo.add).toHaveBeenCalledWith({ instructions: "x", account: null, notBefore: null, repeat: { cron: "0 9 * * *", tz: "UTC" }, media: [] });
    expect(await t.req({ type: "tasks.cancel", id: "A1" })).toEqual({ task: { id: "A1", status: "cancelled" } });
    t.view.signedIn = false;
    await t.localStore.add({ instructions: "local one" });
    const local = await t.req({ type: "tasks.list" });
    expect(local.source).toBe("local");
    expect(local.tasks).toHaveLength(1);
    expect(await t.router.handle({ type: "tasks.cancel", id: local.tasks[0].id })).toMatchObject({ ok: false, error: expect.stringMatching(/delete it instead/) });
  });

  it("schedule_task goes into the account's TODO list on a plan with it; Undo on the chat's card deletes it", async () => {
    const t = withAccount(true);
    Object.assign(t.view, { plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } });
    await t.sessions.create({ sessionId: "S1", source: "adhoc", title: "t", brain: "claude-api", jev: false, startedAt: new Date().toISOString() });
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const r = await t.router.scheduler.schedule("S1", { task: "Check the order status", schedule: { at } });
    expect(r).toMatchObject({ taskId: "A1", instructions: "Check the order status", nextRunAt: at });
    expect(t.accountTodo.add).toHaveBeenCalledWith({ instructions: "Check the order status", notBefore: at, repeat: null, agentAuthored: true });
    expect(await t.req({ type: "chat.undoScheduled", sessionId: "S1", taskId: "A1" })).toEqual({ ok: true });
    expect(t.accountTodo.delete).toHaveBeenCalledWith("A1");
    expect((await t.sessions.eventsOf("S1")).map((e) => e.type)).toEqual(["task_scheduled", "task_unscheduled"]);
  });

  it("schedule_task on Free, or signed out, is refused with the chat's fix", async () => {
    const t = withAccount(true);
    Object.assign(t.view, { plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } });
    await t.sessions.create({ sessionId: "S1", source: "adhoc", title: "t", brain: "claude-api", jev: false, startedAt: new Date().toISOString() });
    const args = { task: "x", schedule: { at: new Date(Date.now() + 60_000).toISOString() } };
    await expect(t.router.scheduler.schedule("S1", args)).rejects.toThrow(SCHEDULE_PLAN_REQUIRED);
    t.view.signedIn = false;
    await expect(t.router.scheduler.schedule("S1", args)).rejects.toThrow(SCHEDULE_SIGN_IN);
    expect(t.accountTodo.add).not.toHaveBeenCalled();
    expect((await t.sessions.eventsOf("S1")).map((e) => (e.type === "error" ? e.text : e.type))).toEqual([SCHEDULE_PLAN_REQUIRED, SCHEDULE_SIGN_IN]);
  });

  it("migrate and keys; no billing request (plans are bought on the dashboard)", async () => {
    const t = withAccount(true);
    const m = await t.req({ type: "account.migrate" });
    expect(m).toMatchObject({ moved: 2, failed: 0, state: { account: { signedIn: true } } });
    expect(await t.router.handle({ type: "account.billing", action: "topup", amountCents: 1000, returnUrl: "chrome-extension://x/options.html" } as never)).toMatchObject({ ok: false });
    expect(await t.req({ type: "account.keys.create", name: " cli ", role: "creator" })).toEqual({ id: "k1", name: "cli", role: "creator", key: "bt_new" });
    expect(await t.router.handle({ type: "account.keys.create", name: "", role: "creator" })).toEqual({ ok: false, error: "Give the key a name" });
    expect(await t.req({ type: "account.keys.revoke", id: "k1" })).toEqual({ ok: true });
  });

  it("without accounts wired in, account requests fail plainly", async () => {
    const t = setup();
    expect(await t.router.handle({ type: "account.signIn" })).toEqual({ ok: false, error: "Accounts are not available" });
    expect((await t.req({ type: "tasks.list" })).source).toBe("local");
    expect(await t.req({ type: "voice.transcribe", wav: "", speechMs: 0 })).toEqual({ error: { kind: "signed-out", message: "Log in to use voice.", fatal: true } });
  });

  it("voice.transcribe: the clip goes to the account, failures come back as data", async () => {
    const t = withAccount(true);
    const wav = btoa("RIFF1234");
    expect(await t.req({ type: "voice.transcribe", wav, speechMs: 900, context: "Open", sessionId: "s1" })).toEqual({ text: "heard 8 bytes" });
    expect(t.account.transcribe).toHaveBeenCalledWith(new TextEncoder().encode("RIFF1234"), { speechMs: 900, context: "Open", sessionId: "s1" });
    t.account.transcribe.mockRejectedValueOnce(
      new ApiRequestError(403, "plan_required", { error: "plan_required", feature: "voice", message: "Voice input needs the Plus or Pro plan.", upgradeUrl: "https://dash.test/billing" }),
    );
    expect(await t.req({ type: "voice.transcribe", wav, speechMs: 900 })).toEqual({
      error: { kind: "plan", message: "Voice needs the Plus or Pro plan.", fatal: true },
    });
    t.account.transcribe.mockRejectedValueOnce(new NotSignedInError());
    expect(await t.req({ type: "voice.transcribe", wav, speechMs: 900 })).toMatchObject({ error: { kind: "signed-out" } });
  });
});

describe("UiRouter: hands-free voice", () => {
  it("voice.engines: the account server's list; a failure comes back as data", async () => {
    const t = setup();
    expect(await t.req({ type: "voice.engines" })).toEqual({ error: "Accounts are not available" });
  });

  it("voice.realtime: the relay's wss address (with the chat) and the session token; signed out as data", async () => {
    const t = setup();
    const view = { signedIn: true };
    t.deps.account = {
      voiceEngines: vi.fn(async () => {
        throw new Error("Couldn't reach the account server");
      }),
      realtimeSession: vi.fn(async () => {
        if (!view.signedIn) throw new NotSignedInError();
        return { apiBase: "https://api.test", token: "tok" };
      }),
    } as never;
    expect(await t.req({ type: "voice.realtime", sessionId: "s1" })).toEqual({ url: "wss://api.test/v1/ai/realtime?session=s1", token: "tok" });
    expect(await t.req({ type: "voice.engines" })).toEqual({ error: "Couldn't reach the account server" });
    view.signedIn = false;
    expect(await t.req({ type: "voice.realtime" })).toEqual({ error: { kind: "signed-out", message: "Log in to use voice.", fatal: true } });
  });
});

describe("UiRouter: a chat per browser tab", () => {
  async function withTabs() {
    const t = setup();
    const tabChats = new TabChats({ exists: async () => true });
    const focused: number[] = [];
    t.deps.tabChats = tabChats;
    t.deps.runningTabs = async () => ({ "S-run": [42, 43] });
    t.deps.focusTab = async (tabId) => {
      focused.push(tabId);
      return true;
    };
    const router = new UiRouter(t.deps);
    const req = async <T = any>(r: { type: string; [k: string]: unknown }): Promise<T> => {
      const res = (await router.handle(r as UiRequest)) as UiResponse<T>;
      if (!res.ok) throw new Error(res.error);
      return res.data;
    };
    await t.sessions.create({ sessionId: "S1", source: "adhoc", title: "x", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    return { ...t, tabChats, req, focused };
  }

  it("state carries the tab bindings and the tabs of running sessions", async () => {
    const t = await withTabs();
    await t.tabChats.bind(7, "S1");
    const st = await t.req({ type: "state.get" });
    expect(st.tabChats).toEqual({ "7": "S1" });
    expect(st.runningTabs).toEqual({ "S-run": [42, 43] });
  });

  it("run.adhoc and a new run.message start in the tab they came from", async () => {
    const t = await withTabs();
    await t.req({ type: "run.adhoc", instructions: "do it", tabId: 7 });
    expect(t.runner.runAdhoc.mock.calls.at(-1)![0]).toMatchObject({ instructions: "do it", tabId: 7 });
    await t.req({ type: "run.message", text: "post gm", tabId: 9 });
    expect(t.runner.message).toHaveBeenLastCalledWith(undefined, "post gm", { tabId: 9 });
    // Bogus tab ids are ignored.
    await t.req({ type: "run.adhoc", instructions: "x", tabId: "7" });
    expect(t.runner.runAdhoc.mock.calls.at(-1)![0].tabId).toBeUndefined();
  });

  it("an empty message in Chat (screen) reaches the runner with its tab", async () => {
    const t = await withTabs();
    await t.req({ type: "run.adhoc", instructions: "", screen: true, tabId: 7 });
    expect(t.runner.runAdhoc.mock.calls.at(-1)![0]).toMatchObject({ instructions: "", screen: true, tabId: 7 });
    await t.req({ type: "run.message", sessionId: "S1", text: "", screen: true, tabId: 5 });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "", { tabId: 5, screen: true });
  });

  it("a spoken message (voice) reaches the runner marked as spoken", async () => {
    const t = await withTabs();
    await t.req({ type: "run.message", sessionId: "S1", text: "and reply", voice: true, tabId: 5 });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "and reply", { tabId: 5, voice: true });
    // Anything but true is not spoken.
    await t.req({ type: "run.message", sessionId: "S1", text: "typed", voice: "yes" });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "typed", {});
  });

  it("voice.spoken keeps a said line in its conversation (also after it ended); an unknown one is not ok", async () => {
    const t = setup();
    await t.sessions.create({ sessionId: "s1", source: "adhoc", title: "t", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    t.sessions.append("s1", { type: "task_end", outcome: "done", summary: "Read it" });
    await t.sessions.update("s1", { outcome: "done", endedAt: "2026-09-24T10:01:00Z" });
    expect(await t.req({ type: "voice.spoken", sessionId: "s1", text: "  Sarah says dinner moved to eight. " })).toEqual({ ok: true });
    expect((await t.sessions.eventsOf("s1")).map((e) => [e.type, "text" in e ? e.text : ""])).toEqual([
      ["task_end", ""],
      ["spoken", "Sarah says dinner moved to eight."],
    ]);
    expect(await t.req({ type: "voice.spoken", sessionId: "nope", text: "x" })).toEqual({ ok: false });
    expect(await t.router.handle({ type: "voice.spoken", sessionId: "s1", text: " " })).toEqual({ ok: false, error: "sessionId and text are required" });
  });

  it("run.message and run.adhoc pass a well-formed correlation id to the runner, and drop anything else", async () => {
    const t = setup();
    await t.req({ type: "run.message", sessionId: "S1", text: "go", cid: "c-1_a" });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "go", { cid: "c-1_a" });
    await t.req({ type: "run.message", sessionId: "S1", text: "go", cid: "bad id!" });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "go", {});
    await t.req({ type: "run.adhoc", instructions: "do", cid: "c2" });
    expect(t.runner.runAdhoc).toHaveBeenLastCalledWith(expect.objectContaining({ instructions: "do" }), "c2");
  });

  it("trace.add takes the panel's timings, checked and bounded; trace.get returns the conversation, its trace and where it ran", async () => {
    const t = setup();
    await t.sessions.create({ sessionId: "s1", source: "adhoc", title: "t", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    t.sessions.append("s1", { type: "status", text: "hi" });
    const ok = await t.req({
      type: "trace.add",
      sessionId: "s1",
      events: [
        { t: 1, ms: 700, cat: "voice", name: "voice.transcript", cid: "u1", src: "engine", data: { waitMs: 700, model: "m".repeat(1000), nested: { no: 1 } } },
        // Not the panel's to record, or not an event at all.
        { t: 2, cat: "model", name: "model.call" },
        { t: "x", cat: "voice", name: "voice.speech" },
        "junk",
      ],
    });
    expect(ok).toEqual({ ok: true });
    expect(await t.req({ type: "trace.add", sessionId: "nope", events: [] })).toEqual({ ok: false });
    await t.sessions.flush();
    const raw = await t.req({ type: "trace.get", sessionId: "s1" });
    expect(raw.session.sessionId).toBe("s1");
    expect(raw.events.map((e: { type: string }) => e.type)).toEqual(["status"]);
    const panel = raw.trace.events.filter((e: { src: string }) => e.src === "panel");
    expect(panel).toHaveLength(1);
    // Recorded as the panel's, whatever it said; strings bounded, only plain values kept.
    expect(panel[0]).toMatchObject({ cat: "voice", name: "voice.transcript", cid: "u1", ms: 700 });
    expect(panel[0].data.model).toHaveLength(300);
    expect(panel[0].data.nested).toBeUndefined();
    expect(raw.env).toMatchObject({ helper: null });
    expect(await t.router.handle({ type: "trace.get", sessionId: "nope" })).toEqual({ ok: false, error: "No session nope" });
  });

  it("voice.heard keeps words that led to no request in their conversation, for the record", async () => {
    const t = setup();
    await t.sessions.create({ sessionId: "s1", source: "adhoc", title: "t", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    expect(await t.req({ type: "voice.heard", sessionId: "s1", text: " what is it doing? " })).toEqual({ ok: true });
    expect(await t.sessions.eventsOf("s1")).toMatchObject([{ type: "heard", text: "what is it doing?" }]);
    expect(await t.req({ type: "voice.heard", sessionId: "nope", text: "x" })).toEqual({ ok: false });
    expect(await t.router.handle({ type: "voice.heard", sessionId: "s1", text: "" })).toEqual({ ok: false, error: "sessionId and text are required" });
  });

  it("a spoken run.message carries the user's words for it, word for word, to the runner (strings only, bounded)", async () => {
    const t = await withTabs();
    await t.req({ type: "run.message", sessionId: "S1", text: "Open Gmail", voice: true, heard: [" could you, um, ", "open gmail", 3 as unknown as string, ""] });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "Open Gmail", { voice: true, heard: ["could you, um,", "open gmail"] });
    // Typed: no words.
    await t.req({ type: "run.message", sessionId: "S1", text: "Open Gmail", heard: ["x"] });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "Open Gmail", {});
  });

  it("a message or Continue to a conversation passes the tab it was sent from to the runner (which binds it once taken)", async () => {
    const t = await withTabs();
    await t.req({ type: "run.message", sessionId: "S1", text: "go on", tabId: 5 });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "go on", { tabId: 5 });
    await t.req({ type: "run.continue", sessionId: "S1", tabId: 6 });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("S1", undefined, { tabId: 6 });
    // The router binds nothing itself: a refused message leaves the tabs as they were.
    expect(await t.tabChats.all()).toEqual({});
  });

  it("New Chat unbinds only that tab", async () => {
    const t = await withTabs();
    await t.tabChats.bind(5, "S1");
    await t.tabChats.bind(6, "S2");
    await t.req({ type: "run.newChat", sessionId: "S1", tabId: 5 });
    expect(await t.tabChats.all()).toEqual({ "6": "S2" });
    expect(t.runner.newChat).toHaveBeenLastCalledWith("S1");
    // Another tab's New Chat for a conversation that is not its own changes nothing.
    await t.req({ type: "run.newChat", sessionId: "S1", tabId: 6 });
    expect(await t.tabChats.all()).toEqual({ "6": "S2" });
  });

  it("chat.bind (Open in Chat) binds a known session to the tab and returns the state", async () => {
    const t = await withTabs();
    await t.tabChats.bind(3, "S1");
    const st = await t.req({ type: "chat.bind", sessionId: "S1", tabId: 8 });
    expect(st.tabChats).toEqual({ "8": "S1" });
    expect(await t.router.handle({ type: "chat.bind", sessionId: "nope", tabId: 8 })).toEqual({ ok: false, error: "No session nope" });
  });

  it("jobs.dismiss keeps what the user cleared (only job keys, only the known fields) and returns it in the state", async () => {
    const t = setup();
    const kept: Record<string, unknown>[] = [];
    let all = {};
    t.deps.dismissals = {
      all: async () => all,
      set: async (e) => {
        kept.push(e);
        all = { ...all, ...e };
      },
    };
    expect((await t.req({ type: "state.get" })).dismissals).toBeUndefined();
    const s = await t.req({
      type: "jobs.dismiss",
      dismissals: { "chat:a": { at: "2026-09-27T10:00:00.000Z", needs: "a:x", extra: 1 }, "bogus": { at: "2026-09-27T10:00:00.000Z" }, "task:t": { needs: "no time" } },
    });
    expect(kept).toEqual([{ "chat:a": { at: "2026-09-27T10:00:00.000Z", needs: "a:x" } }]);
    expect(s.dismissals).toEqual({ "chat:a": { at: "2026-09-27T10:00:00.000Z", needs: "a:x" } });
  });

  it("tab.focus switches to a tab", async () => {
    const t = await withTabs();
    expect(await t.req({ type: "tab.focus", tabId: 43 })).toEqual({ ok: true });
    expect(t.focused).toEqual([43]);
  });
});
