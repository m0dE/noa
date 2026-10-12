import { describe, expect, it } from "vitest";
import { autoHideMs, NOTICE_HIDE_MS, NoticeQueue, type QueuedNotice } from "../../src/sidepanel/notice-queue.js";

type N = QueuedNotice & { text: string };
const note = (key: string, level: N["level"], text = key, more: Partial<N> = {}): N => ({ key, level, text, ...more });
const shown = (q: NoticeQueue<N>) => q.current?.text ?? null;

describe("NoticeQueue: one notice above the input at a time", () => {
  it("shows nothing until a notice comes", () => {
    const q = new NoticeQueue<N>();
    expect(q.current).toBeNull();
    expect(q.size).toBe(0);
  });

  it("an error goes before info, whatever the order they came in", () => {
    const q = new NoticeQueue<N>();
    q.put(note("voice", "info", "Microphone allowed. Press the mic to talk."));
    expect(shown(q)).toBe("Microphone allowed. Press the mic to talk.");
    q.put(note("composer", "error", "Out of usage credit"));
    expect(shown(q)).toBe("Out of usage credit");
    // Dismissed, the other comes back.
    q.clear("composer");
    expect(shown(q)).toBe("Microphone allowed. Press the mic to talk.");
    q.clear("voice");
    expect(q.current).toBeNull();
  });

  it("equally important notices wait in the order they came", () => {
    const q = new NoticeQueue<N>();
    q.put(note("a", "info"));
    q.put(note("b", "info"));
    q.put(note("c", "info"));
    expect(shown(q)).toBe("a");
    q.clear("a");
    expect(shown(q)).toBe("b");
    expect(q.size).toBe(2);
  });

  it("a notice with the same key replaces the old one in its place, shown or waiting", () => {
    const q = new NoticeQueue<N>();
    q.put(note("composer", "info", "Sending…", { sticky: true }));
    q.put(note("voice", "info", "Microphone allowed."));
    q.put(note("composer", "info", "Looking at the page…", { sticky: true }));
    expect(shown(q)).toBe("Looking at the page…");
    expect(q.size).toBe(2);
    // A waiting one replaced stays behind the one shown.
    q.put(note("voice", "info", "Allow the microphone in the new tab, then press the mic."));
    expect(shown(q)).toBe("Looking at the page…");
    // A failure replaces its own progress line.
    q.put(note("composer", "error", "The agent did not take the message"));
    expect(shown(q)).toBe("The agent did not take the message");
    expect(q.size).toBe(2);
  });

  it("clearing an unknown key changes nothing", () => {
    const q = new NoticeQueue<N>();
    q.put(note("voice", "info"));
    q.clear("nope");
    expect(shown(q)).toBe("voice");
  });
});

describe("autoHideMs: which notices hide by themselves", () => {
  it("info notices hide after a few seconds", () => {
    expect(autoHideMs(note("voice", "info"))).toBe(NOTICE_HIDE_MS);
    expect(NOTICE_HIDE_MS).toBeGreaterThanOrEqual(3_000);
  });

  it("errors, notices with a button and sticky progress lines stay until dismissed or cleared", () => {
    expect(autoHideMs(note("composer", "error"))).toBeNull();
    expect(autoHideMs(note("voice", "info", "Voice needs the Plus or Pro plan", { actions: [{ label: "Choose a plan" }] }))).toBeNull();
    expect(autoHideMs(note("composer", "info", "Sending…", { sticky: true }))).toBeNull();
  });
});
