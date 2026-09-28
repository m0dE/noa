import { describe, expect, it, vi } from "vitest";
import { TODO_TOOLS, toolsFor, type AgentEvent, type RunConfig, type TraceDraft } from "@noa/shared";
import { MAX_RETRY_AFTER_MS, RETRY_JITTER, retryWaitMs, startApiAgentWith } from "../src/api-agent.js";
import { retryAfterMs } from "../src/anthropic.js";
import { ENDED_WITHOUT_RESULT } from "../src/failures.js";
import { raiseNote, TASK_FAIL_RECHECK, THINKING_MAX_TOKENS } from "../src/reasoning.js";
import type { ApiAgentOptions, BrowserCaller, JevLike } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { CONFIG, collect, fakeJev, fakeMessagesServer, messageSseEvents, noSleep, smartJev, type FakeReplySource } from "./helpers.js";

type Block = Record<string, any>;

let nextId = 1;
const msg = (...content: Block[]) => ({
  body: { id: `msg_${nextId}`, type: "message", role: "assistant", content, stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn" },
});
const tool = (name: string, input: unknown = {}): Block => ({ type: "tool_use", id: `toolu_${nextId++}`, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

function start(
  x: FakeX,
  replies: FakeReplySource[],
  over: {
    jev?: JevLike | null;
    config?: Partial<RunConfig>;
    mediaPaths?: string[];
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    browser?: BrowserCaller;
    /** Jitter source; default 0.5, which is no jitter. */
    random?: () => number;
    onTrace?: ApiAgentOptions["onTrace"];
    /** false: whole replies, as the hosted AI answers (a request is then never stopped for a user message). */
    stream?: boolean;
  } = {},
) {
  const server = fakeMessagesServer(replies);
  const { events, onEvent } = collect();
  const opts: ApiAgentOptions = {
    sessionId: "S1",
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    task: { id: "T1", instructions: "Post: gm", account: null },
    mediaPaths: over.mediaPaths ?? [],
    config: { ...CONFIG, ...over.config },
    browser: over.browser ?? x.caller(),
    jev: over.jev === undefined ? null : over.jev,
    onEvent,
    fetch: server.fetchImpl,
    ...(over.onTrace ? { onTrace: over.onTrace } : {}),
    ...(over.stream === undefined ? {} : { stream: over.stream }),
  };
  const session = startApiAgentWith(opts, { sleep: over.sleep ?? noSleep, retryDelaysMs: over.delays ?? [1000, 3000, 9000], random: over.random ?? (() => 0.5) });
  return { session, server, events };
}

const toolNames = (req: { body: any }) => req.body.tools.map((t: any) => t.name);
const lastUser = (req: { body: any }) => req.body.messages.at(-1);

describe("startApiAgent", () => {
  it("sends a correct Messages API request and finishes with task_complete", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [
      msg(text("Reading the page."), tool("read_page")),
      msg(tool("act", { steps: [{ goal: "type the post", index: 2, text: "gm" }, { goal: "click Post", index: 4 }] })),
      msg(tool("screenshot")),
      msg(tool("task_complete", { summary: "posted", url: "https://x.com/alice/status/1000" })),
    ]);
    const result = await session.done;
    expect(result).toEqual({ outcome: "done", summary: "posted", url: "https://x.com/alice/status/1000" });
    expect(x.posts).toHaveLength(1);

    const first = server.requests[0]!;
    expect(first.url).toBe("https://api.anthropic.com/v1/messages");
    expect(first.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    });
    expect(first.body.model).toBe("claude-sonnet-5");
    expect(first.body.max_tokens).toBe(4096);
    expect(first.body.system).toEqual([{ type: "text", text: expect.stringContaining("noa"), cache_control: { type: "ephemeral" } }]);
    // act (batched, index steps) replaces click and type even without Jev; only the last tool has the cache breakpoint.
    expect(toolNames(first)).toContain("act");
    expect(toolNames(first)).not.toContain("click");
    expect(toolNames(first)).not.toContain("type");
    expect(toolNames(first)).toEqual(toolsFor());
    // The TODO tools (scheduling from the chat) are offered, schedule_task with its input schema.
    expect(toolNames(first)).toEqual(expect.arrayContaining([...TODO_TOOLS]));
    const schedule = first.body.tools.find((t: any) => t.name === "schedule_task");
    expect(schedule.input_schema).toMatchObject({ type: "object", required: ["task", "schedule"] });
    expect(first.body.tools.filter((t: any) => t.cache_control)).toEqual([first.body.tools.at(-1)]);
    const actTool = first.body.tools.find((t: any) => t.name === "act");
    expect(actTool.input_schema).toMatchObject({ type: "object", required: ["steps"] });
    expect(actTool.input_schema.properties.steps.items.properties.index).toMatchObject({ type: "integer" });
    expect(actTool.input_schema.$schema).toBeUndefined();
    const act = first.body.tools.find((t: any) => t.name === "scroll");
    expect(act.input_schema.required).toEqual(["direction"]);
    expect(first.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: expect.stringContaining("Post: gm"), cache_control: { type: "ephemeral" } }] }]);

    // tool_result blocks answer each tool_use id
    const second = server.requests[1]!;
    expect(second.body.messages[1]).toMatchObject({ role: "assistant" });
    const tr = lastUser(second).content[0];
    expect(tr).toMatchObject({ type: "tool_result", tool_use_id: second.body.messages[1].content[1].id });
    expect(tr.content[0].text).toContain("URL: https://x.com/home");
    // screenshot comes back as image content
    const fourth = server.requests[3]!;
    expect(lastUser(fourth).content[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: expect.any(String) } },
    ]);

    // Streamed: the request asks for events, text arrives as deltas of block msg:0, then whole with the same id.
    expect(first.body.stream).toBe(true);
    const final = events.find((e) => e.type === "assistant_text") as Extract<AgentEvent, { type: "assistant_text" }>;
    expect(final).toEqual({ type: "assistant_text", text: "Reading the page.", id: expect.stringMatching(/^msg_\d+:0$/) });
    const deltas = events.filter((e) => e.type === "assistant_text_delta") as Extract<AgentEvent, { type: "assistant_text_delta" }>[];
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.id === final.id)).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe("Reading the page.");
    expect(events.indexOf(final)).toBeGreaterThan(events.indexOf(deltas.at(-1)!));
    // Tool input rebuilt from input_json_delta parts.
    expect(server.requests[2]!.body.messages[3].content[0]).toMatchObject({ type: "tool_use", name: "act", input: { steps: [{ goal: "type the post", index: 2, text: "gm" }, { goal: "click Post", index: 4 }] } });
    expect(events.filter((e) => e.type === "tool_call").map((e: any) => e.name)).toEqual(["read_page", "act", "screenshot", "task_complete"]);
    expect(events.at(-1)).toEqual({ type: "task_end", outcome: "done", summary: "posted", url: "https://x.com/alice/status/1000" });
  });

  it("task_complete's follow-up suggestion ends the turn's result and its task_end; the schema offers it", async () => {
    const x = new FakeX({ url: "https://mail.example.com/inbox" });
    const { session, server, events } = start(x, [
      msg(text("You have one email from Jordan asking you to sign the lease by Thursday."), tool("task_complete", { summary: "Checked email", suggestion: "Reply to Jordan and say I'll sign by Thursday" })),
    ]);
    const result = await session.done;
    expect(result).toEqual({ outcome: "done", summary: "Checked email", suggestion: "Reply to Jordan and say I'll sign by Thursday" });
    expect(events.at(-1)).toEqual({ type: "task_end", outcome: "done", summary: "Checked email", suggestion: "Reply to Jordan and say I'll sign by Thursday" });
    const req = server.requests[0]!.body;
    for (const name of ["task_complete", "task_fail", "task_pause"]) {
      expect(req.tools.find((t: any) => t.name === name).input_schema.properties.suggestion).toMatchObject({ type: "string", maxLength: 80 });
    }
    expect(req.system[0].text).toContain("give it as `suggestion`");
  });

  it("with Jev, act replaces click/type for the whole task, even after a step is not confident", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = smartJev();
    const { session, server, events } = start(
      x,
      [
        msg(tool("act", { steps: [{ goal: "type the post text into the composer", text: "gm" }, { goal: "click the post button" }] })),
        msg(tool("act", { steps: [{ goal: "open the mystery menu" }] })),
        msg(tool("task_complete", { summary: "posted" })),
      ],
      { jev },
    );
    await session.done;
    expect(x.posts.map((p) => p.text)).toEqual(["gm"]);
    const [r1, r2, r3] = server.requests;
    expect(toolNames(r1!)).toContain("act");
    expect(toolNames(r1!)).not.toContain("click");
    expect(toolNames(r1!)).not.toContain("type");
    expect(r1!.body.system[0].text).toMatch(/one act call \(up to 12\)/);
    expect(toolNames(r2!)).not.toContain("click");
    // The second act was not confident: the model is told to retry with an index, still via act.
    expect(lastUser(r3!).content[0].content[0].text).toContain("not confident at step 1");
    expect(lastUser(r3!).content[0].content[0].text).toMatch(/index of the right candidate/);
    expect(lastUser(r3!).content[0].content[0].text).toContain("Candidates for step 1");
    expect(toolNames(r3!)).not.toContain("click");
    expect(toolNames(r3!)).not.toContain("type");
    expect(events.filter((e) => e.type === "jev")).toHaveLength(3);
    // Jev mode: the tools are described for it, and the turn ends with who picked the elements.
    const actTool = r1!.body.tools.find((t: any) => t.name === "act");
    expect(actTool.description).toMatch(/Describe each step's element in words/);
    expect(actTool.input_schema.properties.steps.items.properties.index.description).toMatch(/not confident/);
    expect(r1!.body.tools.find((t: any) => t.name === "read_page").description).toMatch(/no index numbers/);
    expect(events.at(-2)).toEqual({ type: "status", text: "Jev chose 2 of 2 element picks (clicks and typing)", picks: { jev: 2, claude: 0 } });
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "done" });
  });

  it("without Jev, no picks line and the tools keep their index descriptions", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [msg(tool("act", { steps: [{ goal: "type", index: 2, text: "gm" }] })), msg(tool("task_complete", { summary: "ok" }))]);
    await session.done;
    expect(events.some((e) => e.type === "status" && "picks" in e)).toBe(false);
    expect(server.requests[0]!.body.tools.find((t: any) => t.name === "read_page").description).toMatch(/indexed list/);
  });

  it("refuses a locked tool that the model calls anyway", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server } = start(x, [msg(tool("click", { index: 1 })), msg(tool("task_fail", { reason: "gave up" }))], { jev: fakeJev([]) });
    expect(await session.done).toEqual({ outcome: "failed", reason: "gave up" });
    expect(lastUser(server.requests[1]!).content[0]).toMatchObject({ is_error: true, content: [{ text: expect.stringMatching(/click is not available|Tool click is not available/) }] });
    expect(x.calls).toHaveLength(0);
  });

  it("a user message sent while the model is thinking goes to it as user text with the next tool results, marked as overriding the task", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    const r = start(x, [
      () => {
        session.sendUserMessage("use the draft text instead");
        return msg(tool("read_page"));
      },
      msg(tool("task_complete", { summary: "ok" })),
      // A whole reply (not streamed) is let finish: the message goes with its tool results.
    ], { stream: false });
    session = r.session;
    await session.done;
    const content = lastUser(r.server.requests[1]!).content;
    expect(content[0].type).toBe("tool_result");
    // Never inside the tool result (untrusted page content): a user text block of its own.
    expect(content[0].content[0].text).not.toContain("use the draft text instead");
    expect(content[1]).toEqual({ type: "text", text: 'The user just said: "use the draft text instead". Act on it now: a question or remark, answer it in a short reply before your next tool call (in the same message) and go on with the task; otherwise it changes the current task (keep doing what it does not change), or replaces or stops it if that is what it says.', cache_control: { type: "ephemeral" } });
    expect(r.events.some((e) => e.type === "user_message" && e.text === "use the draft text instead")).toBe(true);
  });

  it("a question sent mid-task (\"can you speak Korean?\") is framed to be answered before the next browser call; the answer reaches the chat before that call runs", async () => {
    const x = new FakeX({ url: "https://mail.test/u/0" });
    let session!: ReturnType<typeof start>["session"];
    const r = start(
      x,
      [
        () => {
          session.sendUserMessage("can you speak Korean?");
          return msg(tool("act", { steps: [{ goal: "type the refund request", index: 1, text: "refund" }, { goal: "click send", index: 2 }] }));
        },
        // A model following the framing: the answer first, then the task goes on.
        msg(text("Yes, I can speak Korean."), tool("read_page")),
        msg(tool("task_complete", { summary: "sent" })),
      ],
      { stream: false },
    );
    session = r.session;
    await session.done;
    expect(lastUser(r.server.requests[1]!).content.at(-1)).toEqual({ type: "text", text: expect.stringContaining("a question or remark, answer it in a short reply before your next tool call"), cache_control: { type: "ephemeral" } });
    const answer = r.events.findIndex((e) => e.type === "assistant_text" && e.text === "Yes, I can speak Korean.");
    const nextCall = r.events.findIndex((e) => e.type === "tool_call" && e.name === "read_page");
    expect(answer).toBeGreaterThan(-1);
    expect(nextCall).toBeGreaterThan(answer);
    expect(r.server.requests[0]!.body.system.map((b: any) => b.text).join(" ")).toContain('A question or remark (e.g. "can you speak Korean?") is answered at once');
  });

  it("a user message sent while the model writes its final answer keeps the turn going: task_complete is refused and the message follows", async () => {
    const x = new FakeX({ url: "https://mail.test/u/0" });
    let session!: ReturnType<typeof start>["session"];
    const traces: TraceDraft[] = [];
    const r = start(
      x,
      [
        () => {
          // The model is already writing the summary of page A when the user redirects it.
          session.sendUserMessage("no, use page B");
          return msg(text("Page A has 3 unread emails."), tool("task_complete", { summary: "Summarised page A" }));
        },
        msg(tool("navigate", { url: "https://mail.test/u/2" })),
        msg(text("Page B has 1 unread email."), tool("task_complete", { summary: "Summarised page B" })),
      ],
      // A whole reply (not streamed) is let finish: its task_complete is refused.
      { onTrace: (e) => traces.push(e), stream: false },
    );
    session = r.session;
    expect(await session.done).toEqual({ outcome: "done", summary: "Summarised page B" });
    const [refused, said] = lastUser(r.server.requests[1]!).content;
    expect(refused).toMatchObject({ type: "tool_result", is_error: true });
    expect(refused.content[0].text).toBe("Not recorded: the user sent you a new message, so task_complete was not called. Read that message (it follows) and do what it asks before ending.");
    expect(said).toEqual({ type: "text", text: expect.stringContaining('The user just said: "no, use page B"'), cache_control: { type: "ephemeral" } });
    expect(r.events.filter((e) => e.type === "task_end")).toHaveLength(1);
    expect(traces.find((t) => t.name === "interjection")).toMatchObject({ cat: "user", data: { route: "request", count: 1 } });
  });

  it("a user message during a slow page load reaches the model in the next request, without waiting for the page", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    let finishLoad!: (r: unknown) => void;
    const browser: BrowserCaller = {
      call: async (method, params) => {
        if (method === "browser.navigate") {
          session.sendUserMessage("skip that page, open the other one");
          return new Promise((r) => (finishLoad = r as never)) as never;
        }
        return x.caller().call(method, params);
      },
    };
    const traces: TraceDraft[] = [];
    const r = start(x, [msg(tool("navigate", { url: "https://slow.test/a" })), msg(tool("task_complete", { summary: "switched" }))], { browser, onTrace: (e) => traces.push(e) });
    session = r.session;
    expect(await session.done).toEqual({ outcome: "done", summary: "switched" });
    const [result, said] = lastUser(r.server.requests[1]!).content;
    expect(result.content[0].text).toContain("still loading");
    expect(said.text).toContain('The user just said: "skip that page, open the other one"');
    expect(traces.find((t) => t.name === "interjection")).toMatchObject({ data: { route: "request", count: 1 } });
    finishLoad({ url: "https://slow.test/a", title: "A" });
  });

  it("a user message while act's first read waits for a page still loading ends that wait: nothing was run, the message follows", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    let reads = 0;
    const browser: BrowserCaller = {
      call: async (method, params) => {
        if (method === "browser.readPage" && reads++ === 0) {
          // The extension waits for the page to draw (readWhenDrawn); the user speaks meanwhile.
          setTimeout(() => session.sendUserMessage("use the other account"), 5);
          return new Promise(() => {}) as never;
        }
        return x.caller().call(method, params);
      },
    };
    const jev = fakeJev([]);
    const r = start(x, [msg(tool("act", { steps: [{ goal: "click Post" }, { goal: "type the post", text: "gm" }] })), msg(tool("task_complete", { summary: "switched" }))], { browser, jev });
    session = r.session;
    expect(await session.done).toEqual({ outcome: "done", summary: "switched" });
    const [result, said] = lastUser(r.server.requests[1]!).content;
    expect(result.content[0].text).toBe("Stopped before step 1: the page was still loading when the user sent you a message (it follows). Steps 1-2 were not run.");
    expect(said.text).toContain('The user just said: "use the other account"');
    // Jev was never asked: no step ran.
    expect(jev.goals).toEqual([]);
  });

  describe("a user message while the model is still writing", () => {
    /**
     * A Messages endpoint whose first reply streams `first` and then stalls (until it is aborted, or `release()`),
     * and whose later replies call task_complete. `firstOut`: the stream's events written before the stall.
     */
    function stallingServer(first: Parameters<typeof messageSseEvents>[0], firstOut: number) {
      const requests: any[] = [];
      let release!: () => void;
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        await new Promise((r) => setTimeout(r, 0));
        const body = JSON.parse(String(init?.body));
        requests.push(structuredClone(body));
        const events = requests.length === 1 ? messageSseEvents(first) : messageSseEvents({ id: `m${requests.length}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu${requests.length}`, name: "task_complete", input: { summary: "changed course" } }] });
        const frame = ([event, data]: [string, unknown]) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            const stall = requests.length === 1;
            for (const e of stall ? events.slice(0, firstOut) : events) c.enqueue(frame(e));
            if (!stall) return c.close();
            const aborted = new Promise<void>((r) => init?.signal?.addEventListener("abort", () => r()));
            const released = new Promise<void>((r) => (release = r));
            const how = await Promise.race([aborted.then(() => "aborted" as const), released.then(() => "released" as const)]);
            if (how === "aborted") return c.error(new DOMException("The operation was aborted.", "AbortError"));
            for (const e of events.slice(firstOut)) c.enqueue(frame(e));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch;
      return { fetchImpl, requests, release: () => release() };
    }

    function run(server: ReturnType<typeof stallingServer>, x: FakeX) {
      const { events, onEvent } = collect();
      const traces: TraceDraft[] = [];
      const session = startApiAgentWith(
        { sessionId: "S1", apiKey: "sk-test", model: "claude-sonnet-5", task: { id: "T1", instructions: "Summarise page A", account: null }, mediaPaths: [], config: CONFIG, browser: x.caller(), jev: null, onEvent, fetch: server.fetchImpl, onTrace: (e) => traces.push(e) },
        { sleep: noSleep },
      );
      return { session, events, traces };
    }

    it("while it only writes text, its request is stopped and the next one carries the message at once", async () => {
      const x = new FakeX({ url: "https://mail.test/u/0" });
      const server = stallingServer({ id: "m1", stop_reason: "tool_use", content: [text("Page A has three unread emails, the first one"), tool("navigate", { url: "https://mail.test/u/1" })] }, 4);
      const r = run(server, x);
      await vi.waitFor(() => expect(r.events.some((e) => e.type === "assistant_text_delta")).toBe(true));
      r.session.sendUserMessage("no, use page B");
      expect(await r.session.done).toEqual({ outcome: "done", summary: "changed course" });
      expect(server.requests).toHaveLength(2);
      // The stopped reply is not in the history: the user's message follows the task prompt directly.
      expect(server.requests[1].messages.at(-1)).toEqual({ role: "user", content: [expect.objectContaining({ type: "text" }), { type: "text", text: expect.stringContaining('The user just said: "no, use page B"'), cache_control: { type: "ephemeral" } }] });
      expect(x.calls.some((c) => c.method === "browser.navigate")).toBe(false);
      expect(r.traces.find((t) => t.name === "interjection")).toMatchObject({ data: { route: "interrupt", count: 1 } });
      expect(r.traces.find((t) => t.name === "model.call")).toMatchObject({ data: { result: "interrupted" } });
    });

    it("once it started a tool call, the request is let finish: the call runs, then the message follows", async () => {
      const x = new FakeX({ url: "https://mail.test/u/0" });
      // Stalls after the tool_use block started.
      const server = stallingServer({ id: "m1", stop_reason: "tool_use", content: [tool("read_page")] }, 3);
      const r = run(server, x);
      await vi.waitFor(() => expect(server.requests).toHaveLength(1));
      await new Promise((res) => setTimeout(res, 10));
      r.session.sendUserMessage("no, use page B");
      await new Promise((res) => setTimeout(res, 10));
      server.release();
      expect(await r.session.done).toEqual({ outcome: "done", summary: "changed course" });
      expect(x.calls.some((c) => c.method === "browser.readPage")).toBe(true);
      const [result, said] = server.requests[1].messages.at(-1).content;
      expect(result.type).toBe("tool_result");
      expect(said.text).toContain('The user just said: "no, use page B"');
    });
  });

  it("act stops before its next step when the user sends a message, which follows the result", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    const browser: BrowserCaller = {
      call: async (method, params) => {
        if (method === "browser.type") session.sendUserMessage("stop, do not post that");
        return x.caller().call(method, params);
      },
    };
    const r = start(
      x,
      [msg(tool("read_page")), msg(tool("act", { steps: [{ goal: "type the post", index: 2, text: "gm" }, { goal: "click Post", index: 4 }] })), msg(tool("task_complete", { summary: "stopped" }))],
      { browser },
    );
    session = r.session;
    await session.done;
    const [result, said] = lastUser(r.server.requests[2]!).content;
    expect(result.content[0].text).toContain("Stopped before step 2: the user sent a new message (it follows). Steps 2-2 were not run.");
    expect(said.text).toContain('The user just said: "stop, do not post that"');
    expect(x.posts).toHaveLength(0);
  });

  it("a user message after an end_turn keeps the loop going", async () => {
    const x = new FakeX();
    let session!: ReturnType<typeof start>["session"];
    const r = start(x, [
      () => {
        session.sendUserMessage("are you done?");
        return msg(text("I think I am done."));
      },
      msg(tool("task_complete", { summary: "yes" })),
      // A whole reply (not streamed) is let finish.
    ], { stream: false });
    session = r.session;
    expect(await session.done).toEqual({ outcome: "done", summary: "yes" });
    expect(r.server.requests[1]!.body.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: expect.stringContaining("are you done?"), cache_control: { type: "ephemeral" } }] });
  });

  it("ending without a task_* tool is a failure", async () => {
    const { session, events } = start(new FakeX(), [msg(text("All done!"))]);
    expect(await session.done).toEqual({ outcome: "failed", reason: ENDED_WITHOUT_RESULT });
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "failed" });
  });

  it("retries 429/529/5xx/network with 1 s, 3 s, 9 s backoff, then succeeds", async () => {
    const waits: number[] = [];
    const { session, server } = start(
      new FakeX(),
      [{ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } }, { status: 529 }, { throws: "fetch failed" }, msg(tool("task_complete", { summary: "ok" }))],
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(await session.done).toMatchObject({ outcome: "done" });
    expect(waits).toEqual([1000, 3000, 9000]);
    expect(server.served).toBe(4);
  });

  it("traces each Messages request (attempt, outcome, tokens) and each retry wait, and the tools between", async () => {
    const traces: TraceDraft[] = [];
    const done = msg(tool("task_complete", { summary: "ok" }));
    // Streamed: input usage from message_start, the output count from the final message_delta (the fake says 10).
    (done.body as Record<string, unknown>).usage = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 };
    const { session } = start(new FakeX(), [{ status: 529 }, msg(tool("read_page")), done], { onTrace: (e) => traces.push(e) });
    expect(await session.done).toMatchObject({ outcome: "done" });
    const calls = traces.filter((e) => e.name === "model.call");
    expect(calls.map((e) => [e.data?.attempt, e.data?.result])).toEqual([
      [1, "transient"],
      [2, "ok"],
      [1, "ok"],
    ]);
    expect(calls[2]!.data).toMatchObject({ model: "claude-sonnet-5", stop: "tool_use", toolUses: 1, inTokens: 12, outTokens: 10, cacheReadTokens: 5000, cacheWriteTokens: 700 });
    for (const c of calls) expect(typeof c.ms).toBe("number");
    expect(traces.filter((e) => e.name === "model.wait").map((e) => e.data)).toEqual([{ attempt: 1, planMs: 1000, serverAsked: false }]);
    expect(traces.filter((e) => e.name === "tool").map((e) => e.data?.tool)).toEqual(["read_page", "task_complete"]);
  });

  it("waits as long as the server's retry-after-ms / retry-after says (capped), else the backoff with jitter", async () => {
    const waits: number[] = [];
    const busy = (headers: Record<string, string>) => ({ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, headers });
    const { session } = start(
      new FakeX(),
      [busy({ "retry-after-ms": "1500.4" }), busy({ "retry-after": "7" }), busy({ "retry-after": "3600" }), msg(tool("task_complete", { summary: "ok" }))],
      { sleep: async (ms) => void waits.push(ms), delays: [1000, 3000, 9000, 9000] },
    );
    expect(await session.done).toMatchObject({ outcome: "done" });
    expect(waits).toEqual([1500, 7000, MAX_RETRY_AFTER_MS]);

    // Without a retry-after: the backoff, varied by at most RETRY_JITTER either way.
    const jittered = [0, 0.25, 1].map((r) => retryWaitMs(1, [1000, 3000], undefined, () => r));
    expect(jittered).toEqual([3000 * (1 - RETRY_JITTER), 3000 * (1 - RETRY_JITTER / 2), 3000 * (1 + RETRY_JITTER)]);
  });

  it("reads retry-after-ms, retry-after in seconds, and retry-after as an HTTP date", () => {
    const now = Date.parse("2026-09-26T10:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250" }), now)).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), now)).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after": "2" }), now)).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after": "Sat, 26 Sep 2026 10:00:30 GMT" }), now)).toBe(30_000);
    expect(retryAfterMs(new Headers({ "retry-after": "Sat, 26 Sep 2026 09:00:00 GMT" }), now)).toBe(0);
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }), now)).toBeUndefined();
    expect(retryAfterMs(new Headers(), now)).toBeUndefined();
  });

  it("gives up after 3 retries with outcome retry", async () => {
    const { session, server } = start(new FakeX(), [{ status: 503, body: { type: "error", error: { type: "api_error", message: "down" } } }]);
    const r = await session.done;
    expect(r.outcome).toBe("retry");
    expect(r.reason).toMatch(/HTTP 503.*gave up after 4 attempts/);
    expect(server.served).toBe(4);
  });

  it("401/403 fail with 'Claude API key rejected' without retrying", async () => {
    const { session, server } = start(new FakeX(), [{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
    expect(await session.done).toEqual({ outcome: "failed", reason: "Claude API key rejected" });
    expect(server.served).toBe(1);
  });

  it("other 4xx fail permanently with the API message", async () => {
    const { session } = start(new FakeX(), [{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad tool" } } }]);
    expect(await session.done).toEqual({ outcome: "failed", reason: "Claude API error (HTTP 400: invalid_request_error: bad tool)" });
  });

  it("enforces maxToolCalls: an error at the limit, then a hard stop", async () => {
    const x = new FakeX();
    const { session, server } = start(x, [msg(tool("read_page"))], { config: { maxToolCalls: 5 } });
    const r = await session.done;
    expect(r).toEqual({ outcome: "failed", reason: "Tool call limit exceeded (5 calls)" });
    expect(x.calls).toHaveLength(5);
    expect(lastUser(server.requests.at(-1)!).content[0].content[0].text).toMatch(/Tool call limit of 5 reached/);
  });

  it("enforces maxTaskMinutes", async () => {
    const x = new FakeX();
    const slow: BrowserCaller = { call: async (m, p) => (await new Promise((r) => setTimeout(r, 30)), x.handle(m, p)) };
    const { session } = start(x, [msg(tool("read_page"))], { config: { maxTaskMinutes: 0.002, maxToolCalls: 500 }, browser: slow });
    // 0.002 min = 120 ms; the loop keeps reading the page until the timer fires.
    const r = await session.done;
    expect(r).toEqual({ outcome: "failed", reason: "Task time limit of 0.002 minutes reached" });
  });

  it("abort resolves done with the given outcome and stops the loop", async () => {
    const x = new FakeX();
    let session!: ReturnType<typeof start>["session"];
    const r = start(x, [
      () => {
        session.abort("human took over", "paused");
        return msg(tool("read_page"));
      },
    ]);
    session = r.session;
    expect(await session.done).toEqual({ outcome: "paused", reason: "human took over" });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.server.served).toBe(1);
    expect(x.calls).toHaveLength(0);
    expect(r.events.filter((e: AgentEvent) => e.type === "task_end")).toHaveLength(1);
    // default outcome is failed
    const r2 = start(new FakeX(), [msg(tool("read_page"))]);
    r2.session.abort("stop");
    expect(await r2.session.done).toEqual({ outcome: "failed", reason: "stop" });
  });

  it("keeps only the newest screenshots in the history", async () => {
    const x = new FakeX();
    const { session, server } = start(x, [
      msg(tool("screenshot")),
      msg(tool("screenshot")),
      msg(tool("screenshot")),
      msg(tool("screenshot")),
      msg(tool("task_complete", { summary: "ok" })),
    ]);
    await session.done;
    const last = server.requests.at(-1)!;
    const images = JSON.stringify(last.body.messages).match(/"type":"image"/g) ?? [];
    expect(images).toHaveLength(3);
    expect(JSON.stringify(last.body.messages)).toContain("[older screenshot removed]");
  });

  it("uses the retry prompt when isRetry", async () => {
    const { session, server } = start(new FakeX(), [msg(tool("task_fail", { reason: "x" }))], { config: { isRetry: true } });
    await session.done;
    expect(server.requests[0]!.body.messages[0].content[0].text).toMatch(/this is a retry/);
  });
});

describe("startApiAgent: conversation (continueWith)", () => {
  it("sends no request after the turn's task_complete: nothing more is asked of the model until the next message", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server } = start(x, [msg(tool("read_page")), msg(tool("task_complete", { summary: "done" })), msg(text("Anything else?"))]);
    expect(await session.done).toEqual({ outcome: "done", summary: "done" });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.requests).toHaveLength(2);
  });

  it("a follow-up message continues the same history after task_complete", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [
      msg(tool("read_page")),
      msg(tool("task_complete", { summary: "first done" })),
      msg(text("On it."), tool("task_complete", { summary: "second done", url: "https://x.com/a/status/2" })),
    ]);
    expect(await session.done).toEqual({ outcome: "done", summary: "first done" });
    expect(session.continueWith).toBeTypeOf("function");

    const next = session.continueWith!("now do the second thing", { config: { ...CONFIG, maxToolCalls: 7 } });
    expect(next.sessionId).toBe("S1");
    expect(await next.done).toEqual({ outcome: "done", summary: "second done", url: "https://x.com/a/status/2" });

    // The third request carries the whole conversation: the first turn's task_complete is answered,
    // then the follow-up text, in one user message.
    const third = server.requests[2]!.body.messages;
    expect(third).toHaveLength(5);
    expect(third[0].content[0].text).toContain("Post: gm");
    const followUp = third[4];
    expect(followUp.role).toBe("user");
    expect(followUp.content[0]).toMatchObject({ type: "tool_result", tool_use_id: third[3].content[0].id });
    expect(followUp.content.at(-1)).toEqual({ type: "text", text: expect.stringMatching(/same conversation.*now do the second thing/), cache_control: { type: "ephemeral" } });
    // The user's message shows in the event stream, and each turn ends with its own task_end.
    expect(events.filter((e) => e.type === "user_message")).toEqual([{ type: "user_message", text: "now do the second thing" }]);
    expect(events.filter((e) => e.type === "task_end").map((e) => (e as { summary?: string }).summary)).toEqual(["first done", "second done"]);
  });

  it("an empty answer ends the turn without entering the history, so the next turn is still a valid request", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server } = start(x, [msg(), msg(tool("task_complete", { summary: "second done" }))]);
    expect(await session.done).toEqual({ outcome: "failed", reason: ENDED_WITHOUT_RESULT });
    expect(await session.continueWith!("try again").done).toEqual({ outcome: "done", summary: "second done" });
    const messages = server.requests[1]!.body.messages as { role: string; content: unknown[] }[];
    expect(messages.every((m) => m.content.length > 0)).toBe(true);
    // The task and the follow-up are one user message: roles still alternate.
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    expect(messages[0]!.content.at(-1)).toEqual({ type: "text", text: expect.stringMatching(/try again$/), cache_control: { type: "ephemeral" } });
  });

  it("after a stop, the next turn answers the tool calls that never ran", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    const inner = x.caller();
    // Stopped while the first of two tool calls runs.
    const browser: BrowserCaller = {
      call: async (method, params) => {
        const r = await inner.call(method, params);
        session.abort("stopped by user", "paused");
        return r;
      },
    };
    const r = start(x, [msg(tool("read_page"), tool("screenshot")), msg(tool("task_complete", { summary: "resumed" }))], { browser });
    session = r.session;
    expect(await session.done).toEqual({ outcome: "paused", reason: "stopped by user" });
    const next = session.continueWith!("carry on");
    expect(await next.done).toMatchObject({ outcome: "done", summary: "resumed" });
    const msgs = r.server.requests.at(-1)!.body.messages;
    expect(msgs).toHaveLength(3);
    const uses = msgs[1].content.filter((b: Block) => b.type === "tool_use");
    const answer = msgs[2].content;
    // Every tool_use has a result ("not run" for the ones the stop skipped), then the follow-up text.
    expect(answer.slice(0, 2).map((b: Block) => b.tool_use_id)).toEqual(uses.map((u: Block) => u.id));
    expect(answer[1].content[0].text).toMatch(/Not run/);
    expect(answer.at(-1).text).toContain("carry on");
  });

  it("a stop before Claude answered appends the follow-up to the pending user message", async () => {
    let session!: ReturnType<typeof start>["session"];
    const r = start(new FakeX(), [
      () => {
        queueMicrotask(() => session.abort("stopped by user", "paused"));
        return msg(tool("read_page"));
      },
      msg(tool("task_complete", { summary: "ok" })),
    ]);
    session = r.session;
    await session.done;
    await session.continueWith!("go on").done;
    const msgs = r.server.requests.at(-1)!.body.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content.map((b: Block) => b.type)).toEqual(["text", "text"]);
  });

  it("refuses a follow-up while a turn runs, and an empty one", async () => {
    const x = new FakeX();
    let session!: ReturnType<typeof start>["session"];
    let busy: unknown = null;
    const r = start(x, [
      () => {
        try {
          session.continueWith!("too early");
        } catch (e) {
          busy = e;
        }
        return msg(tool("task_fail", { reason: "nope" }));
      },
    ]);
    session = r.session;
    await session.done;
    expect(String(busy)).toMatch(/busy/);
    expect(() => session.continueWith!("  ")).toThrow(/empty/);
  });
});

describe("startApiAgent: reasoning (Fast, auto-raise, Thorough)", () => {
  const OFF = { type: "disabled" };
  const ADAPTIVE = { type: "adaptive" };

  it("Fast on Sonnet 5 sends thinking off; a tool failing 3 times in a row raises the next requests (with the note after the tool results) until a page-changing step works", async () => {
    const traces: TraceDraft[] = [];
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server } = start(
      x,
      [
        msg(tool("switch_tab", { tab: "t91" })),
        msg(tool("switch_tab", { tab: "t92" })),
        msg(tool("switch_tab", { tab: "t93" })),
        // Raised. Reading the page is no success: still raised for the next request.
        msg(tool("read_page")),
        msg(tool("navigate", { url: "https://x.com/home" })),
        msg(tool("task_complete", { summary: "done" })),
      ],
      { onTrace: (e) => traces.push(e) },
    );
    expect((await session.done).outcome).toBe("done");
    const bodies = server.requests.map((r) => r.body);
    expect(bodies.map((b) => b.thinking)).toEqual([OFF, OFF, OFF, ADAPTIVE, ADAPTIVE, OFF]);
    expect(bodies.map((b) => b.max_tokens)).toEqual([4096, 4096, 4096, THINKING_MAX_TOKENS, THINKING_MAX_TOKENS, 4096]);
    // The note follows the third failure's result, once; the history stays append-only.
    const note = raiseNote("switch_tab failed 3 times in a row");
    expect(lastUser(server.requests[3]!).content.at(-1)).toEqual({ type: "text", text: note, cache_control: { type: "ephemeral" } });
    expect(lastUser(server.requests[4]!).content.some((b: Block) => b.text === note)).toBe(false);
    expect(bodies[5].messages.flatMap((m: any) => m.content).filter((b: Block) => b.text === note)).toHaveLength(1);
    // The Raw view's lines, and each request's reasoning.
    expect(traces.filter((t) => t.name.startsWith("reasoning.")).map((t) => [t.name, t.data?.why])).toEqual([
      ["reasoning.raise", "switch_tab failed 3 times in a row"],
      ["reasoning.lower", "navigate worked"],
    ]);
    expect(traces.filter((t) => t.name === "model.call").map((t) => t.data?.reasoning)).toEqual(["fast", "fast", "fast", "raised", "raised", "fast"]);
  });

  it("the first task_fail of a Fast turn is answered with a recheck and raised; the second one ends the turn", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [msg(tool("task_fail", { reason: "cannot" })), msg(tool("task_fail", { reason: "still cannot" }))]);
    expect(await session.done).toEqual({ outcome: "failed", reason: "still cannot" });
    const answer = lastUser(server.requests[1]!).content[0];
    expect(answer).toMatchObject({ type: "tool_result", is_error: true, content: [{ type: "text", text: TASK_FAIL_RECHECK }] });
    expect(server.requests[1]!.body.thinking).toEqual(ADAPTIVE);
    // The refused call never ran: nothing in the conversation says it did.
    expect(events.filter((e: AgentEvent) => e.type === "tool_call" && e.name === "task_fail")).toHaveLength(1);
  });

  it("Thorough thinks on every request and never raises; auto-raise off never raises or rechecks", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const failing = () => [msg(tool("switch_tab", { tab: "t1" })), msg(tool("switch_tab", { tab: "t2" })), msg(tool("switch_tab", { tab: "t3" })), msg(tool("task_fail", { reason: "no" }))];
    const thorough = start(x, failing(), { config: { reasoning: "thorough" } });
    expect((await thorough.session.done).outcome).toBe("failed");
    expect(thorough.server.requests.map((r) => r.body.thinking)).toEqual([ADAPTIVE, ADAPTIVE, ADAPTIVE, ADAPTIVE]);
    const off = start(x, failing(), { config: { reasoningAutoRaise: false } });
    expect((await off.session.done).outcome).toBe("failed");
    expect(off.server.requests.map((r) => r.body.thinking)).toEqual([OFF, OFF, OFF, OFF]);
  });
});
