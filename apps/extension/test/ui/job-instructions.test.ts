import { describe, expect, it } from "vitest";
import { MAX_INSTRUCTIONS_CHARS } from "@noa/shared";
import { editable, instructionsProblem } from "../../src/sidepanel/job-instructions.js";

describe("a task's instructions on its page", () => {
  it("can be edited while the task waits; while a run goes on, once it ends; else not (nothing will run)", () => {
    expect(editable({ status: "pending" })).toBe("yes");
    expect(editable({ status: "paused" })).toBe("yes");
    expect(editable({ status: "running" })).toBe("later");
    for (const status of ["done", "failed", "cancelled"] as const) expect(editable({ status })).toBe("no");
  });

  it("a new text must say something, within the API's length", () => {
    expect(instructionsProblem("  \n ")).toBe("Write what the job should do.");
    expect(instructionsProblem("Post a tip")).toBe("");
    expect(instructionsProblem(`  ${"x".repeat(MAX_INSTRUCTIONS_CHARS)}  `)).toBe("");
    expect(instructionsProblem("x".repeat(MAX_INSTRUCTIONS_CHARS + 1))).toMatch(/^At most 8,000 characters \(now 8,001\)\.$/);
  });
});
