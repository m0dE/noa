import { describe, expect, it } from "vitest";
import type { TraceDraft } from "@noa/shared";
import { createToolExecutor, SecretRedactor } from "../src/index.js";
import { REDACTED } from "../src/redact.js";
import { FakeX } from "./fake-x.js";
import { collect, fakeJev, noSleep, smartJev } from "./helpers.js";
import type { JevLike } from "../src/types.js";

function traced(x: FakeX, jev: JevLike | null = null, secrets?: SecretRedactor) {
  const { onEvent } = collect();
  const traces: TraceDraft[] = [];
  const exec = createToolExecutor({ browser: x.caller(), jev, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep, onTrace: (e) => traces.push(e), ...(secrets ? { secrets } : {}) });
  return { exec, traces };
}

describe("tool executor timing trace", () => {
  it("one span per tool call: name, id, clipped arguments, duration and the size of what it returned", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec, traces } = traced(x);
    await exec.call("read_page", {});
    await exec.call("paste", { text: "p".repeat(2000) });
    await exec.call("click", { index: 9999 });
    const tools = traces.filter((e) => e.name === "tool");
    expect(tools.map((e) => e.data?.tool)).toEqual(["read_page", "paste", "click"]);
    expect(tools.map((e) => e.data?.id)).toEqual(["t1", "t2", "t3"]);
    for (const e of tools) {
      expect(e.cat).toBe("tool");
      expect(typeof e.ms).toBe("number");
      expect(typeof e.t).toBe("number");
    }
    expect(tools[0]!.data!.chars).toBeGreaterThan(50);
    expect(String(tools[1]!.data!.args).length).toBeLessThanOrEqual(300);
    expect(tools[2]!.data).toMatchObject({ error: true });
  });

  it("act: one span per step with its parts (page read, Jev pick with ms and confidence, action and settle)", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec, traces } = traced(x, smartJev());
    await exec.call("act", { steps: [{ goal: "type the post text into the composer", text: "gm" }, { goal: "click the post button" }] });
    const steps = traces.filter((e) => e.name === "act.step");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ cat: "act", data: { step: 1, picker: "jev", operation: "type", ran: true, goal: "type the post text into the composer" } });
    for (const s of steps) {
      expect(typeof s.data!.jevMs).toBe("number");
      expect(typeof s.data!.confidence).toBe("number");
      expect(typeof s.data!.readMs).toBe("number");
      expect(typeof s.data!.performMs).toBe("number");
    }
    // Steps are inside the act tool's span, which comes last.
    expect(traces.at(-1)).toMatchObject({ name: "tool", data: { tool: "act" } });
  });

  it("a step Jev is unsure about is traced as not run", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec, traces } = traced(x, fakeJev([{ operation: "click", index: 1, confidence: 0.3 }]));
    await exec.call("act", { steps: [{ goal: "open something" }] });
    expect(traces.find((e) => e.name === "act.step")).toMatchObject({ data: { ran: false, picker: "jev", confidence: 0.3 } });
  });

  it("passwords the agent was given never reach the trace (the same redaction as events)", async () => {
    const x = new FakeX({ credentials: { "example.com": { username: "u", password: "s3cret-pw" } } });
    const { exec, traces } = traced(x, null, new SecretRedactor());
    await exec.call("get_credential", { site: "example.com" });
    await exec.call("type", { index: 2, text: "s3cret-pw" });
    await exec.call("act", { steps: [{ goal: "type the password", index: 2, text: "s3cret-pw" }] });
    const json = JSON.stringify(traces);
    expect(json).not.toContain("s3cret-pw");
    expect(json).toContain(REDACTED);
  });
});
