import { describe, expect, it } from "vitest";
import {
  buildMemoryWriterPrompt,
  CLAUDE_MODELS,
  episodeTranscript,
  MAX_MEMORY_ENTITIES,
  MAX_MEMORY_TEXT_CHARS,
  MAX_WRITER_FACTS,
  MEMORY_WRITER_MODEL,
  MEMORY_WRITER_SYSTEM_PROMPT,
  parseMemoryWriterAnswer,
  writerFactKinds,
  type TranscriptLine,
} from "../src/index.js";

describe("memory writer model", () => {
  it("is Haiku from the catalog", () => {
    expect(CLAUDE_MODELS.some((m) => m.id === MEMORY_WRITER_MODEL)).toBe(true);
    expect(MEMORY_WRITER_MODEL).toMatch(/^claude-haiku/);
  });

  it("the system prompt forbids invented dates and secrets", () => {
    expect(MEMORY_WRITER_SYSTEM_PROMPT).toMatch(/never invent a date/);
    expect(MEMORY_WRITER_SYSTEM_PROMPT).toMatch(/Never write passwords, one-time codes/);
  });
});

describe("episodeTranscript", () => {
  const lines: TranscriptLine[] = [
    { who: "user", text: "Check the booking HM4K2ZQ9 on channex" },
    { who: "action", text: "navigate app.channex.io/bookings" },
    { who: "agent", text: "  The booking   is confirmed.  " },
    { who: "outcome", text: "done: confirmed" },
  ];

  it("labels each line and collapses whitespace", () => {
    expect(episodeTranscript(lines)).toBe(
      ["User: Check the booking HM4K2ZQ9 on channex", "Did: navigate app.channex.io/bookings", "Agent: The booking is confirmed.", "Outcome: done: confirmed"].join("\n"),
    );
  });

  it("keeps the first request and the newest lines when it is too long", () => {
    const many: TranscriptLine[] = [{ who: "user", text: "first request" }, ...Array.from({ length: 50 }, (_, i) => ({ who: "action" as const, text: `step ${i}` }))];
    const out = episodeTranscript(many, 120);
    expect(out.length).toBeLessThanOrEqual(120 + 40);
    expect(out.startsWith("User: first request\n[… ")).toBe(true);
    expect(out.endsWith("Did: step 49")).toBe(true);
  });

  it("redacts secrets and drops empty lines", () => {
    const out = episodeTranscript([{ who: "user", text: "use key sk-ant-abcdefghijklmnop" }, { who: "agent", text: "   " }]);
    expect(out).toBe("User: use key [redacted]");
  });
});

describe("buildMemoryWriterPrompt", () => {
  it("gives the dates, the transcript and the entries not to repeat", () => {
    const prompt = buildMemoryWriterPrompt({
      kind: "task",
      title: "Post the daily tip",
      startedAt: "2026-09-26T08:00:00.000Z",
      endedAt: "2026-09-26T08:05:00.000Z",
      lines: [{ who: "user", text: "Post one tip" }],
      existing: [{ id: "m1", kind: "account", subject: "Work email", text: "admin@runhq.io" }],
    });
    expect(prompt).toContain('A task run: "Post the daily tip"');
    expect(prompt).toContain("Started: 2026-09-26T08:00:00.000Z. Last ended: 2026-09-26T08:05:00.000Z");
    expect(prompt).toContain("<conversation>\nUser: Post one tip\n</conversation>");
    expect(prompt).toContain("[m1] account Work email: admin@runhq.io");
  });

  it("says when memory is empty", () => {
    expect(buildMemoryWriterPrompt({ kind: "chat", title: "x", startedAt: "2026-01-01", lines: [], existing: [] })).toContain("(nothing)");
  });
});

describe("parseMemoryWriterAnswer", () => {
  const answer = {
    episode: { subject: "Checked booking HM4K2ZQ9", text: "The user asked to check a booking; it was confirmed.", entities: ["https://www.app.channex.io/bookings/1", "HM4K2ZQ9"] },
    facts: [{ kind: "playbook", subject: "Bookings list", text: "Bookings are at /bookings", domain: "app.channex.io" }],
  };

  it("reads plain JSON, fenced JSON and JSON after prose", () => {
    const want = {
      episode: { subject: "Checked booking HM4K2ZQ9", text: answer.episode.text, entities: ["app.channex.io", "HM4K2ZQ9"] },
      facts: [answer.facts[0]],
    };
    expect(parseMemoryWriterAnswer(JSON.stringify(answer))).toEqual(want);
    expect(parseMemoryWriterAnswer("```json\n" + JSON.stringify(answer, null, 2) + "\n```")).toEqual(want);
    expect(parseMemoryWriterAnswer(`Here is the memory:\n${JSON.stringify(answer)}\nThanks {not json}`)).toEqual(want);
  });

  it("keeps braces inside strings", () => {
    const a = { episode: { subject: "Set {x}", text: 'Wrote "}" into the form', entities: [] }, facts: [] };
    expect(parseMemoryWriterAnswer(JSON.stringify(a)).episode).toEqual(a.episode);
  });

  it("episode null and no facts", () => {
    expect(parseMemoryWriterAnswer('{"episode": null, "facts": []}')).toEqual({ episode: null, facts: [] });
    expect(parseMemoryWriterAnswer('{"episode": null}')).toEqual({ episode: null, facts: [] });
  });

  it("cuts over-long text, caps entities and facts, drops malformed facts", () => {
    const long = "word ".repeat(200);
    const facts = [
      { kind: "task", subject: "Run", text: "not a writer kind" },
      { kind: "person", subject: "", text: "no subject" },
      ...Array.from({ length: 5 }, (_, i) => ({ kind: "preference", subject: `P${i}`, text: "calm tone", domain: null, replaces: "" })),
    ];
    const out = parseMemoryWriterAnswer(JSON.stringify({ episode: { subject: "S", text: long, entities: Array.from({ length: 30 }, (_, i) => `E${i}`) }, facts }));
    expect(out.episode!.text.length).toBeLessThanOrEqual(MAX_MEMORY_TEXT_CHARS);
    expect(out.episode!.text.endsWith("…")).toBe(true);
    expect(out.episode!.entities).toHaveLength(MAX_MEMORY_ENTITIES);
    expect(out.facts).toHaveLength(MAX_WRITER_FACTS);
    expect(out.facts[0]).toEqual({ kind: "preference", subject: "P0", text: "calm tone" });
  });

  it("a malformed episode is null, the facts stay", () => {
    expect(parseMemoryWriterAnswer('{"episode": {"text": "no subject"}, "facts": [{"kind":"person","subject":"Paul Lee","text":"accountant"}]}')).toEqual({
      episode: null,
      facts: [{ kind: "person", subject: "Paul Lee", text: "accountant" }],
    });
  });

  it("throws when there is no JSON object, or it is cut off", () => {
    expect(() => parseMemoryWriterAnswer("I cannot help with that.")).toThrow(/no JSON object/);
    expect(() => parseMemoryWriterAnswer('{"episode": {"subject": "x"')).toThrow(/cut off/);
  });
});

describe("writerFactKinds", () => {
  it("leaves out the kinds the user turned off", () => {
    expect(writerFactKinds(["person", "episode"])).toEqual(["preference", "account", "playbook"]);
  });
});
