import { describe, expect, it } from "vitest";
import { createToolExecutor } from "@noa/core";
import { ToolRouter } from "../src/tool-router.js";
import { INTERACTIVE_TASK_ID } from "../src/mcp-tools.js";
import { FakeX } from "./fake-x.js";

describe("ToolRouter", () => {
  it("routes by task id, refuses unknown tasks and tools, and serves the interactive executor", async () => {
    const x = new FakeX();
    const interactiveExec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [] });
    const router = new ToolRouter({
      getSession: () => null,
      getInteractive: () => ({ allowedTools: new Set(["read_page", "task_complete"]), executor: interactiveExec }),
    });
    expect((await router.call("S9", "read_page", {})).text).toMatch(/No running task S9/);
    expect((await router.call(INTERACTIVE_TASK_ID, "read_page", {})).text).toContain("URL:");
    expect((await router.call(INTERACTIVE_TASK_ID, "click", { index: 1 })).text).toMatch(/not available in an attached session/);
    // task_* in interactive mode: the executor has no onTaskEnd
    expect((await router.call(INTERACTIVE_TASK_ID, "task_complete", { summary: "x" })).text).toMatch(/no task to end in an attached session/);
    expect(router.allowedTools(INTERACTIVE_TASK_ID)).toEqual(["read_page", "task_complete"]);
  });
});
