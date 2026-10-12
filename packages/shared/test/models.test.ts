/** The model catalog: its prices and the model menu's hints built from them. */
import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS, DEFAULT_MODEL, modelHint } from "../src/models.js";

describe("model hints", () => {
  it("say whether the model always thinks first and its price relative to the default model", () => {
    expect(modelHint("claude-sonnet-5")).toBe("Faster · default price");
    expect(modelHint("claude-opus-5-5")).toBe("Thinks first, slower · 2× price");
    expect(modelHint("claude-fable-5-1")).toBe("Thinks first, slower · 5× price");
    expect(modelHint("claude-haiku-4-5")).toBe("Faster · ½ price");
    expect(modelHint("claude-custom-9")).toBeNull();
  });

  it("one ratio holds for input and output tokens of every model (else the hint would mislead)", () => {
    const base = CLAUDE_MODELS.find((m) => m.id === DEFAULT_MODEL)!.price;
    for (const m of CLAUDE_MODELS) expect(m.price.input / base.input).toBe(m.price.output / base.output);
  });
});
