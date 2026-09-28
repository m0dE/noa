/**
 * Prompt caching: the tools and the system prompt carry a breakpoint each, and the conversation one on its last
 * cacheable block, so each request reads the one before it from the cache instead of resending the growing
 * history uncached (a production run on Opus 5.5 cost $9.88 with up to 101k uncached input tokens per call).
 */
import { describe, expect, it } from "vitest";
import { buildRequest, withConversationCache, type MessageParam } from "../src/anthropic.js";
import { startApiAgentWith } from "../src/api-agent.js";
import { FakeX } from "./fake-x.js";
import { CONFIG, collect, fakeMessagesServer, noSleep, TASK_COMPLETE_REPLY as done } from "./helpers.js";

const EPHEMERAL = { type: "ephemeral" };

/** Every cache_control in a request body, by where it sits. */
function breakpoints(body: any): string[] {
  const at: string[] = [];
  body.tools.forEach((t: any, i: number) => t.cache_control && at.push(`tools[${i}]`));
  body.system.forEach((b: any, i: number) => b.cache_control && at.push(`system[${i}]`));
  body.messages.forEach((m: any, i: number) => m.content.forEach((b: any, j: number) => b.cache_control && at.push(`messages[${i}][${j}]`)));
  return at;
}

describe("withConversationCache", () => {
  const history: MessageParam[] = [
    { role: "user", content: [{ type: "text", text: "do it" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "read_page", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "page" }] }, { type: "text", text: "note" }] },
  ];

  it("marks the last block of the last message, on a copy (the history stays unmarked)", () => {
    const before = structuredClone(history);
    const marked = withConversationCache(history);
    expect(marked.at(-1)!.content.at(-1)).toEqual({ type: "text", text: "note", cache_control: EPHEMERAL });
    expect(marked.slice(0, -1)).toEqual(history.slice(0, -1));
    expect(history).toEqual(before);
  });

  it("skips blocks a breakpoint may not sit on, and leaves a conversation without a cacheable block as it is", () => {
    const thinkingLast: MessageParam[] = [{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "", signature: "s" }] }];
    expect(withConversationCache(thinkingLast)[0]!.content).toEqual([{ type: "text", text: "a", cache_control: EPHEMERAL }, thinkingLast[0]!.content[1]]);
    const onlyThinking: MessageParam[] = [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] }];
    expect(withConversationCache(onlyThinking)).toBe(onlyThinking);
    expect(withConversationCache([])).toEqual([]);
  });

  it("buildRequest: tools, system and the conversation's last block, 3 of the 4 breakpoints allowed", () => {
    const body = buildRequest({ model: "claude-opus-5-5", system: "sys", tools: ["read_page", "task_complete"], messages: history });
    expect(breakpoints(body)).toEqual(["tools[1]", "system[0]", "messages[2][1]"]);
  });
});

describe("the agent loop (both brains build requests with buildRequest)", () => {
  it("moves the one conversation breakpoint to the newest block on every request", async () => {
    const x = new FakeX({ url: "https://example.com/" });
    const tool = (name: string, id: string) => ({ type: "tool_use", id, name, input: {} });
    const server = fakeMessagesServer([
      { status: 200, body: { id: "m1", type: "message", role: "assistant", content: [tool("read_page", "a")], stop_reason: "tool_use" } },
      { status: 200, body: { id: "m2", type: "message", role: "assistant", content: [tool("screenshot", "b")], stop_reason: "tool_use" } },
      done,
    ]);
    const { onEvent } = collect();
    const session = startApiAgentWith(
      { sessionId: "S", apiKey: "sk", model: "claude-opus-5-5", task: { id: "T", instructions: "look", account: null }, mediaPaths: [], config: CONFIG, browser: x.caller(), jev: null, onEvent, fetch: server.fetchImpl },
      { sleep: noSleep },
    );
    await session.done;
    const bodies = server.requests.map((r) => r.body);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      const last = body.messages.length - 1;
      expect(breakpoints(body)).toEqual([`tools[${body.tools.length - 1}]`, "system[0]", `messages[${last}][${body.messages[last].content.length - 1}]`]);
    }
  });
});
