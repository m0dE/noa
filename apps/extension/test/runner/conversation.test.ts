/** Runner conversations: messages, next turns (same or fresh agent session), Continue, New chat. */
import { describe, expect, it, vi } from "vitest";
import { localTimeZone, type AgentEvent } from "@noa/shared";
import type { AgentSession, ApiAgentOptions } from "@noa/core";
import { ApiBrain } from "../../src/engine/api-brain.js";
import { stopOf } from "../../src/engine/run/active.js";
import { CLAUDE_CODE_GONE } from "../../src/engine/brain-resolver.js";
import { CONTINUE_TEXT, FRESH_SESSION_STATUS } from "../../src/engine/run/conversation.js";
import { env, FakeBrain, harness, setupRunnerTests, status, withoutClock, WAITS, type Harness } from "./harness.js";

setupRunnerTests();

describe("Runner: conversations", () => {
  const POST = "Cats are the best coworkers: they nap through every meeting.";

  /** A turn that opens X, types the post, then waits until stopped. */
  function typeThenHang(opts: { onEvent(e: AgentEvent): void }): "hang" {
    opts.onEvent({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/home" } });
    opts.onEvent({ type: "tool_result", id: "1", name: "navigate", text: "Opened https://x.com/home\nmore lines" });
    opts.onEvent({ type: "tool_call", id: "2", name: "mcp__noa__type", args: { index: 12, text: POST } });
    opts.onEvent({ type: "tool_result", id: "2", name: "type", text: "typed 61 chars" });
    opts.onEvent({ type: "assistant_text", text: "The post is typed; now I'll press Post." });
    return "hang";
  }

  async function settle(h: Harness) {
    await h.runner.idle();
    await h.sessions.flush();
  }

  async function firstTurn(h: Harness, instructions = "Post on X from @alpha. Post: first turn") {
    h.brain.script = (o) => {
      o.onEvent({ type: "tool_call", id: "t1", name: "type", args: { index: 3, text: "first turn" } });
      return { outcome: "done", summary: "posted the first", url: "https://x.com/alpha/status/1" };
    };
    const { sessionId } = await h.runner.runAdhoc({ instructions, account: "@alpha" });
    await settle(h);
    return sessionId;
  }

  it("a message while the turn runs is typed into it", async () => {
    const h = harness();
    h.brain.script = () => "hang";
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Like the top post" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(await h.runner.message(sessionId, "  also retweet it ")).toEqual({ sessionId, mode: "inject" });
    expect(h.brain.ctls[0]!.said).toEqual(["also retweet it"]);
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await settle(h);
    const users = (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "user_message");
    expect(users.map((e) => (e as { text: string }).text)).toEqual(["also retweet it"]);
  });

  it("every turn is timed in the conversation's trace, apart from its events; a message's correlation id joins its turn", async () => {
    const h = harness();
    h.brain.script = (o) => {
      o.onEvent({ type: "trace", trace: { t: env.clock, ms: 1500, cat: "brain", name: "claude.ready", src: "helper" } });
      o.onEvent({ type: "tool_call", id: "t1", name: "read_page", args: {} });
      return { outcome: "done", summary: "read it" };
    };
    const { sessionId } = await h.runner.message(undefined, "Read the page", { cid: "c1" });
    await settle(h);
    env.clock += 60_000;
    h.brain.continueScript = (o) => {
      o.onEvent({ type: "user_message", text: o.text });
      o.onEvent({ type: "assistant_text", text: "Done." });
      return { outcome: "done" };
    };
    await h.runner.message(sessionId, "and again", { cid: "c2" });
    await settle(h);
    expect((await h.sessions.eventsOf(sessionId)).some((e) => (e.type as string) === "trace")).toBe(false);
    const book = (await h.sessions.traceOf(sessionId))!;
    const names = (turn: number) => book.events.filter((e) => e.turn === turn).map((e) => e.name);
    expect(names(1)).toEqual(expect.arrayContaining(["turn.start", "engine.tab", "brain.start", "claude.ready", "first.response", "brain.resolve", "turn.end"]));
    expect(names(2)).toEqual(expect.arrayContaining(["turn.start", "brain.start", "first.response", "brain.resolve", "turn.end"]));
    expect(book.cids).toEqual({ c1: 1, c2: 2 });
    expect(book.events.find((e) => e.name === "brain.resolve")!.data).toMatchObject({ brain: h.brain.kind });
    expect(book.turns.map((t) => t.outcome)).toEqual(["done", "done"]);
  });

  it("no conversation: a message starts a new one-off conversation", async () => {
    const h = harness();
    const r = await h.runner.message(undefined, " Post gm ");
    expect(r.mode).toBe("new");
    await settle(h);
    expect(h.brain.starts[0]!.task.instructions).toBe("Post gm");
    await expect(h.runner.message("x", "  ")).rejects.toThrow(/empty/);
  });

  it("after a turn, the next message continues the same agent session: one session, one thread", async () => {
    const h = harness();
    const sessionId = await firstTurn(h);
    expect(h.brain.isOpen(sessionId)).toBe(true);
    env.clock += 60_000;
    h.brain.continueScript = (o) => {
      o.onEvent({ type: "user_message", text: o.text }); // the helper echoes the message
      o.onEvent({ type: "assistant_text", text: "Posting the second one." });
      o.onEvent({ type: "tool_call", id: "t2", name: "type", args: { index: 3, text: "second turn" } });
      return { outcome: "done", summary: "posted the second", url: "https://x.com/alpha/status/2", logPath: "C:\\runs\\s1\\log.jsonl" };
    };
    expect(await h.runner.message(sessionId, "Now also post from @alpha: second turn")).toEqual({ sessionId, mode: "turn" });
    await settle(h);

    expect(h.brain.starts).toHaveLength(1);
    // Each follow-up starts with the user's date and time in the browser's zone (schedule_task's relative times).
    expect(h.brain.continues[0]!.text).toMatch(new RegExp(`^The user's time: .* in ${localTimeZone().replace("/", "\\/")} \\(UTC[+-]\\d\\d:\\d\\d\\)\\.\n\n`));
    expect(h.brain.continues.map((c) => ({ ...c, text: withoutClock(c.text) }))).toEqual([
      expect.objectContaining({ sessionId, text: "Now also post from @alpha: second turn", config: expect.objectContaining({ isRetry: false, maxToolCalls: 60 }) }),
    ]);
    // The conversation keeps acting in its tab, which is never brought to the front.
    expect(h.prepared).toEqual([{ mode: "current-tab" }, { mode: "own-tab" }]);
    const events = await h.sessions.eventsOf(sessionId);
    const types = events.map((e) => e.type);
    const second = types.indexOf("user_message");
    expect(types.slice(0, second).at(-1)).toBe("task_end");
    expect(events.slice(second).map((e) => (e.type === "status" || e.type === "user_message" || e.type === "assistant_text" ? `${e.type}: ${e.text}` : e.type))).toEqual([
      "user_message: Now also post from @alpha: second turn",
      "status: Continuing the same Claude API conversation",
      "assistant_text: Posting the second one.",
      "tool_call",
      "status: Verifying the post",
      "status: Post verified",
      "task_end",
    ]);
    // The second post is verified against what the second turn typed.
    expect(h.verify).toHaveBeenLastCalledWith(h.browser, "https://x.com/alpha/status/2", "second turn", "@alpha", WAITS);
    const s = (await h.sessions.get(sessionId))!;
    expect(s).toMatchObject({ outcome: "done", summary: "posted the second", url: "https://x.com/alpha/status/2", turns: 2, logPath: "C:\\runs\\s1\\log.jsonl", model: "claude-sonnet-5" });
    expect(s.startedAt).toBe(new Date(env.clock).toISOString());
    expect(s.firstStartedAt).toBe(new Date(env.clock - 60_000).toISOString());
    expect(await h.sessions.list()).toHaveLength(1);
  });

  it("spoken messages are marked in the thread: the first one on the session, the next ones on their user_message", async () => {
    const h = harness();
    h.brain.script = () => "hang";
    const { sessionId } = await h.runner.message(undefined, "Read my newest email", { voice: true });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect((await h.sessions.get(sessionId))?.voice).toBe(true);
    // Said into the running turn, then typed.
    await h.runner.message(sessionId, "and reply to it", { voice: true });
    await h.runner.message(sessionId, "politely");
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await settle(h);
    h.brain.continueScript = () => ({ outcome: "done" });
    // The next turn, spoken.
    await h.runner.message(sessionId, "thanks, now archive it", { voice: true });
    await settle(h);
    const users = (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "user_message");
    expect(users.map((e) => [(e as { text: string }).text, (e as { voice?: true }).voice ?? false])).toEqual([
      ["and reply to it", true],
      ["politely", false],
      ["thanks, now archive it", true],
    ]);
    // A typed conversation is not marked.
    h.brain.script = () => ({ outcome: "done" });
    const typed = await h.runner.message(undefined, "Post gm");
    await settle(h);
    expect((await h.sessions.get(typed.sessionId))?.voice).toBeUndefined();
  });

  it("a spoken message's words, word for word, go with it: on the session for the first, on the user_message after (never to the agent)", async () => {
    const h = harness();
    h.brain.script = () => "hang";
    const { sessionId } = await h.runner.message(undefined, "Read my newest email", { voice: true, heard: ["uh, read my", "newest email"] });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect((await h.sessions.get(sessionId))?.heard).toEqual(["uh, read my", "newest email"]);
    // Into the running turn.
    await h.runner.message(sessionId, "and reply to it", { voice: true, heard: ["and, um, reply"] });
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await settle(h);
    h.brain.continueScript = () => ({ outcome: "done" });
    // The next turn.
    await h.runner.message(sessionId, "thanks, now archive it", { voice: true, heard: ["thanks", "now archive it"] });
    await settle(h);
    const users = (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "user_message");
    expect(users.map((e) => (e as { heard?: string[] }).heard)).toEqual([["and, um, reply"], ["thanks", "now archive it"]]);
    // The agent gets the requests only.
    expect(JSON.stringify(h.brain.starts)).not.toContain("uh, read my");
  });

  it("the turn's follow-up suggestion is kept with the session (a reopened panel offers it) until the next message", async () => {
    const h = harness();
    const suggestion = "Reply to Jordan and say I'll sign by Thursday";
    h.brain.script = () => ({ outcome: "done", summary: "Checked email", suggestion });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "check my email" });
    await settle(h);
    // Stored with the session, where a (re)opened panel reads it (sessions.events).
    expect(await h.sessions.get(sessionId)).toMatchObject({ outcome: "done", suggestion });
    expect((await h.sessions.eventsOf(sessionId)).at(-1)).toMatchObject({ type: "task_end", outcome: "done", suggestion });
    // The next message starts a turn: the suggestion is gone, and a turn without one leaves none.
    h.brain.continueScript = () => ({ outcome: "done", summary: "Replied" });
    await h.runner.message(sessionId, suggestion);
    expect((await h.sessions.get(sessionId))!.suggestion).toBeUndefined();
    await settle(h);
    expect(await h.sessions.get(sessionId)).toMatchObject({ outcome: "done", summary: "Replied" });
    expect((await h.sessions.get(sessionId))!.suggestion).toBeUndefined();
  });

  it("a post that is not verified drops the follow-up suggestion (it assumed the post went out)", async () => {
    const h = harness();
    h.verify.mockResolvedValue({ ok: false, detail: "no such post" });
    h.brain.script = () => ({ outcome: "done", summary: "posted", url: "https://x.com/alpha/status/9", suggestion: "Pin the post", spoken: "Posted it." });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Post gm" });
    await settle(h);
    const s = (await h.sessions.get(sessionId))!;
    expect(s.outcome).toBe("retry");
    expect(s.suggestion).toBeUndefined();
    // Nor is the spoken line said: it claims the post went out.
    expect((await h.sessions.eventsOf(sessionId)).at(-1)).not.toHaveProperty("spoken");
  });

  it("the turn's spoken line goes with its task_end event (hands-free voice reads it aloud)", async () => {
    const h = harness();
    h.brain.script = () => ({ outcome: "done", summary: "Checked email", spoken: "You have two new emails." });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "check my email" });
    await settle(h);
    expect((await h.sessions.eventsOf(sessionId)).at(-1)).toMatchObject({ type: "task_end", outcome: "done", spoken: "You have two new emails." });
  });

  it("the agent's own pause reason is marked as its words on the task_end (never read as one of Noa's errors)", async () => {
    const h = harness();
    const reason = "@rooftopchat is not signed in on this browser's X account menu, so switch_x_account cannot switch to it.";
    h.brain.script = () => ({ outcome: "paused", reason, byAgent: true });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Post on X as @rooftopchat" });
    await settle(h);
    expect((await h.sessions.eventsOf(sessionId)).at(-1)).toMatchObject({ type: "task_end", outcome: "paused", reason, byAgent: true });
  });

  it("a reason the runner puts in place of the agent's is not marked as the agent's (Stop)", async () => {
    const h = harness();
    h.brain.script = () => "hang";
    h.brain.onAbort = () => ({ outcome: "paused", reason: "I'll ask the user", byAgent: true });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "check my email" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    h.runner.stop();
    await settle(h);
    const end = (await h.sessions.eventsOf(sessionId)).at(-1)!;
    expect(end).toMatchObject({ type: "task_end", outcome: "paused", reason: stopOf("user-stop").reason });
    expect(end).not.toHaveProperty("byAgent");
  });

  it("falls back to a fresh session with a summary when the agent session is gone", async () => {
    const h = harness();
    const sessionId = await firstTurn(h);
    h.brain.open.clear(); // e.g. the idle timeout closed it
    h.brain.script = () => ({ outcome: "done", summary: "second done" });
    await h.runner.message(sessionId, "Now also like the newest reply");
    await settle(h);
    expect(h.brain.continues).toEqual([]);
    const start = h.brain.starts[1]!;
    expect(start.sessionId).toBe(sessionId);
    expect(start.task).toMatchObject({ id: sessionId, account: "@alpha" });
    const text = start.task.instructions;
    expect(text).toContain("Continuing a conversation");
    expect(text).toContain("Post on X from @alpha. Post: first turn");
    expect(text).toContain('- type #3 "first turn"');
    expect(text).toContain("The last request finished: posted the first (https://x.com/alpha/status/1)");
    expect(text).toMatch(/The user's new message, which is what to do now:\n<<<\nNow also like the newest reply\n>>>/);
    // It finished last time: nothing to double-check.
    expect(start.config.isRetry).toBe(false);
    const events = await h.sessions.eventsOf(sessionId);
    expect(events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text)).toContain(FRESH_SESSION_STATUS);
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(await h.sessions.get(sessionId)).toMatchObject({ outcome: "done", summary: "second done", turns: 2 });
  });

  it("falls back when the brain says the session ended", async () => {
    const h = harness();
    const sessionId = await firstTurn(h);
    h.brain.continueScript = () => "ended";
    h.brain.script = () => ({ outcome: "done" });
    await h.runner.message(sessionId, "again");
    await settle(h);
    expect(h.brain.continues).toHaveLength(1);
    expect(h.brain.starts).toHaveLength(2);
    const statuses = (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
    expect(statuses).toEqual(expect.arrayContaining(["Continuing the same Claude API conversation", FRESH_SESSION_STATUS]));
  });

  it("Stop pauses the turn; the next message continues it, and the stopped post is still verified", async () => {
    const h = harness();
    h.brain = new FakeBrain("claude-code");
    h.brain.script = typeThenHang;
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Make a post on X about cats", account: "@me" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    h.runner.stop();
    await settle(h);
    expect(await h.sessions.get(sessionId)).toMatchObject({ outcome: "paused", reason: stopOf("user-stop").reason });
    // Stopping Claude Code ends its session: the fallback continues.
    expect(h.brain.isOpen(sessionId)).toBe(false);

    h.brain.script = () => ({ outcome: "done", summary: "posted", url: "https://x.com/me/status/123" });
    await h.runner.message(sessionId, "just press Post");
    await settle(h);
    const start = h.brain.starts[1]!;
    expect(start.task.instructions).toContain(`stopped before it finished (reason: ${stopOf("user-stop").reason})`);
    expect(start.task.instructions).toContain(`- type #12 "${POST}" → typed 61 chars`);
    expect(start.config.isRetry).toBe(true);
    expect(h.verify).toHaveBeenCalledWith(expect.anything(), "https://x.com/me/status/123", POST, "@me", WAITS);
    expect(await h.sessions.get(sessionId)).toMatchObject({ outcome: "done", turns: 2, brain: "claude-code" });
  });

  it("a local task's unfinished work is recorded on the task; after it is done, the conversation leaves it alone", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "Post hello", media: [{ name: "a.png", type: "image/png", dataBase64: btoa("A") }] });
    h.brain.script = typeThenHang;
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    h.runner.stop();
    await settle(h);
    const [s] = await h.sessions.list();
    expect(await h.store.get(t.id)).toMatchObject({ status: "paused", attempts: 1 });
    h.brain.open.clear();

    h.brain.script = async (o) => {
      expect(await h.store.get(t.id)).toMatchObject({ status: "running", attempts: 2 });
      expect(o.task.id).toBe(t.id);
      expect(o.mediaPaths).toEqual(["C:\\dl\\a.png"]);
      return { outcome: "done", summary: "posted" };
    };
    await h.runner.message(s!.sessionId, "go on");
    await settle(h);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2, resultSummary: "posted" });

    // Done: a follow-up does not touch the task (a failure would not reschedule it).
    h.brain.continueScript = () => ({ outcome: "failed", reason: "button not found" });
    await h.runner.message(s!.sessionId, "now like it too");
    await settle(h);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2 });
    expect(await h.sessions.get(s!.sessionId)).toMatchObject({ outcome: "failed", turns: 3 });
  });

  it("new chat ends the agent session, but not a running turn", async () => {
    const h = harness();
    const sessionId = await firstTurn(h);
    expect(await h.runner.newChat(sessionId)).toEqual({ ok: true });
    expect(h.brain.ended).toEqual([sessionId]);
    expect(await h.runner.newChat("nope")).toEqual({ ok: false });
    h.brain.script = () => "hang";
    const live = await h.runner.runAdhoc({ instructions: "y" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(2));
    expect(await h.runner.newChat(live.sessionId)).toEqual({ ok: true });
    expect(h.brain.ended).toEqual([sessionId]);
    h.runner.stop();
    await settle(h);
  });

  it("a task that runs, first turn or next, is never recovered as crashed however long it takes", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "slow work" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    env.clock += 60 * 60_000;
    expect(await h.runner.recover()).toBe(0);
    expect((await h.store.get(t.id))?.status).toBe("running");
    h.runner.stop();
    await settle(h);

    // Continue: the next turn runs the same local task.
    h.brain.continueScript = () => "hang";
    await h.runner.continueSession(h.brain.starts[0]!.sessionId);
    await vi.waitFor(() => expect(h.brain.continues).toHaveLength(1));
    expect((await h.store.get(t.id))?.status).toBe("running");
    env.clock += 60 * 60_000;
    expect(await h.runner.recover()).toBe(0);
    expect((await h.store.get(t.id))?.status).toBe("running");
    h.runner.stop();
    await settle(h);
    expect((await h.store.get(t.id))?.status).toBe("paused");
  });

  it("Continue (a stopped run) is the next turn with the note, or a default text; it refuses what cannot continue", async () => {
    const h = harness();
    h.brain.script = typeThenHang;
    const { sessionId } = await h.runner.runAdhoc({ instructions: "x" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    h.runner.stop();
    await settle(h);
    h.brain.open.add(sessionId); // e.g. the Claude API history survived the stop
    h.brain.continueScript = () => ({ outcome: "paused", reason: "needs a code" });
    expect(await h.runner.continueSession(sessionId)).toEqual({ sessionId });
    await settle(h);
    expect(withoutClock(h.brain.continues[0]!.text)).toBe(CONTINUE_TEXT);
    h.brain.continueScript = () => ({ outcome: "done" });
    await h.runner.continueSession(sessionId, "  the code is 1234 ");
    await settle(h);
    expect(withoutClock(h.brain.continues[1]!.text)).toBe("the code is 1234");
    await expect(h.runner.continueSession(sessionId)).rejects.toThrow(/already finished/);
    await expect(h.runner.continueSession("nope")).rejects.toThrow(/No session nope/);
    await h.sessions.create({ sessionId: "c1", source: "cloud", taskId: "ct", title: "cloud", brain: "claude-api", jev: false, startedAt: "x", endedAt: "y", outcome: "paused" });
    await expect(h.runner.continueSession("c1")).rejects.toThrow("Cloud tasks continue from the queue; use Retry on the server");
    await h.sessions.create({ sessionId: "r1", source: "adhoc", title: "r", brain: "claude-api", jev: false, startedAt: "x" });
    await expect(h.runner.continueSession("r1")).rejects.toThrow(/not ended/);
    h.brain.script = () => "hang";
    const live = await h.runner.runAdhoc({ instructions: "y" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(2));
    await expect(h.runner.continueSession(live.sessionId)).rejects.toThrow(/already running/);
    // Another conversation cannot start a turn while one runs.
    await expect(h.runner.message(sessionId, "more")).rejects.toThrow(/already running/);
    h.runner.stop();
    await settle(h);
  });

  it("Claude API brain: the next message continues the in-memory history; after a restart, the summary path", async () => {
    const h = harness();
    const calls: string[] = [];
    const makeCore = () => ({
      createJev: vi.fn(),
      startApiAgent: vi.fn((o: ApiAgentOptions) => {
        calls.push(`start ${o.task.instructions.split("\n")[0]}`);
        const agent = (label: string): AgentSession => ({
          sessionId: o.sessionId,
          sendUserMessage: vi.fn(),
          abort: vi.fn(),
          done: Promise.resolve({ outcome: "done", summary: label }),
          continueWith: (text) => {
            calls.push(`continueWith ${withoutClock(text)}`);
            o.onEvent({ type: "user_message", text });
            return agent(`after ${withoutClock(text)}`);
          },
        });
        return agent("first");
      }),
    });
    let api = new ApiBrain({ core: makeCore(), browser: { call: vi.fn() as never } });
    h.deps.resolveBrain = async () => ({ brain: api, status: status("claude-api") });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Find the cheapest flight" });
    await settle(h);
    await h.runner.message(sessionId, "and the return one");
    await settle(h);
    expect(calls).toEqual(["start Find the cheapest flight", "continueWith and the return one"]);
    expect(await h.sessions.get(sessionId)).toMatchObject({ summary: "after and the return one", turns: 2 });
    // A service worker restart: the history is gone.
    api = new ApiBrain({ core: makeCore(), browser: { call: vi.fn() as never } });
    await h.runner.message(sessionId, "book it");
    await settle(h);
    expect(calls.at(-1)).toBe("start --- Continuing a conversation ---");
    const users = (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text);
    expect(users).toEqual(["and the return one", "book it"]);
  });

  it("Auto: a Claude Code chat whose helper went away is not moved to the paid hosted AI; a chosen brain or a new chat is", async () => {
    const h = harness();
    h.brain = new FakeBrain("claude-code");
    const sessionId = await firstTurn(h);
    const hosted = new FakeBrain("noa");
    h.deps.resolveBrain = async () => ({ brain: hosted, status: status("noa") });
    await expect(h.runner.message(sessionId, "and reply to the first comment")).rejects.toThrow(CLAUDE_CODE_GONE);
    expect(hosted.starts).toHaveLength(0);
    // A new chat resolves as usual.
    await h.runner.runAdhoc({ instructions: "Summarize my inbox" });
    await settle(h);
    expect(hosted.starts).toHaveLength(1);
    // Chosen by the user: theirs to pay for.
    h.settings = { ...h.settings, brain: "noa" };
    await h.runner.message(sessionId, "and reply to the first comment");
    await settle(h);
    expect(hosted.starts).toHaveLength(2);
  });
});
