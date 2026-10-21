/**
 * A chat hands-free voice opens where the tab has none (ticket 1bba1841: "why isn't it starting a new chat right
 * away?"): stored empty at once, so what is said shows in it; its first message starts its first turn in that chat,
 * keeping what was said before it.
 */
import { describe, expect, it } from "vitest";
import { OPENED_CHAT_TITLE } from "../../src/engine/runner.js";
import { harness, setupRunnerTests } from "./harness.js";

setupRunnerTests();

describe("Runner.openChat: a chat voice opens before anything is asked", () => {
  it("is stored empty at once; its first message starts its first turn in it, keeping what was said before", async () => {
    const h = harness();
    const opened = await h.runner.openChat({});
    expect(opened).toMatchObject({ source: "adhoc", title: OPENED_CHAT_TITLE, empty: true, voice: true });
    expect(await h.sessions.get(opened.sessionId)).toMatchObject({ empty: true });
    // Small talk before any request, kept in it as voice does.
    await h.sessions.note(opened.sessionId, { type: "heard", text: "Hi, can you hear me?" });
    await h.sessions.note(opened.sessionId, { type: "spoken", text: "I can hear you." });
    h.brain.script = (_o, ctl) => (ctl.resolve({ outcome: "done", summary: "Read it" }), "hang");
    const r = await h.runner.message(opened.sessionId, "What's on this page?", { voice: true, heard: ["What's on this page?"] });
    expect(r).toEqual({ sessionId: opened.sessionId, mode: "new" });
    await h.runner.idle();
    await h.sessions.flush();
    const s = (await h.sessions.get(opened.sessionId))!;
    expect(s.empty).toBeUndefined();
    expect(s).toMatchObject({ instructions: "What's on this page?", voice: true, heard: ["What's on this page?"], outcome: "done" });
    expect(h.brain.starts).toHaveLength(1);
    const events = await h.sessions.eventsOf(opened.sessionId);
    // What was said before the request is still there, first, and numbered before the turn's events.
    expect(events.slice(0, 2).map((e) => e.type)).toEqual(["heard", "spoken"]);
    expect(events.some((e) => e.type === "task_end")).toBe(true);
    // Not overwritten by the turn's events (they are numbered after them).
    expect(events.filter((e) => e.type === "heard" || e.type === "spoken").map((e) => (e as { text: string }).text)).toEqual(["Hi, can you hear me?", "I can hear you."]);
    expect(events[0]!.ts <= (s.firstStartedAt ?? s.startedAt)).toBe(true);
    // One conversation: no second chat was made for the request.
    expect((await h.sessions.list()).filter((x) => x.sessionId !== opened.sessionId)).toEqual([]);
  });

  it("a second message goes on as the chat's next turn, as in any chat", async () => {
    const h = harness();
    const opened = await h.runner.openChat({});
    h.brain.script = (_o, ctl) => (ctl.resolve({ outcome: "done", summary: "ok" }), "hang");
    await h.runner.message(opened.sessionId, "Open my inbox.", { voice: true });
    await h.runner.idle();
    expect(await h.runner.message(opened.sessionId, "Now the newest email.", { voice: true })).toEqual({ sessionId: opened.sessionId, mode: "turn" });
    await h.runner.idle();
    await h.sessions.flush();
    expect((await h.sessions.get(opened.sessionId))!.turns).toBe(2);
  });
});
