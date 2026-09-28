import { describe, expect, it } from "vitest";
import { MEMORY_WRITER_MAX_TOKENS, MEMORY_WRITER_MODEL, SESSION_HEADER } from "@noa/shared";
import { memorySummarizer, type SummarizerDeps } from "../../src/memory/summarizers.js";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function deps(reply: { status: number; body: unknown }, extra: Partial<SummarizerDeps> = {}): { deps: SummarizerDeps; calls: Call[]; helperCalls: unknown[] } {
  const calls: Call[] = [];
  const helperCalls: unknown[] = [];
  let connected = false;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return {
    calls,
    helperCalls,
    deps: {
      settings: async () => ({ anthropicApiKey: "user-key" }),
      hosted: () => ({ token: "session-token", apiBase: "https://api.example.test/" }),
      helper: {
        get connected() {
          return connected;
        },
        connect: async () => void (connected = true),
        call: async (method, params, opts) => {
          helperCalls.push({ method, params, opts, connected });
          return { text: "{}", costUsd: 0.002 };
        },
      },
      fetch: fetchFn,
      ...extra,
    },
  };
}

const OK = { status: 200, body: { id: "x", type: "message", role: "assistant", content: [{ type: "text", text: '{"episode":' }, { type: "text", text: "null}" }], stop_reason: "end_turn" } };
const req = { system: "SYS", prompt: "PROMPT", sessionId: "s1" };

describe("memorySummarizer", () => {
  it("Noa AI: the account's Messages proxy, the session token, the conversation's id, Haiku", async () => {
    const d = deps(OK);
    expect(await memorySummarizer("noa", d.deps)!(req)).toEqual({ text: '{"episode":null}' });
    const [c] = d.calls;
    expect(c!.url).toBe("https://api.example.test/v1/ai/messages");
    expect(c!.headers.authorization).toBe("Bearer session-token");
    expect(c!.headers[SESSION_HEADER]).toBe("s1");
    expect(c!.body).toMatchObject({ model: MEMORY_WRITER_MODEL, system: [{ type: "text", text: "SYS" }], messages: [{ role: "user", content: [{ type: "text", text: "PROMPT" }] }] });
  });

  it("Noa AI signed out, or out of credit: fails", async () => {
    await expect(memorySummarizer("noa", deps(OK, { hosted: () => null }).deps)!(req)).rejects.toThrow(/Not signed in/);
    await expect(memorySummarizer("noa", deps({ status: 402, body: { error: "out of credit" } }).deps)!(req)).rejects.toThrow();
  });

  it("Claude API: Anthropic with the user's key", async () => {
    const d = deps(OK);
    await memorySummarizer("claude-api", d.deps)!(req);
    expect(d.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(d.calls[0]!.headers["x-api-key"]).toBe("user-key");
    await expect(memorySummarizer("claude-api", deps(OK, { settings: async () => ({ anthropicApiKey: " " }) }).deps)!(req)).rejects.toThrow(/No Anthropic API key/);
    await expect(memorySummarizer("claude-api", deps({ status: 529, body: {} }).deps)!(req)).rejects.toThrow(/overloaded/);
  });

  it("Claude Code: the helper's memory.summarize, connecting it first", async () => {
    const d = deps(OK);
    expect(await memorySummarizer("claude-code", d.deps)!(req)).toEqual({ text: "{}", costUsd: 0.002 });
    expect(d.helperCalls).toEqual([{ method: "memory.summarize", params: { system: "SYS", prompt: "PROMPT" }, opts: { timeoutMs: expect.any(Number) }, connected: true }]);
  });

  it("a shorter answer when asked (chat titles), on both Messages paths; the writer's limit otherwise", async () => {
    const d = deps(OK);
    await memorySummarizer("noa", d.deps)!({ ...req, maxTokens: 40 });
    await memorySummarizer("claude-api", d.deps)!({ ...req, maxTokens: 40 });
    await memorySummarizer("claude-api", d.deps)!(req);
    expect(d.calls.map((c) => c.body.max_tokens)).toEqual([40, 40, MEMORY_WRITER_MAX_TOKENS]);
  });

  it("the scripted brain has none", () => {
    expect(memorySummarizer("scripted", deps(OK).deps)).toBeNull();
  });
});
