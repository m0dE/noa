/**
 * Runner: the agent is told which page the chat's tab shows, an empty message in Chat ("look at the page"), and
 * turns that start from a page Chrome keeps extensions out of.
 */
import { describe, expect, it, vi } from "vitest";
import { SCREEN_HELP_TEXT } from "@noa/shared";
import { buildFollowUpMessage, buildTaskPrompt } from "@noa/core";
import { Runner } from "../../src/engine/runner.js";
import { MOVED_TAB_STATUS } from "../../src/engine/run/turn.js";
import { asksAboutThePage, RESTRICTED_STATUS } from "../../src/restricted.js";
import { TabChats } from "../../src/tab-chats.js";
import { parallel, setupRunnerTests, withoutClock } from "./harness.js";

setupRunnerTests();

/** Parallel slots with a chat per tab; `pages` is what chrome.tabs says each tab shows. */
function withChats(pages: Record<number, { url: string; title: string }> = {}) {
  const p = parallel();
  const chats = new TabChats({ exists: async () => true });
  p.h.deps.tabChats = chats;
  p.h.deps.pageOf = async (tabId) => (tabId === undefined ? null : { tabId, ...(pages[tabId] ?? { url: `https://site.test/${tabId}`, title: `Tab ${tabId}` }) });
  p.h.runner = new Runner(p.h.deps);
  return { ...p, chats };
}

async function statuses(h: ReturnType<typeof withChats>["h"], sessionId: string): Promise<string[]> {
  await h.sessions.flush();
  return (await h.sessions.eventsOf(sessionId)).flatMap((e) => (e.type === "status" ? [e.text] : []));
}

describe("Runner: an empty message looks at the page", () => {
  it("a new conversation: the request is SCREEN_HELP_TEXT with screenHelp set, in the tab it was sent from", async () => {
    const { h, chats, pool } = withChats();
    h.brain.script = () => ({ outcome: "done", summary: "verified" });
    const r = await h.runner.message(null, "", { tabId: 7, screen: true });
    expect(r.mode).toBe("new");
    await h.runner.idle();
    const task = h.brain.starts[0]!.task;
    expect(task).toMatchObject({ instructions: SCREEN_HELP_TEXT, screenHelp: true, userTab: { url: "https://site.test/7", title: "Tab 7", access: "here" } });
    // What the agent reads (built by the usual task prompt).
    expect(buildTaskPrompt(task, [], { isRetry: false })).toMatch(/call screenshot, then read_page/);
    const session = await h.sessions.get(r.sessionId);
    expect(session?.title).toBe(SCREEN_HELP_TEXT);
    // The fresh-session summary of a later turn starts from this request.
    expect(session?.instructions).toBe(SCREEN_HELP_TEXT);
    // It acts on the tab it was sent from, which it now belongs to.
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 current-tab tab 7"]);
    expect(await chats.get(7)).toBe(r.sessionId);
  });

  it("without the screen flag an empty message is still refused", async () => {
    const { h } = withChats();
    await expect(h.runner.message(null, "   ", { tabId: 7 })).rejects.toThrow(/empty/);
    await expect(h.runner.runAdhoc({ instructions: "" })).rejects.toThrow(/empty/);
  });

  it("an ended conversation goes on: the chat shows SCREEN_HELP_TEXT, the agent is told to look again", async () => {
    const { h } = withChats();
    h.brain.script = () => ({ outcome: "done", summary: "first" });
    const first = await h.runner.message(null, "Sign up on site.test", { tabId: 7 });
    await h.runner.idle();
    h.brain.continueScript = () => ({ outcome: "done", summary: "second" });
    const next = await h.runner.message(first.sessionId, "", { tabId: 7, screen: true });
    expect(next).toEqual({ sessionId: first.sessionId, mode: "turn" });
    await h.runner.idle();
    await h.sessions.flush();
    expect(withoutClock(h.brain.continues[0]!.text)).toBe(buildFollowUpMessage({ text: SCREEN_HELP_TEXT, screenHelp: true, userTab: { url: "https://site.test/7", title: "Tab 7", access: "here" } }));
    const users = (await h.sessions.eventsOf(first.sessionId)).filter((e) => e.type === "user_message");
    expect(users.map((e) => (e.type === "user_message" ? e.text : ""))).toEqual([SCREEN_HELP_TEXT]);
  });

  it("while a turn runs, an empty message is refused (the agent is looking already)", async () => {
    const { h } = withChats();
    const r = await h.runner.message(null, "do it", { tabId: 7 });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    await expect(h.runner.message(r.sessionId, "", { screen: true })).rejects.toThrow(/working/);
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await h.runner.idle();
  });
});

describe("Runner: the agent is told which page the chat's tab shows", () => {
  const INBOX = { url: "https://mail.test/inbox", title: "Inbox (8) - Mail" };

  it("a new conversation from a tab: the task carries the tab's title and address, and the run works in it", async () => {
    const { h } = withChats({ 7: INBOX });
    h.brain.script = () => ({ outcome: "done" });
    await h.runner.message(null, "Which emails need a reply?", { tabId: 7 });
    await h.runner.idle();
    const task = h.brain.starts[0]!.task;
    expect(task.userTab).toEqual({ ...INBOX, access: "here" });
    const prompt = buildTaskPrompt(task, [], { isRetry: false });
    // Before the instructions: what "these" or "the inbox here" refer to.
    expect(prompt.indexOf(INBOX.url)).toBeLessThan(prompt.indexOf("Which emails need a reply?"));
    expect(prompt).toContain(`"${INBOX.title}"`);
  });

  it("a tab another run is using: the run works next to it, and the agent is told so", async () => {
    const { h, pool } = withChats({ 7: INBOX });
    pool.pick = (index, opts) => (opts.tabId === 7 ? 50 : 100 + index);
    h.brain.script = () => ({ outcome: "done" });
    await h.runner.message(null, "Summarize this page", { tabId: 7 });
    await h.runner.idle();
    const task = h.brain.starts[0]!.task;
    expect(task.userTab).toEqual({ ...INBOX, access: "elsewhere" });
    expect(buildTaskPrompt(task, [], { isRetry: false })).toMatch(/working in a new tab next to it/);
  });

  it("every next turn starts with what the tab shows now (the user may have moved on)", async () => {
    const pages: Record<number, { url: string; title: string }> = { 7: INBOX };
    const { h } = withChats(pages);
    h.brain.script = () => ({ outcome: "done" });
    const r = await h.runner.message(null, "hello", { tabId: 7 });
    await h.runner.idle();
    pages[7] = { url: "https://shop.test/cart", title: "Cart" };
    h.brain.continueScript = () => ({ outcome: "done" });
    await h.runner.message(r.sessionId, "what's in it?", { tabId: 7 });
    await h.runner.idle();
    const sent = withoutClock(h.brain.continues[0]!.text);
    expect(sent).toBe(buildFollowUpMessage({ text: "what's in it?", userTab: { ...pages[7]!, access: "here" } }));
    expect(sent.indexOf("https://shop.test/cart")).toBeLessThan(sent.indexOf("what's in it?"));
  });

  it("TODO and scheduled tasks run in their own tab and are not told about the user's", async () => {
    const { h } = withChats();
    h.deps.pageOf = async (tabId) => ({ tabId: tabId ?? 3, ...INBOX });
    h.runner = new Runner(h.deps);
    await h.store.add({ instructions: "Check the weather" });
    h.brain.script = () => ({ outcome: "done" });
    await h.runner.runDue("manual");
    await h.runner.idle();
    expect(h.brain.starts[0]!.task.userTab).toBeUndefined();
  });

  it("a one-off run without a tab works in the tab the user is looking at, and is told what it shows", async () => {
    const { h, pool } = withChats();
    h.deps.pageOf = async (tabId) => ({ tabId: tabId ?? 100, ...INBOX });
    h.runner = new Runner(h.deps);
    h.brain.script = () => ({ outcome: "done" });
    await h.runner.runAdhoc({ instructions: "Which emails need a reply?" });
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 current-tab"]);
    expect(h.brain.starts[0]!.task.userTab).toEqual({ ...INBOX, access: "here" });
  });
});

describe("Runner: the user's tab is a page Chrome keeps extensions out of", () => {
  const STORE = { url: "https://chrome.google.com/webstore/devconsole/abc", title: "Chrome Web Store - Developer Dashboard" };

  it("the run starts anyway, in a tab next to it; the agent is told the page; the chat gets no line when the request goes elsewhere", async () => {
    const { h, pool, chats } = withChats({ 7: STORE });
    // Like AgentTab.prepare: a page it cannot control gets a new tab next to it.
    pool.pick = (index, opts) => (opts.tabId === 7 ? 50 : 100 + index);
    h.brain.script = () => ({ outcome: "done" });
    const r = await h.runner.message(null, "can u verify email", { tabId: 7 });
    await h.runner.idle();
    const task = h.brain.starts[0]!.task;
    expect(task).toMatchObject({ instructions: "can u verify email", userTab: { ...STORE, access: "restricted" } });
    const prompt = buildTaskPrompt(task, [], { isRetry: false });
    expect(prompt).toContain(STORE.url);
    expect(prompt).toMatch(/does not allow extensions to see or control that page/);
    expect((await h.sessions.get(r.sessionId))?.outcome).toBe("done");
    const lines = await statuses(h, r.sessionId);
    expect(lines).not.toContain(RESTRICTED_STATUS);
    expect(lines).not.toContain(MOVED_TAB_STATUS);
    // The conversation follows the tab it works in.
    expect(await chats.get(50)).toBe(r.sessionId);
  });

  it("a request about that page (or an empty send) gets the quiet line once; one that goes elsewhere does not", async () => {
    const { h, pool } = withChats({ 7: STORE });
    pool.pick = (index, opts) => (opts.tabId === 7 ? 50 : 100 + index);
    h.brain.script = () => ({ outcome: "done" });
    const about = await h.runner.message(null, "can u verify the email on this page", { tabId: 7 });
    await h.runner.idle();
    expect((await statuses(h, about.sessionId)).filter((l) => l === RESTRICTED_STATUS)).toHaveLength(1);
    expect(asksAboutThePage("what's on screen?")).toBe(true);
    expect(asksAboutThePage("summarize this article")).toBe(true);
    expect(asksAboutThePage("", true)).toBe(true);
    expect(asksAboutThePage("Open x.com and post gm")).toBe(false);
    expect(asksAboutThePage("check my mail")).toBe(false);
  });

  it("an empty message there: the agent works from the title and address, and says it cannot see the page", async () => {
    const { h, pool } = withChats({ 7: { url: "chrome://newtab/", title: "New Tab" } });
    pool.pick = (index, opts) => (opts.tabId === 7 ? 50 : 100 + index);
    h.brain.script = () => ({ outcome: "done" });
    const empty = await h.runner.message(null, "", { tabId: 7, screen: true });
    await h.runner.idle();
    expect(await statuses(h, empty.sessionId)).toContain(RESTRICTED_STATUS);
    const task = h.brain.starts[0]!.task;
    expect(task).toMatchObject({ screenHelp: true, userTab: { url: "chrome://newtab/", title: "New Tab", access: "restricted" } });
    expect(buildTaskPrompt(task, [], { isRetry: false })).toMatch(/cannot see that page/);
  });

  it("a next turn whose tab now shows such a page gets the note too", async () => {
    const pages: Record<number, { url: string; title: string }> = { 7: { url: "https://site.test/", title: "Site" } };
    const { h, pool } = withChats(pages);
    pool.pick = (index, opts) => (opts.tabId === 7 && pages[7]!.url.startsWith("chrome") ? 50 : (opts.tabId ?? 100 + index));
    h.brain.script = () => ({ outcome: "done" });
    const r = await h.runner.message(null, "hello", { tabId: 7 });
    await h.runner.idle();
    pages[7] = { url: "chrome://settings/", title: "Settings" };
    h.brain.continueScript = () => ({ outcome: "done" });
    await h.runner.message(r.sessionId, "and now, what's on this page?", { tabId: 7 });
    await h.runner.idle();
    expect(withoutClock(h.brain.continues[0]!.text)).toBe(buildFollowUpMessage({ text: "and now, what's on this page?", userTab: { ...pages[7]!, access: "restricted" } }));
    expect(await statuses(h, r.sessionId)).toContain(RESTRICTED_STATUS);
    // The brain's echo of what it got is not shown twice; the user's words are.
    const users = (await h.sessions.eventsOf(r.sessionId)).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
  });
});
