import { describe, expect, it } from "vitest";
import { isApprovalRefusal, type ApprovalRequest, type BrowserMethod, type PageSnapshot, type TraceEvent } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import { ApprovalGate, type GateDeps } from "../../src/approval/gate.js";
import { Preapprovals } from "../../src/approval/paused.js";
import { el } from "./cases.js";

const editor = el("textbox", "Post text", { tag: "div", testId: "tweetTextarea_0", index: 7 });
const postBtn = el("button", "Post", { testId: "tweetButtonInline", index: 8 });
const PAGE: PageSnapshot = { url: "https://x.com/home", title: "Home / X", text: "What is happening?!", elements: [editor, postBtn], truncated: false };

/** A run that goes on after Allow & continue: the gate with the card's action allowed ahead for task t1. */
function setup(stopped = false) {
  const ran: BrowserMethod[] = [];
  const browser: BrowserCaller = {
    call: async (method) => {
      ran.push(method);
      return (method === "browser.readPage" ? PAGE : { ok: true }) as never;
    },
  };
  const asked: Omit<ApprovalRequest, "id" | "expiresAt">[] = [];
  const traced: TraceEvent[] = [];
  const pre = new Preapprovals();
  const deps: GateDeps = {
    context: async () => ({ level: "ask_consequential", attended: true, stopped: () => stopped }),
    request: async (_s, ask) => {
      asked.push(ask);
      return "deny";
    },
    preapproved: (sessionId, ask) => pre.take([sessionId, "t1"], ask),
    trace: (_s, row) => void traced.push(row),
  };
  const gate = new ApprovalGate(browser, () => "s-new", deps);
  return { call: gate.browser.call, ran, asked, traced, pre };
}

const post = async (call: BrowserCaller["call"], text: string) => {
  await call("browser.readPage", {});
  await call("browser.type", { index: 7, text });
  await call("browser.click", { index: 8 });
};

describe("the gate with an action allowed ahead (Allow & continue on a paused card)", () => {
  it("the same action runs without a card, once; the next one asks again", async () => {
    const t = setup();
    t.pre.grant(["s-old", "t1"], { action: 'Click "Post"', site: "x.com", kind: "publish", text: "Shipped: run history" });
    await post(t.call, "Shipped: run history");
    expect(t.asked).toEqual([]);
    expect(t.ran).toEqual(["browser.readPage", "browser.type", "browser.click"]);
    expect(t.traced.map((r) => r.name)).toContain("approval.preapproved");
    await expect(post(t.call, "Shipped: run history")).rejects.toThrow(/did not approve/);
    expect(t.asked).toHaveLength(1);
  });

  it("another text, or another button, asks as before", async () => {
    const t = setup();
    t.pre.grant(["t1"], { action: 'Click "Post"', site: "x.com", kind: "publish", text: "Shipped: run history" });
    const err = await post(t.call, "Something else").catch((e: Error) => e);
    expect(err instanceof Error && isApprovalRefusal(err.message)).toBe(true);
    expect(t.asked.map((a) => a.text)).toEqual(["Something else"]);
  });

  it("a stopped run does not act, allowed or not", async () => {
    const t = setup(true);
    t.pre.grant(["t1"], { action: 'Click "Post"', site: "x.com", kind: "publish", text: "Shipped: run history" });
    await expect(t.call("browser.click", { index: 8 })).rejects.toThrow();
    expect(t.ran).toEqual([]);
  });
});
