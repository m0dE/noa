import { describe, expect, it } from "vitest";
import type { StampedAgentEvent } from "@noa/shared";
import { ChatFollower } from "../../src/voice/chat-follower.js";

const T0 = Date.parse("2026-09-26T10:00:00Z");
const ev = (sessionId: string, atMs: number, text = "x"): StampedAgentEvent => ({ type: "assistant_text", text, ts: new Date(T0 + atMs).toISOString(), sessionId });

describe("ChatFollower: the chat a hands-free session narrates", () => {
  it("narrates the chat shown; other chats' events are not narrated", () => {
    let shown: string | null = "s1";
    const f = new ChatFollower(() => shown);
    f.start();
    expect(f.push(ev("s1", 0))).toHaveLength(1);
    expect(f.push(ev("s2", 10))).toEqual([]);
    shown = "s1";
    expect(f.refresh()).toEqual([]);
  });

  it("a new chat's first events that come before the panel knows its id are narrated once it does, in order", () => {
    let shown: string | null = null;
    const f = new ChatFollower(() => shown);
    f.start();
    f.sent(T0);
    // The background runs the new chat at once; its events arrive before run.adhoc's answer.
    const early = [ev("s-new", 50, "plan"), ev("s-new", 80, "step")];
    for (const e of early) expect(f.push(e)).toEqual([]);
    shown = "s-new";
    expect(f.refresh().map((e) => (e as { text: string }).text)).toEqual(["plan", "step"]);
    // Replayed once only.
    expect(f.refresh()).toEqual([]);
    expect(f.push(ev("s-new", 90, "later")).map((e) => (e as { text: string }).text)).toEqual(["later"]);
  });

  it("the change is also noticed with the next event, which comes after the kept ones", () => {
    let shown: string | null = null;
    const f = new ChatFollower(() => shown);
    f.start();
    f.sent(T0);
    f.push(ev("s-new", 10, "a"));
    shown = "s-new";
    expect(f.push(ev("s-new", 20, "b")).map((e) => (e as { text: string }).text)).toEqual(["a", "b"]);
  });

  it("switching to another chat does not replay its past (only events since the last message)", () => {
    let shown: string | null = "s1";
    const f = new ChatFollower(() => shown);
    f.start();
    f.push(ev("s2", -60_000, "old"));
    f.sent(T0);
    f.push(ev("s2", -5_000, "before the message"));
    f.push(ev("s2", 500, "after the message"));
    shown = "s2";
    expect(f.refresh().map((e) => (e as { text: string }).text)).toEqual(["after the message"]);
  });

  it("keeps a bounded number of events", () => {
    let shown: string | null = null;
    const f = new ChatFollower(() => shown);
    f.start();
    f.sent(T0);
    for (let i = 0; i < 500; i++) f.push(ev("s-new", i, String(i)));
    shown = "s-new";
    const replay = f.refresh();
    expect(replay).toHaveLength(200);
    expect((replay[0] as { text: string }).text).toBe("300");
  });
});
