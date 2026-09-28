import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { DRAWN } from "./driver-harness.js";
import { AgentSlots } from "../src/agent-slots.js";
import { Cdp } from "../src/cdp.js";
import { stopOf } from "../src/engine/run/active.js";
import { MOVED_TAB_STATUS } from "../src/engine/run/turn.js";
import { Runner } from "../src/engine/runner.js";
import { TabChats } from "../src/tab-chats.js";
import { env, parallel, setupRunnerTests } from "./runner/harness.js";

describe("TabChats: which conversation belongs to which tab", () => {
  let chrome: ChromeFake;
  beforeEach(() => {
    chrome = installChromeFake();
  });

  it("binds one conversation per tab and one tab per conversation", async () => {
    const chats = new TabChats({ exists: async () => true });
    const changes = vi.fn();
    chats.onChange(changes);
    expect(await chats.get(1)).toBeNull();
    await chats.bind(1, "A");
    await chats.bind(2, "B");
    expect(await chats.all()).toEqual({ "1": "A", "2": "B" });
    expect(await chats.tabOf("B")).toBe(2);
    // A conversation opened in another tab leaves its old tab; the tab's earlier conversation is replaced.
    await chats.bind(2, "A");
    expect(await chats.all()).toEqual({ "2": "A" });
    expect(await chats.tabOf("B")).toBeNull();
    // Binding it where it already is changes nothing.
    const n = changes.mock.calls.length;
    await chats.bind(2, "A");
    expect(changes.mock.calls.length).toBe(n);
    expect(n).toBe(3);
  });

  it("unbind clears only that tab, and only for the conversation named", async () => {
    const chats = new TabChats({ exists: async () => true });
    await chats.bind(1, "A");
    await chats.bind(2, "B");
    expect(await chats.unbind(1, "B")).toBeNull();
    expect(await chats.unbind(1)).toBe("A");
    expect(await chats.unbind(1)).toBeNull();
    expect(await chats.all()).toEqual({ "2": "B" });
  });

  it("lives in chrome.storage.session, so a restarted worker finds it; closed tabs are dropped on load", async () => {
    const win = await chrome.windows.create({ url: "https://a.test/", focused: true, type: "normal" });
    const a = win.tabs[0]!.id;
    const b = (await chrome.tabs.create({ windowId: win.id, url: "https://b.test/" })).id;
    await new TabChats().bind(a, "A");
    const before = new TabChats();
    await before.bind(b, "B");
    expect(chrome.storage.session.data.tabChats).toEqual({ [a]: "A", [b]: "B" });
    await chrome.tabs.remove(b);
    const after = new TabChats();
    expect(await after.all()).toEqual({ [String(a)]: "A" });
    expect(chrome.storage.session.data.tabChats).toEqual({ [a]: "A" });
  });
});

describe("AgentSlots: a run acts in the tab it belongs to", () => {
  let chrome: ChromeFake;
  let windowId: number;
  let tabA: number;
  let tabB: number;
  const vault = { getCredential: async () => ({ found: false as const }) };

  beforeEach(async () => {
    chrome = installChromeFake();
    const win = await chrome.windows.create({ url: "https://a.test/", focused: true, type: "normal" });
    windowId = win.id;
    tabA = win.tabs[0]!.id;
    tabB = (await chrome.tabs.create({ windowId, url: "https://b.test/", active: false })).id;
    chrome.debugger.respond = (method) => {
      const tabId = chrome.debugger.commands.at(-1)!.tabId;
      if (method === "Runtime.evaluate") return { result: { value: { url: chrome.tabs.byId.get(tabId)!.url, title: "t", text: "", elements: DRAWN, truncated: false } } };
      return {};
    };
  });

  it("runs in tabs A and B at the same time, each in its own tab, whichever tab is active", async () => {
    const slots = new AgentSlots(new Cdp(), vault);
    // The user is on tab A; a run from tab B still acts on B, and A's on A.
    expect(await slots.take(0, "SA").prepare({ mode: "current-tab", tabId: tabA })).toBe(tabA);
    await chrome.tabs.update(tabB, { active: true });
    expect(await slots.take(1, "SB").prepare({ mode: "current-tab", tabId: tabB })).toBe(tabB);
    await chrome.tabs.update(tabA, { active: true });
    const tabOf = async (sessionId: string) => {
      await slots.browserFor(sessionId).call("browser.readPage", {});
      return chrome.debugger.commands.at(-1)!.tabId;
    };
    expect(await tabOf("SB")).toBe(tabB);
    expect(await tabOf("SA")).toBe(tabA);
    expect(await slots.tabsOf("SA")).toEqual([tabA]);
    expect(await slots.tabsOf("SB")).toEqual([tabB]);
    expect(await slots.tabsOf("nobody")).toEqual([]);
    expect(chrome.tabs.createCalls).toHaveLength(1);
  });

  it("a tab that cannot be controlled gets a new tab next to it", async () => {
    const slots = new AgentSlots(new Cdp(), vault);
    const settings = (await chrome.tabs.create({ windowId, url: "chrome://settings/", active: false })).id;
    chrome.tabs.createCalls.length = 0;
    const picked = await slots.take(0, "S").prepare({ mode: "current-tab", tabId: settings });
    expect(picked).not.toBe(settings);
    // The chrome:// tab is in the background: so is its replacement.
    expect(chrome.tabs.createCalls).toEqual([{ windowId, index: 3, active: false, url: "about:blank" }]);
  });

  it("the replacement of the tab the user is looking at opens in front (the side panel follows it there)", async () => {
    const newTab = (await chrome.tabs.create({ windowId, url: "chrome://newtab/", active: true })).id;
    chrome.tabs.createCalls.length = 0;
    await new AgentSlots(new Cdp(), vault).take(0, "S").prepare({ mode: "current-tab", tabId: newTab });
    expect(chrome.tabs.createCalls.at(-1)?.active).toBe(true);
  });

  it("an origin tab that is gone falls back to the tab the user is looking at", async () => {
    const slots = new AgentSlots(new Cdp(), vault);
    expect(await slots.take(0, "S").prepare({ mode: "current-tab", tabId: 999 })).toBe(tabA);
  });

  it("scheduled runs do not take over a tab that has a chat", async () => {
    const chats = new TabChats();
    const slots = new AgentSlots(new Cdp(), vault, async (t) => (await chats.get(t)) !== null);
    // A one-off in tab A used slot 0; its conversation belongs to A.
    await slots.take(0, "S").prepare({ mode: "current-tab", tabId: tabA });
    await chats.bind(tabA, "S");
    slots.release(0, "S", { keepTabs: true });
    const own = await slots.take(0, "T").prepare({ mode: "own-tab" });
    expect(own).not.toBe(tabA);
    expect(own).not.toBe(tabB);
    // Without a chat there, the slot's tab is reused as before.
    await chats.unbind(tabA);
    slots.release(0, "T", { keepTabs: true });
    await chrome.tabs.remove(own as number);
    await slots.take(0, "U").prepare({ mode: "current-tab", tabId: tabA });
    slots.release(0, "U", { keepTabs: true });
    expect(await slots.take(0, "V").prepare({ mode: "own-tab" })).toBe(tabA);
  });
});

describe("Runner: a chat per tab", () => {
  setupRunnerTests();

  function withChats() {
    const p = parallel();
    const chats = new TabChats({ exists: async () => true });
    p.h.deps.tabChats = chats;
    p.h.runner = new Runner(p.h.deps);
    return { ...p, chats };
  }

  it("a one-off run is bound to the tab it was started from before it acts, and prepares that tab", async () => {
    const { h, pool, chats } = withChats();
    h.brain.script = () => ({ outcome: "done" });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "one", tabId: 7 });
    // Bound when runAdhoc resolves: the panel of tab 7 shows it at once.
    expect(await chats.get(7)).toBe(sessionId);
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 current-tab tab 7"]);
    // Through message() (the composer with no conversation) too.
    const m = await h.runner.message(null, "two", { tabId: 8 });
    await h.runner.idle();
    expect(m.mode).toBe("new");
    expect(await chats.all()).toEqual({ "7": sessionId, "8": m.sessionId });
  });

  it("runs from two tabs go on at the same time, each in its own tab", async () => {
    const { h, pool, chats, startsOf } = withChats();
    const a = await h.runner.runAdhoc({ instructions: "in A", tabId: 7 });
    const b = await h.runner.runAdhoc({ instructions: "in B", tabId: 8 });
    await vi.waitFor(() => expect(startsOf()).toHaveLength(2));
    expect(h.runner.runningSessions.map((s) => s.sessionId)).toEqual([a.sessionId, b.sessionId]);
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 current-tab tab 7", "prepare 1 current-tab tab 8"]);
    expect(h.brain.starts[0]!.browser).toBe(pool.slots.get(0)!.browser);
    expect(h.brain.starts[1]!.browser).toBe(pool.slots.get(1)!.browser);
    expect(await chats.all()).toEqual({ "7": a.sessionId, "8": b.sessionId });
    // Tab B's conversation takes a message while A's keeps running.
    expect((await h.runner.message(b.sessionId, "faster please")).mode).toBe("inject");
    expect(h.brain.ctls[1]!.said).toEqual(["faster please"]);
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    h.brain.ctls[1]!.resolve({ outcome: "done" });
    await h.runner.idle();
  });

  it("a message sent from another tab moves the conversation there once it is taken; a refused one moves nothing", async () => {
    const { h, pool, chats } = withChats();
    h.brain.script = () => ({ outcome: "done" });
    const a = await h.runner.runAdhoc({ instructions: "one", tabId: 7 });
    await h.runner.idle();
    await h.runner.message(a.sessionId, "more", { tabId: 9 });
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare")).at(-1)).toBe("prepare 0 current-tab tab 9");
    expect(await chats.all()).toEqual({ "9": a.sessionId });
    // Continue refuses a run that finished: tab 5 stays without a chat.
    await expect(h.runner.continueSession(a.sessionId, undefined, { tabId: 5 })).rejects.toThrow(/already finished/);
    expect(await chats.all()).toEqual({ "9": a.sessionId });
    // A running turn takes the message: the conversation follows the tab it came from.
    h.brain.continueScript = () => "hang";
    await h.runner.message(a.sessionId, "and more");
    await vi.waitFor(() => expect(h.brain.continues).toHaveLength(2));
    expect((await h.runner.message(a.sessionId, "faster", { tabId: 4 })).mode).toBe("inject");
    expect(await chats.all()).toEqual({ "4": a.sessionId });
    h.runner.stop();
    await h.runner.idle();
  });

  it("a conversation's next turn acts in its tab; Open in Chat moves it to another tab", async () => {
    const { h, pool, chats } = withChats();
    h.brain.script = () => ({ outcome: "done" });
    const a = await h.runner.runAdhoc({ instructions: "one", tabId: 7 });
    await h.runner.idle();
    await h.runner.message(a.sessionId, "more");
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare")).at(-1)).toBe("prepare 0 current-tab tab 7");
    // "Open in Chat" in tab 9 binds it there; its next turn acts in tab 9.
    await chats.bind(9, a.sessionId);
    await h.runner.message(a.sessionId, "now here");
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare")).at(-1)).toBe("prepare 0 current-tab tab 9");
    expect(await chats.all()).toEqual({ "9": a.sessionId });
  });

  it("when its tab shows a chrome:// page the run opens a new tab and the conversation moves there", async () => {
    const { h, pool, chats } = withChats();
    h.brain.script = () => ({ outcome: "done" });
    pool.pick = (_i, opts) => (opts.tabId === 7 ? 70 : (opts.tabId ?? 100));
    const a = await h.runner.runAdhoc({ instructions: "one", tabId: 7 });
    await h.runner.idle();
    await h.sessions.flush();
    expect(await chats.all()).toEqual({ "70": a.sessionId });
    const events = await h.sessions.eventsOf(a.sessionId);
    expect(events.some((e) => e.type === "status" && e.text === MOVED_TAB_STATUS)).toBe(true);
    // The next turn goes to the new tab.
    await h.runner.message(a.sessionId, "more");
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare")).at(-1)).toBe("prepare 0 current-tab tab 70");
  });

  it("closing the tab of a running chat stops it as paused; the session stays", async () => {
    const { h, chats, startsOf } = withChats();
    const a = await h.runner.runAdhoc({ instructions: "in A", tabId: 7 });
    const b = await h.runner.runAdhoc({ instructions: "in B", tabId: 8 });
    await vi.waitFor(() => expect(startsOf()).toHaveLength(2));
    // What background.ts does on chrome.tabs.onRemoved.
    const closed = await chats.unbind(7);
    expect(closed).toBe(a.sessionId);
    expect(h.runner.onChatTabClosed(closed!)).toBe(true);
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: stopOf("tab-closed").reason, outcome: "paused" }]);
    await vi.waitFor(async () => expect((await h.sessions.get(a.sessionId))?.outcome).toBe("paused"));
    expect((await h.sessions.get(a.sessionId))?.reason).toBe(stopOf("tab-closed").reason);
    // Tab B's run goes on.
    expect(h.runner.runningSessions.map((s) => s.sessionId)).toEqual([b.sessionId]);
    expect(h.runner.onChatTabClosed("unknown")).toBe(false);
    expect(await chats.all()).toEqual({ "8": b.sessionId });
    h.brain.ctls[1]!.resolve({ outcome: "done" });
    await h.runner.idle();
    expect(env.chrome).toBeTruthy();
  });

  it("scheduled runs keep their own tab and are not bound to any tab", async () => {
    const { h, pool, chats, finishTask } = withChats();
    await h.store.add({ instructions: "scheduled" });
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    await finishTask(h.brain.starts[0]!.task.id);
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 own-tab"]);
    expect(await chats.all()).toEqual({});
  });
});
