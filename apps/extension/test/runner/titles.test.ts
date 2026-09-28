/**
 * Chat titles through the runner: a chat starts titled with its request cleaned, and each turn's end has the title
 * model name it (chat-titles.ts); a TODO run keeps its task's instructions, and its series is named once.
 */
import { describe, expect, it } from "vitest";
import { ChatTitler } from "../../src/engine/chat-titles.js";
import { Runner } from "../../src/engine/runner.js";
import type { Summarize } from "../../src/memory/summarizers.js";
import { harness, setupRunnerTests } from "./harness.js";

setupRunnerTests();

function withTitles(answer = "Check Chrome Web Store emails") {
  const h = harness();
  const prompts: string[] = [];
  const summarize: Summarize = async (req) => (prompts.push(req.prompt), { text: answer });
  const titles = new ChatTitler({ sessions: h.sessions, summarizer: () => summarize, log: () => {} });
  h.runner = new Runner({ ...h.deps, titles });
  return { h, titles, prompts };
}

describe("Runner: chat titles", () => {
  it("a spoken chat starts titled with its request, not the small talk; its turn's end has the model name it", async () => {
    const { h, titles, prompts } = withTitles();
    const { sessionId } = await h.runner.message(undefined, "Yo sup how you doin. Can you check my chrome web store emails?", { voice: true });
    const first = (await h.sessions.get(sessionId))!;
    expect(first.title).toBe("Check my chrome web store emails");
    await h.runner.idle();
    await titles.run();
    expect(await h.sessions.get(sessionId)).toMatchObject({ title: "Check Chrome Web Store emails", titleBy: "model", titledTurn: 1 });
    expect(prompts[0]).toContain("check my chrome web store emails");
  });

  it("a TODO run keeps its task's instructions (a later turn reads them there); the title model names its series", async () => {
    const { h, titles, prompts } = withTitles("Post the daily X tip");
    const task = await h.store.add({ instructions: "so can you post the daily tip on X", account: null });
    await h.runner.runTask(task.id);
    await h.runner.idle();
    await titles.run();
    const [s] = await h.sessions.list(5);
    expect(s).toMatchObject({ instructions: "so can you post the daily tip on X", title: "Post the daily X tip", titleBy: "model" });
    expect(prompts).toHaveLength(1);
  });
});
