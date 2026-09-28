/** The Noa hosted AI: startApiAgent with a custom endpoint and bearer auth, 402 handling, and Jev through the proxy. */
import { describe, expect, it, vi } from "vitest";
import { startApiAgentWith } from "../src/api-agent.js";
import { HOSTED_AI_UNAVAILABLE, HOSTED_AI_UNAVAILABLE_CODE, OUT_OF_CREDIT } from "@noa/shared";
import { OutOfCreditError } from "../src/api-errors.js";
import { createJev } from "../src/jev.js";
import type { ApiAgentOptions } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { CONFIG, collect, fakeMessagesServer, noSleep, TASK_COMPLETE_REPLY as done, type FakeReply } from "./helpers.js";

function hosted(replies: FakeReply[], extra: Partial<ApiAgentOptions> = {}) {
  const s = fakeMessagesServer(replies);
  const { events, onEvent } = collect();
  const x = new FakeX({ url: "https://example.com/" });
  const session = startApiAgentWith(
    {
      sessionId: "S9",
      apiKey: "bt_s_token",
      model: "claude-sonnet-5",
      task: { id: "T", instructions: "say hi", account: null },
      mediaPaths: [],
      config: CONFIG,
      browser: x.caller(),
      jev: null,
      onEvent,
      fetch: s.fetchImpl,
      baseUrl: "https://api.test/v1/ai/",
      auth: "bearer",
      headers: { "X-Noa-Session": "S9" },
      label: "Noa AI",
      ...extra,
    },
    { sleep: noSleep, retryDelaysMs: [] },
  );
  return { session, requests: s.requests, events };
}

describe("hosted AI transport", () => {
  it("posts to ${baseUrl}/messages with the session token as a bearer and the session header", async () => {
    const { session, requests, events } = hosted([done]);
    expect(await session.done).toMatchObject({ outcome: "done" });
    const req = requests[0]!;
    expect(req.url).toBe("https://api.test/v1/ai/messages");
    expect(req.headers).toMatchObject({ authorization: "Bearer bt_s_token", "x-noa-session": "S9", "content-type": "application/json" });
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    // The body is a plain Anthropic Messages request.
    expect(req.body).toMatchObject({ model: "claude-sonnet-5", max_tokens: 4096 });
    expect(events[0]).toEqual({ type: "status", text: "Noa AI (claude-sonnet-5)" });
  });

  it("402 out_of_credit pauses the turn with OUT_OF_CREDIT and reports the top-up link once", async () => {
    const onOutOfCredit = vi.fn();
    const { session, requests, events } = hosted(
      [{ status: 402, body: { error: "out_of_credit", message: "No usage credit left", topupUrl: "https://dash.test/billing" } }],
      { onOutOfCredit },
    );
    expect(await session.done).toEqual({ outcome: "paused", reason: OUT_OF_CREDIT });
    expect(OUT_OF_CREDIT).toBe("Out of usage credit");
    expect(requests).toHaveLength(1); // not retried
    expect(onOutOfCredit).toHaveBeenCalledTimes(1);
    expect(onOutOfCredit).toHaveBeenCalledWith({ message: "Out of usage credit: No usage credit left", topupUrl: "https://dash.test/billing" });
    expect(events).toContainEqual({ type: "error", text: "Out of usage credit: No usage credit left" });
  });

  it("an expired session (401) fails with a sign-in reason, not the API-key one", async () => {
    const { session } = hosted([{ status: 401, body: { error: "invalid or expired session" } }]);
    const r = await session.done;
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/^Noa AI rejected the sign-in \(HTTP 401: invalid or expired session\)/);
  });

  it("502 hosted_ai_unavailable (the server's own AI credentials refused) fails at once with the plain reason", async () => {
    const body = { error: HOSTED_AI_UNAVAILABLE_CODE, message: "Noa AI is temporarily unavailable. Try again later, or use your own Claude in Settings." };
    const { session, requests, events } = hosted([{ status: 502, body }], { label: "Noa AI" });
    expect(await session.done).toEqual({ outcome: "failed", reason: HOSTED_AI_UNAVAILABLE });
    expect(requests).toHaveLength(1); // retrying cannot help
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", text: HOSTED_AI_UNAVAILABLE }]);
  });

  it("server errors from the proxy are retried as transient with the proxy's label", async () => {
    const { session, requests } = hosted([{ status: 503, body: { error: "upstream" } }]);
    const r = await session.done;
    expect(r.outcome).toBe("retry");
    expect(r.reason).toMatch(/Noa AI server error \(HTTP 503: upstream\)/);
    expect(requests).toHaveLength(1);
  });
});

describe("createJev through the Noa proxy", () => {
  const snapshot = {
    url: "https://example.com",
    title: "t",
    text: "",
    truncated: false,
    elements: [{ index: 0, tag: "button", role: "button", name: "Go", inViewport: true }],
  };

  it("posts { state, questions } with the bearer token and extra headers, and reads { answers }", async () => {
    const s = fakeMessagesServer([
      { status: 200, body: { answers: { operation: { choice: "click", confidence: 0.9 }, target: { choice: "0", confidence: 0.95 } }, usage: {} } },
    ]);
    const jev = createJev("bt_s_token", { fetch: s.fetchImpl, endpoint: "https://api.test/v1/ai/jev", headers: { "X-Noa-Session": "S1" } });
    expect(await jev.decide({ goal: "click Go", snapshot })).toEqual({ operation: "click", index: 0, confidence: 0.9 });
    const req = s.requests[0]!;
    expect(req.url).toBe("https://api.test/v1/ai/jev");
    expect(req.headers).toMatchObject({ authorization: "Bearer bt_s_token", "x-noa-session": "S1" });
    expect(Object.keys(req.body).sort()).toEqual(["questions", "state"]);
    expect(req.body.state.goal).toBe("click Go");
  });

  it("402 throws OutOfCreditError with the top-up link", async () => {
    const s = fakeMessagesServer([{ status: 402, body: { error: "out_of_credit", message: "No usage credit left", topupUrl: "https://dash.test/billing" } }]);
    const jev = createJev("t", { fetch: s.fetchImpl, endpoint: "https://api.test/v1/ai/jev" });
    const err = await jev.decide({ goal: "g", snapshot }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutOfCreditError);
    expect((err as OutOfCreditError).message).toBe("Out of usage credit: No usage credit left");
    expect((err as OutOfCreditError).topupUrl).toBe("https://dash.test/billing");
  });

  it("a machine code with a message reads as the message", async () => {
    const s = fakeMessagesServer([{ status: 502, body: { error: HOSTED_AI_UNAVAILABLE_CODE, message: "Noa AI is temporarily unavailable." } }]);
    const jev = createJev("t", { fetch: s.fetchImpl, endpoint: "https://api.test/v1/ai/jev" });
    await expect(jev.decide({ goal: "g", snapshot })).rejects.toThrow("Jev HTTP 502: Noa AI is temporarily unavailable.");
  });

  it("other errors name the status", async () => {
    const s = fakeMessagesServer([{ status: 500, body: { error: "boom" } }]);
    const jev = createJev("t", { fetch: s.fetchImpl, endpoint: "https://api.test/v1/ai/jev" });
    await expect(jev.decide({ goal: "g", snapshot })).rejects.toThrow("Jev HTTP 500: boom");
  });
});
