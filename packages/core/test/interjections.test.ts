import { describe, expect, it, vi } from "vitest";
import type { TaskRunResult } from "@noa/shared";
import { createToolExecutor, interjectionText, Interjections, type InterjectionRoute } from "../src/index.js";
import { PAGE_STILL_LOADING, READ_STILL_LOADING, TABS_STILL_LOADING } from "../src/executor.js";
import type { BrowserCaller } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { collect, noSleep } from "./helpers.js";

describe("Interjections", () => {
  it("frames what the user said as overriding the task, in order, and hands each message over once", () => {
    const routes: [InterjectionRoute, number][] = [];
    const i = new Interjections((route, _ms, count) => routes.push([route, count]));
    expect(i.unseen).toBe(false);
    expect(i.take("request")).toBeNull();
    i.add("no, use page B");
    i.add("  ");
    i.add("and hurry");
    expect(i.unseen).toBe(true);
    expect(i.take("request")).toBe('The user just said: "no, use page B", then: "and hurry". Act on it now: a question or remark, answer it with answer_user (at once when you know the answer, else right after the step that finds it out) and go on with the task; otherwise it changes the current task (keep doing what it does not change), or replaces or stops it if that is what it says.');
    expect(i.unseen).toBe(false);
    expect(i.take("request")).toBeNull();
    expect(routes).toEqual([["request", 2]]);
  });

  it("a message handed off to one of its own stays unseen until the model read it, and is traced then", () => {
    const routes: InterjectionRoute[] = [];
    const i = new Interjections((route) => routes.push(route));
    const added: string[] = [];
    i.onAdd((t) => added.push(t));
    i.add("stop");
    expect(added).toEqual(["stop"]);
    const text = i.handOff("next_step")!;
    expect(text).toBe(interjectionText(["stop"]));
    expect(i.unseen).toBe(true);
    expect(i.unread).toBe(true);
    i.reroute("interrupt");
    i.seen("something else");
    expect(i.unseen).toBe(true);
    expect(routes).toEqual([]);
    i.seen(text);
    expect(i.unseen).toBe(false);
    expect(routes).toEqual(["interrupt"]);
  });
});

describe("the tool executor with interjections", () => {
  function setup(browser?: BrowserCaller) {
    const x = new FakeX({ url: "https://mail.test/u/0" });
    const interjections = new Interjections();
    const ended: TaskRunResult[] = [];
    const { events, onEvent } = collect();
    const exec = createToolExecutor({ browser: browser ?? x.caller(), jev: null, jevThreshold: 0.8, onEvent, onTaskEnd: (r) => void ended.push(r), mediaPaths: [], sleep: noSleep, interjections });
    return { exec, interjections, ended, events };
  }

  /** A browser whose page loads (navigate, openTabs, and readPage when `slowRead`) finish only when the test says; other calls answer at once. */
  function slowLoads(slowRead = false) {
    const loads: { method: string; finish: (r: unknown) => void }[] = [];
    const slow = new Set(["browser.navigate", "browser.openTabs", ...(slowRead ? ["browser.readPage"] : [])]);
    const browser: BrowserCaller = {
      call: (async (method: string, params: unknown) => {
        if (slow.has(method)) return new Promise<unknown>((finish) => loads.push({ method, finish }));
        return new FakeX().caller().call(method as never, params as never);
      }) as BrowserCaller["call"],
    };
    return { browser, loads };
  }

  it("answer_user answers only a message the model got in this turn: refused before any event otherwise, and again once a new turn starts", async () => {
    const { exec, interjections, events } = setup();
    const refused = await exec.call("answer_user", { text: "Yes, I can." });
    expect(refused).toEqual({ text: expect.stringContaining("only for a message the user sent while you work"), isError: true });
    expect(events).toEqual([]);
    interjections.add("can you speak Korean?");
    interjections.take("request");
    expect(await exec.call("answer_user", { text: "Yes, I can." })).toEqual({ text: expect.stringContaining("The user has your answer") });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    interjections.newTurn();
    expect((await exec.call("answer_user", { text: "Yes, I can." })).isError).toBe(true);
    // Handed off to Claude Code: answerable once it read the message, not before.
    interjections.add("which account?");
    interjections.handOff("next_step");
    expect((await exec.call("answer_user", { text: "@acme." })).isError).toBe(true);
    interjections.seen(interjectionText(["which account?"]));
    expect((await exec.call("answer_user", { text: "@acme." })).isError).toBeUndefined();
  });

  it("navigate stops waiting for a slow page the moment the user speaks: the load goes on, the result says so", async () => {
    const { browser, loads } = slowLoads();
    const { exec, interjections, events } = setup(browser);
    const call = exec.call("navigate", { url: "https://slow.test/a" });
    await vi.waitFor(() => expect(loads).toHaveLength(1));
    interjections.add("skip that page");
    const r = await call;
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe(PAGE_STILL_LOADING("https://slow.test/a"));
    // The message itself is never in a tool result.
    expect(r.text).not.toContain("skip that page");
    // The load finishing later changes nothing.
    loads[0]!.finish({ url: "https://slow.test/a", title: "A" });
    await new Promise((r) => setTimeout(r, 0));
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });

  it("a message already waiting when a page load starts: the page is opened, not waited for; open_tabs likewise", async () => {
    const { browser, loads } = slowLoads();
    const { exec, interjections } = setup(browser);
    interjections.add("also check page B");
    expect((await exec.call("navigate", { url: "https://slow.test/a" })).text).toBe(PAGE_STILL_LOADING("https://slow.test/a"));
    expect((await exec.call("open_tabs", { urls: ["https://slow.test/b", "https://slow.test/c"] })).text).toBe(TABS_STILL_LOADING(2));
    expect(loads.map((l) => l.method)).toEqual(["browser.navigate", "browser.openTabs"]);
  });

  it("read_page of a page still loading stops waiting when the user speaks; a message already waiting does not stop it", async () => {
    const { browser, loads } = slowLoads(true);
    const { exec, interjections } = setup(browser);
    const read = exec.call("read_page", {});
    await vi.waitFor(() => expect(loads).toHaveLength(1));
    interjections.add("never mind that page");
    expect(await read).toEqual({ text: READ_STILL_LOADING });
    // The message is still unread: the next read is not cut short for it (it is read right after anyway).
    const next = exec.call("read_page", {});
    await vi.waitFor(() => expect(loads).toHaveLength(2));
    loads[1]!.finish(new FakeX({ url: "https://mail.test/u/1" }).snapshot());
    expect((await next).text).toContain("URL: https://mail.test/u/1");
  });

  it("a message the brain reads the moment it comes does not stop the wait", async () => {
    const { browser, loads } = slowLoads(true);
    const { exec, interjections } = setup(browser);
    // Like the scripted brain: it takes each message as it is added.
    interjections.onAdd(() => interjections.seen(interjections.handOff("next_step") ?? ""));
    const read = exec.call("read_page", {});
    await vi.waitFor(() => expect(loads).toHaveLength(1));
    interjections.add("hurry");
    loads[0]!.finish(new FakeX({ url: "https://mail.test/u/1" }).snapshot());
    expect((await read).text).toContain("URL: https://mail.test/u/1");
  });

  it("without a message, navigate waits for the page as always", async () => {
    const { browser, loads } = slowLoads();
    const { exec } = setup(browser);
    const call = exec.call("navigate", { url: "https://slow.test/a" });
    await vi.waitFor(() => expect(loads).toHaveLength(1));
    loads[0]!.finish({ url: "https://slow.test/a", title: "A" });
    expect((await call).text).toBe("Navigated to https://slow.test/a\nTitle: A");
  });

  it("never puts the message in a tool result (the model treats those as page content)", async () => {
    const { exec, interjections } = setup();
    interjections.add("use page B");
    const shot = await exec.call("screenshot", {});
    expect(shot.text).toBeUndefined();
    expect((await exec.call("list_tabs", {})).text).not.toContain("use page B");
    expect(interjections.unseen).toBe(true);
  });

  it("refuses task_* while a message is unread, and records the call once it was read", async () => {
    const { exec, interjections, ended } = setup();
    interjections.add("no, use page B");
    const refused = await exec.call("task_complete", { summary: "Summarised page A" });
    expect(refused).toEqual({ isError: true, text: "Not recorded: the user sent you a new message, so task_complete was not called. Read that message (it follows) and do what it asks before ending." });
    expect(ended).toEqual([]);
    interjections.take("request");
    expect(await exec.call("task_complete", { summary: "Summarised page B" })).toEqual({ text: "Task recorded as done. Stop now." });
    expect(ended).toEqual([{ outcome: "done", summary: "Summarised page B" }]);
  });

  it("refuses task_* while a handed-off message has not reached the model yet", async () => {
    const { exec, interjections, ended } = setup();
    interjections.add("stop");
    const text = interjections.handOff("next_step")!;
    expect((await exec.call("task_fail", { reason: "old goal" })).isError).toBe(true);
    interjections.seen(text);
    expect((await exec.call("task_fail", { reason: "stopped as asked" })).isError).toBeUndefined();
    expect(ended).toEqual([{ outcome: "failed", reason: "stopped as asked", byAgent: true }]);
  });
});
