import { beforeEach, describe, expect, it } from "vitest";
import { memoryTaskKey, USER_STOP_REASON, type AgentEvent, type ExtensionSettings, type MemoryKind, type SessionInfo } from "@noa/shared";
import { SessionStore } from "../../src/engine/sessions.js";
import {
  BACKFILL_DAYS,
  BACKFILL_GAP_MS,
  EPISODE_IDLE_MS,
  EPISODE_QUEUE_KEY,
  EPISODE_RETRY_MS,
  EPISODE_TASK_DELAY_MS,
  EpisodeWriter,
  MAX_BACKFILL_SESSIONS,
  MAX_EPISODE_ATTEMPTS,
  episodeTrigger,
  transcriptLines,
} from "../../src/memory/episodes.js";
import { MemoryService } from "../../src/memory/service.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { Summarize } from "../../src/memory/summarizers.js";
import { MemoryKvDb } from "../memory-kv.js";
import { memoryStorage } from "./fakes.js";

const START = Date.parse("2026-09-26T10:00:00.000Z");
const DAILY = { instructions: "Post one tip about Mecha Royale on X\nKeep it short", account: "@mecharoyalecom" };
const LONG_REPLY = "I opened the bookings page on app.channex.io, found booking HM4K2ZQ9 for Paul Lee, and confirmed the arrival time of 3pm with the guest.";

let clock: number;
let settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">;
let sessions: SessionStore;
let store: MemoryStore;
let memory: MemoryService;
let writer: EpisodeWriter;
let storage: ReturnType<typeof memoryStorage>;
let alarm: number | null;
let answers: (string | Error)[];
let prompts: { system: string; prompt: string; sessionId: string }[];
let logs: string[];
let brainsWithWriter: SessionInfo["brain"][];

const iso = () => new Date(clock).toISOString();
const answer = (a: unknown) => answers.push(JSON.stringify(a));
const EPISODE = { subject: "Confirmed booking HM4K2ZQ9", text: "The user asked to confirm Paul Lee's booking; the agent confirmed a 3pm arrival.", entities: ["https://app.channex.io/bookings", "Paul Lee"] };

beforeEach(() => {
  clock = START;
  settings = { memoryPaused: false, memoryKindsOff: [] as MemoryKind[] };
  sessions = new SessionStore(new MemoryKvDb(), { now: () => new Date(clock) });
  let ids = 0;
  store = new MemoryStore({ storage: memoryStorage(), now: () => new Date(clock), newId: () => `m${++ids}` });
  let changes = 0;
  memory = new MemoryService({ store, sessions, settings: async () => settings, newChangeId: () => `u${++changes}` });
  storage = memoryStorage();
  alarm = null;
  answers = [];
  prompts = [];
  logs = [];
  brainsWithWriter = ["claude-api", "noa", "claude-code"];
  const summarize: Summarize = async (req) => {
    prompts.push(req);
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    return { text: next, costUsd: 0.001 };
  };
  let auto = 0;
  writer = new EpisodeWriter({
    store,
    sessions,
    settings: async () => settings,
    summarizer: (brain) => (brainsWithWriter.includes(brain) ? summarize : null),
    alarms: { set: async (when) => void (alarm = when), clear: async () => void (alarm = null) },
    storage,
    now: () => clock,
    newChangeId: () => `a${++auto}`,
    log: (m) => logs.push(m),
  });
});

/** A finished conversation: its session, its events, and its end. */
async function conversation(id: string, extra: Partial<SessionInfo> = {}, events: AgentEvent[] = chatEvents()): Promise<void> {
  await sessions.create({ sessionId: id, source: "adhoc", title: "Confirm the booking", instructions: "Confirm Paul Lee's booking on channex", brain: "claude-api", jev: false, startedAt: iso(), ...extra });
  for (const e of events) sessions.append(id, e);
  await sessions.update(id, { endedAt: iso(), outcome: "done" });
  await sessions.flush();
}

function chatEvents(): AgentEvent[] {
  return [
    { type: "tool_call", id: "t1", name: "navigate", args: { url: "https://app.channex.io/bookings" } },
    { type: "tool_result", id: "t1", name: "navigate", text: "ok" },
    { type: "assistant_text", text: LONG_REPLY },
    { type: "task_end", outcome: "done", summary: "Confirmed" },
  ];
}

/** Moves the clock past what is due and runs the alarm's pass. */
async function fireAlarm(): Promise<void> {
  expect(alarm).not.toBeNull();
  clock = Math.max(clock, alarm!);
  await writer.runDue();
  await sessions.flush();
}

const queue = () => (storage.data[EPISODE_QUEUE_KEY] as { queue: { sessionId: string; dueAt: number; attempts: number }[] } | undefined)?.queue ?? [];
const eventsOf = async (id: string) => {
  await sessions.flush();
  return sessions.eventsOf(id);
};

describe("when the writer runs", () => {
  it("a chat waits until it has been idle; a new turn pushes it back; the alarm is cleared when done", async () => {
    await conversation("chat");
    await writer.ended("chat", { soon: false });
    expect(alarm).toBe(START + EPISODE_IDLE_MS);
    clock += EPISODE_IDLE_MS / 2;
    await writer.ended("chat", { soon: false });
    expect(alarm).toBe(clock + EPISODE_IDLE_MS);
    await writer.runDue();
    expect(prompts).toHaveLength(0);
    answer({ episode: EPISODE, facts: [] });
    await fireAlarm();
    expect(prompts).toHaveLength(1);
    expect(queue()).toEqual([]);
    expect(alarm).toBeNull();
  });

  it("a task run is written soon, names its task, and is dated at the conversation's start", async () => {
    await conversation("run1", { source: "local", title: "Post one tip", instructions: undefined as never });
    const started = iso();
    clock += 60_000;
    await writer.ended("run1", { soon: true, task: DAILY });
    expect(alarm).toBe(clock + EPISODE_TASK_DELAY_MS);
    answer({ episode: EPISODE, facts: [] });
    await fireAlarm();
    const [ep] = await store.list();
    expect(ep).toMatchObject({
      kind: "episode",
      scope: "global",
      at: started,
      taskKey: memoryTaskKey(DAILY.instructions, DAILY.account),
      taskTitle: "Post one tip about Mecha Royale on X",
      entities: ["app.channex.io", "Paul Lee"],
      source: { kind: "task", sessionId: "run1" },
    });
    expect(prompts[0]!.prompt).toContain("A task run");
    expect(prompts[0]!.prompt).toContain("User: Post one tip about Mecha Royale on X Keep it short");
    // The episode itself is not noted in the chat.
    expect((await eventsOf("run1")).some((e) => e.type === "memory")).toBe(false);
  });

  it("a turn still running when it comes due is looked at again after another idle period", async () => {
    await conversation("chat");
    await writer.ended("chat", { soon: false });
    await sessions.reopen("chat", { startedAt: iso() });
    await fireAlarm();
    expect(prompts).toHaveLength(0);
    expect(queue()).toEqual([expect.objectContaining({ sessionId: "chat", attempts: 0, dueAt: clock + EPISODE_IDLE_MS })]);
  });

  it("resume() sets the alarm again from the stored queue (a new worker)", async () => {
    await conversation("chat");
    await writer.ended("chat", { soon: false });
    alarm = null;
    await writer.resume();
    expect(alarm).toBe(START + EPISODE_IDLE_MS);
    expect(writer.onAlarm("something-else")).toBe(false);
  });
});

describe("what it skips", () => {
  const skipped = async (why: RegExp) => {
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    expect(prompts).toHaveLength(0);
    expect(await store.list()).toEqual([]);
    expect(queue()).toEqual([]);
    expect(logs.at(-1)).toMatch(why);
  };

  it("memory paused", async () => {
    await conversation("chat");
    settings.memoryPaused = true;
    await skipped(/memory is paused/);
  });

  it("memory off in the chat", async () => {
    await conversation("chat", { memoryOff: true });
    await skipped(/off in this chat/);
  });

  it("Episodes turned off in Settings stops the whole pass (no facts either)", async () => {
    await conversation("chat");
    settings.memoryKindsOff = ["episode"];
    await skipped(/episodes are off/);
  });

  it("a conversation too short to matter", async () => {
    await conversation("chat", { instructions: "hi" }, [{ type: "assistant_text", text: "Hello!" }]);
    await skipped(/too short/);
  });

  it("a brain without a writer", async () => {
    await conversation("chat", { brain: "scripted" });
    await skipped(/no memory writer for the scripted brain/);
  });

  it("nothing new since the last summary", async () => {
    await conversation("chat");
    answer({ episode: EPISODE, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    // A memory note or a status line is not new conversation.
    await sessions.note("chat", { type: "status", text: "later" });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    expect(prompts).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/nothing new/);
  });
});

describe("the episode", () => {
  it("is rewritten for the same conversation after a later turn", async () => {
    await conversation("chat");
    answer({ episode: EPISODE, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    // The next turn, as lifecycle.runTurn opens it.
    await sessions.reopen("chat", { startedAt: iso(), turns: 2, firstStartedAt: new Date(START).toISOString() });
    sessions.append("chat", { type: "user_message", text: "Also tell the guest about parking" });
    sessions.append("chat", { type: "task_end", outcome: "done", summary: "Told the guest" });
    await sessions.update("chat", { endedAt: iso() });
    answer({ episode: { ...EPISODE, text: "Confirmed the booking and told the guest about parking." }, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    const episodes = (await store.list()).filter((e) => e.kind === "episode");
    expect(episodes).toEqual([expect.objectContaining({ id: "m1", text: "Confirmed the booking and told the guest about parking.", at: new Date(START).toISOString() })]);
    expect(prompts[1]!.prompt).toContain("User: Also tell the guest about parking");
  });

  it("of a conversation the user stopped is marked stopped; a later turn that finishes clears it", async () => {
    await conversation("chat");
    await sessions.update("chat", { outcome: "paused", reason: USER_STOP_REASON });
    await sessions.flush();
    answer({ episode: EPISODE, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    expect((await store.list()).find((e) => e.kind === "episode")).toMatchObject({ stopped: true });
    await sessions.reopen("chat", { startedAt: iso(), turns: 2, firstStartedAt: new Date(START).toISOString() });
    sessions.append("chat", { type: "user_message", text: "Go on" });
    sessions.append("chat", { type: "task_end", outcome: "done", summary: "Confirmed" });
    await sessions.update("chat", { endedAt: iso(), outcome: "done" });
    answer({ episode: EPISODE, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    expect((await store.list()).find((e) => e.kind === "episode")!.stopped).toBeUndefined();
  });

  it("written before episodes were marked: a worker start marks those of stopped conversations, once", async () => {
    await conversation("stopped");
    await sessions.update("stopped", { outcome: "paused", reason: USER_STOP_REASON });
    await conversation("finished");
    await sessions.flush();
    const source = (sessionId: string) => ({ kind: "chat" as const, sessionId });
    await store.putEpisode({ ...EPISODE, at: iso() }, source("stopped"));
    await store.putEpisode({ ...EPISODE, subject: "Another", at: iso() }, source("finished"));
    await writer.resume();
    const bySession = async () => Object.fromEntries((await store.list()).map((e) => [e.source.sessionId, e.stopped]));
    expect(await bySession()).toEqual({ stopped: true, finished: undefined });
    // Once: a later episode written without the mark (as an older extension would) is left as it is.
    await store.putEpisode({ ...EPISODE, at: iso() }, source("stopped"));
    await writer.resume();
    expect((await bySession()).stopped).toBeUndefined();
  });

  it("of a run paused for the user (a question, a sign-in) is not marked stopped", async () => {
    await conversation("chat");
    await sessions.update("chat", { outcome: "paused", reason: "Which account should I use?" });
    await sessions.flush();
    answer({ episode: EPISODE, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    expect((await store.list()).find((e) => e.kind === "episode")!.stopped).toBeUndefined();
  });
});

describe("facts", () => {
  it("are saved with an auto memory note in the chat, and Undo takes them back", async () => {
    await conversation("chat");
    answer({ episode: EPISODE, facts: [{ kind: "person", subject: "Paul Lee", text: "A guest with a booking on channex" }] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    const fact = (await store.list()).find((e) => e.kind === "person")!;
    expect(fact).toMatchObject({ scope: "global", source: { kind: "chat", sessionId: "chat" } });
    const note = (await eventsOf("chat")).find((e) => e.type === "memory");
    expect(note).toMatchObject({ type: "memory", changeId: "a1", before: null, after: fact, auto: true });
    await memory.undo("chat", "a1");
    expect((await store.list()).some((e) => e.kind === "person")).toBe(false);
  });

  it("obey their kinds' switches and remember's rules; duplicates and secrets are not kept", async () => {
    await store.put({ kind: "account", subject: "Work email", text: "admin@runhq.io is the work Gmail", scope: "global" }, { kind: "user" });
    await conversation("chat");
    settings.memoryKindsOff = ["preference"];
    answer({
      episode: EPISODE,
      facts: [
        { kind: "preference", subject: "Tone", text: "Calm and short" },
        { kind: "playbook", subject: "Bookings", text: "Bookings list is at /bookings" },
        { kind: "account", subject: "work email", text: "admin@runhq.io is the work Gmail" },
      ],
    });
    answers.push(
      JSON.stringify({
        episode: EPISODE,
        facts: [
          { kind: "account", subject: "Bank", text: "password: hunter22" },
          { kind: "playbook", subject: "Bookings", text: "Bookings list is at /bookings", domain: "https://app.channex.io/x" },
        ],
      }),
    );
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    expect((await store.list()).map((e) => e.kind)).toEqual(["account", "episode"]);
    expect(prompts[0]!.prompt).toContain("[m1] account Work email: admin@runhq.io is the work Gmail");
    // The next turn: a secret is refused, the playbook with its site is kept.
    await sessions.note("chat", { type: "user_message", text: "more" });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    const kept = await store.list();
    expect(kept.find((e) => e.kind === "playbook")).toMatchObject({ scope: "domain", domain: "app.channex.io" });
    expect(kept.some((e) => e.subject === "Bank")).toBe(false);
    expect(logs.some((l) => /fact "Bank" from chat refused: Not saved/.test(l))).toBe(true);
  });

  it("replaces an entry it names (Undo puts it back); an unknown id is ignored", async () => {
    await store.put({ kind: "person", subject: "Accountant", text: "Paul Lee is my accountant", scope: "global" }, { kind: "user" });
    await conversation("chat");
    answer({
      episode: null,
      facts: [
        { kind: "person", subject: "Ada Kim", text: "Ada Kim is my accountant now", replaces: "[m1]" },
        { kind: "person", subject: "Bo", text: "Bo is the plumber", replaces: "m404" },
      ],
    });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    const after = await store.list();
    expect(after.map((e) => e.subject)).toEqual(["Ada Kim", "Bo"]);
    expect(after[0]!.history).toEqual([expect.objectContaining({ subject: "Accountant", text: "Paul Lee is my accountant" })]);
    await memory.undo("chat", "a1");
    expect((await store.list()).map((e) => e.subject).sort()).toEqual(["Accountant", "Bo"]);
  });

  it("never replaces a fact of another kind or place: a site's rule stands beside one for everywhere", async () => {
    await store.put({ kind: "preference", subject: "Email sign-off", text: "Sign emails 'Cheers, Jae'.", scope: "global" }, { kind: "user" });
    await conversation("chat");
    answer({ episode: null, facts: [{ kind: "preference", subject: "Support sign-off", text: "Sign support replies 'Jae, RunHQ support'.", domain: "help.runhq.io", replaces: "m1" }] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    const after = await store.list();
    expect(after.map((e) => e.subject).sort()).toEqual(["Email sign-off", "Support sign-off"]);
    expect(after.find((e) => e.subject === "Support sign-off")?.history).toBeUndefined();
  });
});

describe("failures", () => {
  it("are retried a bounded number of times, then dropped", async () => {
    await conversation("chat");
    answers.push(new Error("overloaded"), "not json at all", new Error("overloaded again"));
    await writer.ended("chat", { soon: false });
    for (let attempt = 1; attempt <= MAX_EPISODE_ATTEMPTS; attempt++) {
      await fireAlarm();
      if (attempt < MAX_EPISODE_ATTEMPTS) expect(queue()).toEqual([expect.objectContaining({ attempts: attempt, dueAt: clock + EPISODE_RETRY_MS * attempt })]);
    }
    expect(prompts).toHaveLength(MAX_EPISODE_ATTEMPTS);
    expect(queue()).toEqual([]);
    expect(alarm).toBeNull();
    expect(logs.at(-1)).toMatch(/attempt 3 of 3, dropped\): overloaded again/);
    expect(logs.some((l) => /no JSON object/.test(l))).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("a retry that then succeeds writes the episode", async () => {
    await conversation("chat");
    answers.push(new Error("network"));
    answer({ episode: EPISODE, facts: [] });
    await writer.ended("chat", { soon: false });
    await fireAlarm();
    await fireAlarm();
    expect((await store.list()).map((e) => e.kind)).toEqual(["episode"]);
  });
});

describe("transcriptLines and episodeTrigger", () => {
  it("reads the conversation: request, replies, actions (errors marked), outcomes; task end calls left out", () => {
    const session = { sessionId: "s", source: "adhoc", title: "T", instructions: "Do it", brain: "claude-api", jev: false, startedAt: "x" } as SessionInfo;
    const ev = (e: AgentEvent) => ({ ...e, ts: "t", sessionId: "s" });
    const lines = transcriptLines(session, [
      ev({ type: "tool_call", id: "1", name: "mcp__noa__navigate", args: { url: "https://www.x.com/home" } }),
      ev({ type: "tool_call", id: "2", name: "click", args: { index: 4 } }),
      ev({ type: "tool_result", id: "2", name: "click", text: "No element 4\nmore", isError: true }),
      ev({ type: "status", text: "ignored" }),
      ev({ type: "tool_call", id: "3", name: "task_complete", args: { summary: "done" } }),
      ev({ type: "task_end", outcome: "failed", reason: "blocked", url: "https://x.com/1" }),
      ev({ type: "user_message", text: "try again" }),
    ]);
    expect(lines).toEqual([
      { who: "user", text: "Do it" },
      { who: "action", text: "navigate x.com/home" },
      { who: "action", text: "click #4 (error: No element 4)" },
      { who: "outcome", text: "failed (blocked) https://x.com/1" },
      { who: "user", text: "try again" },
    ]);
  });

  it("a task's first run is written soon; chat turns once idle, naming the task they continue", () => {
    // A local task names its series (its own id when stored before series).
    const task = { id: "t", instructions: "Post", account: "@a" } as never;
    expect(episodeTrigger({ source: "local", task })).toEqual({ soon: true, task: { instructions: "Post", account: "@a", seriesId: "t" } });
    const repeat = { id: "t2", seriesId: "t", instructions: "Post", account: "@a" } as never;
    expect(episodeTrigger({ source: "local", task: repeat }).task?.seriesId).toBe("t");
    expect(episodeTrigger({ source: "adhoc", input: { instructions: "x" } })).toEqual({ soon: false });
    const first = { instructions: "Post", account: null };
    expect(episodeTrigger({ source: "turn", from: { source: "local" } as SessionInfo, text: "go", task: null, first })).toEqual({ soon: false, task: first });
    expect(episodeTrigger({ source: "turn", from: { source: "adhoc" } as SessionInfo, text: "go", task: null, first })).toEqual({ soon: false });
  });
});

describe("backfill: past conversations without an episode", () => {
  const DAY = 86_400_000;
  let busy: boolean;
  let pushes: number;
  let failFor: Set<string>;

  /** A writer as a worker start makes it: the same stored state, the given summaries (EPISODE for each by default). */
  function worker(): EpisodeWriter {
    const summarize: Summarize = async (req) => {
      prompts.push(req);
      if (failFor.has(req.sessionId)) throw new Error("the model is overloaded");
      return { text: JSON.stringify({ episode: { ...EPISODE, subject: `Episode of ${req.sessionId}` }, facts: [] }) };
    };
    return new EpisodeWriter({
      store,
      sessions,
      settings: async () => settings,
      summarizer: (brain) => (brainsWithWriter.includes(brain) ? summarize : null),
      alarms: { set: async (when) => void (alarm = when), clear: async () => void (alarm = null) },
      storage,
      now: () => clock,
      busy: () => busy,
      onBackfillProgress: () => void pushes++,
      log: (m) => logs.push(m),
    });
  }

  /** Past conversations, one per hour, oldest first (ids in that order). */
  async function history(ids: string[], extra: Record<string, Partial<SessionInfo>> = {}): Promise<void> {
    for (const id of ids) {
      await conversation(id, extra[id] ?? {});
      clock += 3_600_000;
    }
  }

  const episodeIds = async () => (await store.list()).filter((e) => e.kind === "episode").map((e) => e.source.sessionId);

  /** Runs the alarm's pass once its time has come. */
  async function tick(w: EpisodeWriter): Promise<void> {
    clock = Math.max(clock, alarm!);
    await w.runDue();
  }

  beforeEach(() => {
    busy = false;
    pushes = 0;
    failFor = new Set();
  });

  it("lists the recent ended ones with none, newest first, and writes one per BACKFILL_GAP_MS on the conversation's own brain", async () => {
    clock = START - (BACKFILL_DAYS + 1) * DAY;
    await history(["too-old"]);
    clock = START - 3 * DAY;
    await history(["old", "private", "scripted", "has-episode", "written", "recent"], { private: { memoryOff: true }, scripted: { brain: "scripted" as SessionInfo["brain"] } });
    // One already has an episode in memory (e.g. from another browser); one the writer already summarized.
    await store.putEpisode({ ...EPISODE, at: iso() }, { kind: "chat", sessionId: "has-episode" });
    storage.data[EPISODE_QUEUE_KEY] = { queue: [], written: { written: iso() } };
    await sessions.create({ sessionId: "running", source: "adhoc", title: "Still going", brain: "claude-api", jev: false, startedAt: iso() });
    clock = START;

    const w = worker();
    await w.resume();
    expect(await w.backfillProgress()).toEqual({ done: 0, total: 2 });
    expect(alarm).toBe(START + BACKFILL_GAP_MS);
    expect(pushes).toBe(1);
    await w.runDue();
    expect(prompts).toHaveLength(0);

    await tick(w);
    expect(prompts.map((p) => p.sessionId)).toEqual(["recent"]);
    expect(await w.backfillProgress()).toEqual({ done: 1, total: 2 });
    expect(alarm).toBe(clock + BACKFILL_GAP_MS);
    await tick(w);
    expect(prompts.map((p) => p.sessionId)).toEqual(["recent", "old"]);
    expect(await episodeIds()).toEqual(expect.arrayContaining(["recent", "old", "has-episode"]));
    // Done: nothing left, and a later worker start does not list again.
    expect(await w.backfillProgress()).toBeNull();
    expect(alarm).toBeNull();
    await worker().resume();
    expect(await w.backfillProgress()).toBeNull();
  });

  it("is bounded by MAX_BACKFILL_SESSIONS (the newest)", async () => {
    clock = START - 2 * DAY;
    const ids = Array.from({ length: MAX_BACKFILL_SESSIONS + 2 }, (_, i) => `c${i}`);
    await history(ids);
    const w = worker();
    await w.resume();
    expect(await w.backfillProgress()).toEqual({ done: 0, total: MAX_BACKFILL_SESSIONS });
    await tick(w);
    expect(prompts[0]!.sessionId).toBe(ids.at(-1));
  });

  it("goes on where it was after a worker restart, and waits while a run is going on", async () => {
    clock = START - DAY;
    await history(["a", "b", "c"]);
    const first = worker();
    await first.resume();
    await tick(first);
    expect(prompts.map((p) => p.sessionId)).toEqual(["c"]);

    // The worker sleeps and starts again: the alarm is set again, the list is not made anew.
    alarm = null;
    const second = worker();
    await second.resume();
    expect(await second.backfillProgress()).toEqual({ done: 1, total: 3 });
    expect(alarm).not.toBeNull();
    busy = true;
    await tick(second);
    expect(prompts).toHaveLength(1);
    expect(alarm).toBe(clock + BACKFILL_GAP_MS);
    busy = false;
    await tick(second);
    await tick(second);
    expect(prompts.map((p) => p.sessionId)).toEqual(["c", "b", "a"]);
    expect(await second.backfillProgress()).toBeNull();
  });

  it("a conversation whose turn just ended goes first; the backfill waits its turn", async () => {
    clock = START - DAY;
    await history(["past"]);
    const w = worker();
    await w.resume();
    await conversation("now");
    await w.ended("now", { soon: true });
    clock += BACKFILL_GAP_MS;
    await w.runDue();
    expect(prompts.map((p) => p.sessionId)).toEqual(["now", "past"]);
  });

  it("memory or Episodes off: dropped; listed again at a later worker start once back on", async () => {
    clock = START - DAY;
    await history(["a", "b"]);
    const w = worker();
    await w.resume();
    await tick(w);
    settings.memoryKindsOff = ["episode"];
    await tick(w);
    expect(prompts.map((p) => p.sessionId)).toEqual(["b"]);
    expect(await w.backfillProgress()).toBeNull();
    // Still off at the next start: nothing listed.
    await worker().resume();
    expect(await w.backfillProgress()).toBeNull();
    settings.memoryKindsOff = [];
    await worker().resume();
    expect(await w.backfillProgress()).toEqual({ done: 0, total: 1 });
    await tick(w);
    expect(prompts.map((p) => p.sessionId)).toEqual(["b", "a"]);
  });

  it("a failure is tried again after the others, at most MAX_EPISODE_ATTEMPTS times", async () => {
    clock = START - DAY;
    await history(["a", "b"]);
    failFor.add("b");
    const w = worker();
    await w.resume();
    for (let i = 0; i < MAX_EPISODE_ATTEMPTS + 1; i++) await tick(w);
    expect(prompts.map((p) => p.sessionId)).toEqual(["b", "a", ...Array(MAX_EPISODE_ATTEMPTS - 1).fill("b")]);
    expect(await w.backfillProgress()).toBeNull();
    expect(await episodeIds()).toEqual(["a"]);
    expect(logs.some((l) => /episode backfill b: failed, dropped/.test(l))).toBe(true);
  });
});
