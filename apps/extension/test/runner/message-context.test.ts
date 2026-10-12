/**
 * A message's context (hands-free voice: the note on the tab the user looks at) goes to the agent with the
 * message, and never into what the chat shows as the user's words: the conversation's title and first message,
 * its user_message events. (Reported on 81df820: the note made the message differ from the words the narrator
 * passed on, so the chat showed the request as a second bubble.)
 */
import { describe, expect, it, vi } from "vitest";
import { withContext } from "../../src/engine/run/jobs.js";
import { harness, setupRunnerTests, withoutClock } from "./harness.js";

setupRunnerTests();

const NOTE = "The user is looking at another tab: Recipes (recipes.example). You work in Inbox (mail.example.com).";

const userMessages = async (h: ReturnType<typeof harness>, sessionId: string) =>
  (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text);

describe("Runner: a message's context", () => {
  it("is appended in parentheses for the agent; no context, the words alone", () => {
    expect(withContext("What is on this page?", NOTE)).toBe(`What is on this page?\n\n(${NOTE})`);
    expect(withContext("What is on this page?", undefined)).toBe("What is on this page?");
  });

  it("a new conversation: the agent's task has it, the title and first message do not", async () => {
    const h = harness();
    h.brain.script = () => ({ outcome: "done", summary: "ok" });
    const { sessionId } = await h.runner.message(undefined, "What is on this page?", { voice: true, context: NOTE });
    await h.runner.idle();
    expect(h.brain.starts[0]!.task.instructions).toBe(withContext("What is on this page?", NOTE));
    const s = (await h.sessions.get(sessionId))!;
    expect(s.instructions).toBe("What is on this page?");
    // The title is the request, cleaned (chat-title.ts): no trailing punctuation.
    expect(s.title).toBe("What is on this page");
  });

  it("a message into the running turn: the agent gets it with the context, the chat keeps the words once", async () => {
    const h = harness();
    h.brain.script = (_o, ctl) => {
      void vi.waitFor(() => expect(ctl.said).toHaveLength(1)).then(() => ctl.resolve({ outcome: "done", summary: "ok" }));
      return "hang";
    };
    const { sessionId } = await h.runner.message(undefined, "Write a note");
    await vi.waitFor(() => expect(h.brain.ctls).toHaveLength(1));
    expect(await h.runner.message(sessionId, "and make it short", { voice: true, context: NOTE })).toEqual({ sessionId, mode: "inject" });
    await h.runner.idle();
    await h.sessions.flush();
    expect(h.brain.ctls[0]!.said).toEqual([withContext("and make it short", NOTE)]);
    expect(await userMessages(h, sessionId)).toEqual(["and make it short"]);
  });

  it("the next turn: the agent's message has it, the turn's user_message is the words", async () => {
    const h = harness();
    h.brain.script = () => ({ outcome: "done", summary: "first" });
    const { sessionId } = await h.runner.message(undefined, "Read the page");
    await h.runner.idle();
    h.brain.continueScript = () => ({ outcome: "done", summary: "second" });
    await h.runner.message(sessionId, "open the first link", { voice: true, context: NOTE });
    await h.runner.idle();
    await h.sessions.flush();
    expect(withoutClock(h.brain.continues[0]!.text)).toContain(withContext("open the first link", NOTE));
    expect(await userMessages(h, sessionId)).toEqual(["open the first link"]);
  });
});
