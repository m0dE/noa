import { describe, expect, it } from "vitest";
import { toolsFor } from "@noa/shared";
import { buildSystemPrompt } from "../src/prompts.js";

describe("the system prompt on OpenCode (the Local model)", () => {
  it("lists the tools by the names the model has (noa_<name>) and says what OpenCode adds", () => {
    const p = buildSystemPrompt({ tools: toolsFor(), jev: false, opencode: true });
    expect(p).toMatch(/^- noa_read_page: /m);
    expect(p).toMatch(/^- noa_task_complete: /m);
    expect(p).toContain("task_complete is noa_task_complete");
    expect(p).toMatch(/websearch \(search the web\), webfetch .* and skill .*; no shell or file access/);
    expect(p).not.toContain("You have no shell, file or web access");
  });

  it("Claude Code's is unchanged", () => {
    const p = buildSystemPrompt({ tools: toolsFor(), jev: false });
    expect(p).toMatch(/^- read_page: /m);
    expect(p).toContain("in Claude Code they are named mcp__noa__<name>");
    expect(p).toContain("You have no shell, file or web access other than these tools");
    expect(p).not.toMatch(/^- noa_/m);
    expect(p).not.toContain("noa_task_complete");
  });
});
