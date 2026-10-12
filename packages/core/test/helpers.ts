import type { AgentEvent, PageSnapshot, RunConfig } from "@noa/shared";
import type { JevDecision, JevLike } from "../src/types.js";

export const noSleep = async () => {};

/** A Jev that answers from a function of the goal and snapshot (or a fixed list, in order). */
export function fakeJev(
  answer: ((goal: string, snap: PageSnapshot) => JevDecision) | JevDecision[],
): JevLike & { goals: string[] } {
  const goals: string[] = [];
  let i = 0;
  return {
    goals,
    async decide({ goal, snapshot }) {
      goals.push(goal);
      if (typeof answer === "function") return answer(goal, snapshot);
      const d = answer[Math.min(i++, answer.length - 1)];
      if (!d) throw new Error("no more fake Jev answers");
      return d;
    },
  };
}

/** Jev that finds elements by a word in the goal: "composer" -> textbox, "post button" -> Post, "home" -> Home link. */
export const smartJev = (confidence = 0.95) =>
  fakeJev((goal, snap) => {
    const g = goal.toLowerCase();
    const find = (pred: (e: PageSnapshot["elements"][number]) => boolean) => snap.elements.find(pred)?.index ?? null;
    if (g.includes("type")) return { operation: "type", index: find((e) => e.testId === "tweetTextarea_0"), confidence };
    if (g.includes("post button")) return { operation: "click", index: find((e) => e.name === "Post" && e.role === "button"), confidence };
    if (g.includes("home")) return { operation: "click", index: find((e) => e.name === "Home"), confidence };
    return { operation: "blocked", index: null, confidence: 0.2 };
  });

export function collect() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => void events.push(e) };
}

export const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8, isRetry: false };

type Block = Record<string, any>;
/** One answer of the fake Messages server: a status and JSON body, or a thrown network error. */
export type FakeReply = { status?: number; body?: unknown; throws?: string; headers?: Record<string, string> };
/** A fixed reply, or one computed from the request body. */
export type FakeReplySource = FakeReply | ((body: any) => FakeReply);
export interface RecordedRequest {
  url: string;
  /** Header names lowercased. */
  headers: Record<string, string>;
  body: any;
}

/**
 * A fake Anthropic Messages endpoint (or the hosted AI's) over fetch: plays
 * the replies in order (the last one repeats) and records every request. A
 * streaming request that succeeds is answered with server-sent events, like
 * the real API.
 */
export function fakeMessagesServer(replies: FakeReplySource[]) {
  const requests: RecordedRequest[] = [];
  let served = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    // Answer asynchronously, like a real server (and so reply functions can use the session).
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse(String(init?.body));
    // Snapshot the request: the agent mutates its message list afterwards.
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    requests.push({ url: String(url), headers, body: structuredClone(body) });
    const next = replies[Math.min(served++, replies.length - 1)]!;
    const r = typeof next === "function" ? next(body) : next;
    if (r.throws) throw new TypeError(r.throws);
    const status = r.status ?? 200;
    if (body.stream === true && status === 200) return new Response(messageSse(r.body as MessageShape), { status, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/json", ...r.headers } });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    get served() {
      return served;
    },
  };
}

type MessageShape = { id: string; content: Block[]; stop_reason: string | null };

/** A message as the Messages API streams it: text in small deltas, tool input in input_json_delta parts. */
export function messageSseEvents(m: MessageShape): [string, unknown][] {
  const out: [string, unknown][] = [["message_start", { type: "message_start", message: { ...m, content: [], stop_reason: null } }], ["ping", { type: "ping" }]];
  m.content.forEach((b, index) => {
    if (b.type === "text") {
      out.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      for (const part of (b.text as string).match(/.{1,5}/gs) ?? []) out.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } }]);
    } else if (b.type === "tool_use") {
      out.push(["content_block_start", { type: "content_block_start", index, content_block: { ...b, input: {} } }]);
      const json = JSON.stringify(b.input ?? {});
      const cut = Math.floor(json.length / 2);
      for (const part of [json.slice(0, cut), json.slice(cut)]) out.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } }]);
    } else {
      out.push(["content_block_start", { type: "content_block_start", index, content_block: b }]);
    }
    out.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  out.push(["message_delta", { type: "message_delta", delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }], ["message_stop", { type: "message_stop" }]);
  return out;
}

export const messageSse = (m: MessageShape) =>
  messageSseEvents(m)
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

/** A Messages reply whose only block calls task_complete. */
export const TASK_COMPLETE_REPLY: FakeReply = {
  status: 200,
  body: { id: "m1", type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "task_complete", input: { summary: "done" } }] },
};
