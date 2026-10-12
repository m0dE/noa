/**
 * Tabs the agent opens for a chat: they must survive the turn ending with a
 * pause (sign in, a question, an approval) and be there for the next turn
 * ("go on") of the same chat. Real AgentSlots on the chrome fake; a scripted brain.
 */
import { describe, expect, it, vi } from "vitest";
import type { BrowserCaller } from "@noa/core";
import { AgentSlots } from "../../src/agent-slots.js";
import { Cdp } from "../../src/cdp.js";
import { Runner } from "../../src/engine/runner.js";
import { env, harness, runAll, setupRunnerTests, type Harness } from "./harness.js";

setupRunnerTests();

const vault = { getCredential: async () => ({ found: false as const }) };
const SITES = ["https://app.roomsy.test/login", "https://app.channex.test/login"];

async function withRealSlots(): Promise<{ h: Harness; userTab: number }> {
  const h = harness();
  const win = await env.chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
  const userTab = win.tabs[0]!.id;
  env.chrome.debugger.respond = (method) => {
    const tabId = env.chrome.debugger.commands.at(-1)!.tabId;
    if (method === "Runtime.evaluate") return { result: { value: { url: env.chrome.tabs.byId.get(tabId)!.url, title: "t", text: "", elements: [], truncated: false } } };
    return {};
  };
  h.deps.slots = new AgentSlots(new Cdp(), vault);
  h.runner = new Runner(h.deps);
  return { h, userTab };
}

async function settle(h: Harness) {
  await h.runner.idle();
  await h.sessions.flush();
}

const open = (tabId: number) => env.chrome.tabs.byId.has(tabId);
const siteTabs = () => [...env.chrome.tabs.byId.values()].filter((t) => SITES.includes(t.url)).map((t) => t.id);

describe("Runner: tabs the agent opened for a chat", () => {
  it("stay open while the chat is paused for the user (sign in) and are the chat's tabs on its next turn", async () => {
    const { h, userTab } = await withRealSlots();
    // Turn 1: open both sites, then pause so the user can sign in there.
    let created: number[] = [];
    h.brain.script = async (opts) => {
      await opts.browser!.call("browser.openTabs", { urls: SITES });
      created = siteTabs();
      return { outcome: "paused", reason: "Sign in to app.roomsy.test and app.channex.test in the tabs I opened, then tell me to go on." };
    };
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Sync the rates from Roomsy to Channex", tabId: userTab });
    await settle(h);
    expect(h.brain.starts).toHaveLength(1);
    expect((await h.sessions.get(sessionId))?.outcome).toBe("paused");
    // Both tabs were opened during the turn.
    const opened = created;
    expect(opened).toHaveLength(2);
    // Give any fire-and-forget cleanup the chance to run.
    await vi.waitFor(() => new Promise((r) => setTimeout(r, 20)));

    // The user signs in within the agent's tabs: they must still be there.
    expect(opened.map(open)).toEqual([true, true]);

    // Turn 2 ("go on"): the same chat carries on in those tabs.
    let listed: { id: string; url: string }[] = [];
    h.brain.continueScript = async (opts) => {
      listed = ((await (opts.browser as BrowserCaller).call("browser.listTabs", {})) as { tabs: { id: string; url: string }[] }).tabs;
      return { outcome: "done", summary: "synced" };
    };
    await h.runner.continueSession(sessionId, "go on", { tabId: userTab });
    await settle(h);
    expect(h.brain.continues).toHaveLength(1);
    expect(listed.map((t) => t.url)).toEqual(["https://news.test/", ...SITES]);
    expect(opened.map(open)).toEqual([true, true]);
  });
});

describe("AgentSlots: a chat's next turn in the same slot", () => {
  it("keeps the tabs the previous turn of the chat opened (prepare does not close them)", async () => {
    const win = await env.chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
    const userTab = win.tabs[0]!.id;
    env.chrome.debugger.respond = () => ({});
    const slots = new AgentSlots(new Cdp(), vault);
    const slot = slots.get(0);
    // Turn 1 opens both sites (release is not involved here: only the next turn's prepare).
    await slot.prepare({ mode: "current-tab", tabId: userTab });
    await slot.tab.open(SITES);
    const opened = siteTabs();
    expect(opened).toHaveLength(2);
    // Turn 2 of the same chat, from the same tab.
    await slot.prepare({ mode: "current-tab", tabId: userTab });
    expect(opened.map(open)).toEqual([true, true]);
  });
});

/** Turn 1 of a chat from the user's tab: opens both sites, then pauses for the user to sign in there. */
async function pausedChat(h: Harness, userTab: number): Promise<{ sessionId: string; opened: number[] }> {
  h.brain.script = async (opts) => {
    await opts.browser!.call("browser.openTabs", { urls: SITES });
    return { outcome: "paused", reason: "Sign in to both sites in the tabs I opened" };
  };
  const { sessionId } = await h.runner.runAdhoc({ instructions: "Sync the rates", tabId: userTab });
  await settle(h);
  const opened = siteTabs();
  expect(opened).toHaveLength(2);
  return { sessionId, opened };
}

/** The urls the next turn of the chat lists with browser.listTabs. */
async function nextTurnTabs(h: Harness, sessionId: string, userTab: number): Promise<string[]> {
  let listed: { url: string }[] = [];
  h.brain.continueScript = async (opts) => {
    listed = ((await (opts.browser as BrowserCaller).call("browser.listTabs", {})) as { tabs: { url: string }[] }).tabs;
    return { outcome: "done", summary: "ok" };
  };
  await h.runner.continueSession(sessionId, "go on", { tabId: userTab });
  await settle(h);
  return listed.map((t) => t.url);
}

describe("Runner: when a chat's tabs close", () => {
  it("stay open after a turn that ends done, and New Chat closes them (never the user's tab)", async () => {
    const { h, userTab } = await withRealSlots();
    const { sessionId, opened } = await pausedChat(h, userTab);
    expect(await nextTurnTabs(h, sessionId, userTab)).toEqual(["https://news.test/", ...SITES]);
    expect(opened.map(open)).toEqual([true, true]);
    await h.runner.newChat(sessionId);
    expect(opened.map(open)).toEqual([false, false]);
    expect(open(userTab)).toBe(true);
  });

  it("New Chat leaves a tab the user is looking at", async () => {
    const { h, userTab } = await withRealSlots();
    const { sessionId, opened } = await pausedChat(h, userTab);
    await env.chrome.tabs.update(opened[0]!, { active: true });
    await h.runner.newChat(sessionId);
    expect(opened.map(open)).toEqual([true, false]);
  });

  it("a tab the user closed is forgotten: the next turn lists the others, New Chat closes the rest", async () => {
    const { h, userTab } = await withRealSlots();
    const { sessionId, opened } = await pausedChat(h, userTab);
    await env.chrome.tabs.remove(opened[0]!);
    expect(await nextTurnTabs(h, sessionId, userTab)).toEqual(["https://news.test/", SITES[1]]);
    await h.runner.newChat(sessionId);
    expect(opened.map(open)).toEqual([false, false]);
  });

  it("a restarted service worker still knows the chat's tabs: its next turn has them, New Chat closes them", async () => {
    const { h, userTab } = await withRealSlots();
    const { sessionId, opened } = await pausedChat(h, userTab);
    // A new worker: new slots and runner, the same chrome.storage.session.
    h.deps.slots = new AgentSlots(new Cdp(), vault);
    h.runner = new Runner(h.deps);
    expect(await nextTurnTabs(h, sessionId, userTab)).toEqual(["https://news.test/", ...SITES]);
    h.deps.slots = new AgentSlots(new Cdp(), vault);
    h.runner = new Runner(h.deps);
    await h.runner.newChat(sessionId);
    expect(opened.map(open)).toEqual([false, false]);
  });
});

describe("Runner: tabs of an unattended TODO run", () => {
  it("stay open while the run waits for the user, and close when the task's next run ends", async () => {
    const { h } = await withRealSlots();
    const task = await h.store.add({ instructions: "Sync the rates" });
    h.brain.script = async (opts) => {
      await opts.browser!.call("browser.openTabs", { urls: SITES });
      return { outcome: "paused", reason: "Sign in to both sites" };
    };
    await runAll(h);
    expect((await h.store.get(task.id))?.status).toBe("paused");
    const opened = siteTabs();
    expect(opened.map(open)).toEqual([true, true]);
    // The user signed in and runs it again: it opens one more tab and finishes.
    let more: number[] = [];
    h.brain.script = async (opts) => {
      await opts.browser!.call("browser.openTabs", { urls: ["https://report.test/"] });
      more = [...env.chrome.tabs.byId.values()].filter((t) => t.url === "https://report.test/").map((t) => t.id);
      return { outcome: "done", summary: "synced" };
    };
    await h.runner.runTask(task.id);
    await settle(h);
    expect((await h.store.get(task.id))?.status).toBe("done");
    expect(more).toHaveLength(1);
    await vi.waitFor(() => expect([...opened, ...more].map(open)).toEqual([false, false, false]));
  });

  it("close when the run is stopped by the user", async () => {
    const { h } = await withRealSlots();
    await h.store.add({ instructions: "Sync the rates" });
    h.brain.script = (opts) => {
      void opts.browser!.call("browser.openTabs", { urls: SITES });
      return "hang";
    };
    const run = runAll(h);
    await vi.waitFor(() => expect(siteTabs()).toHaveLength(2));
    const opened = siteTabs();
    h.runner.stop();
    await run;
    await vi.waitFor(() => expect(opened.map(open)).toEqual([false, false]));
  });
});
