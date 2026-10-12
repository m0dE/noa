import { describe, expect, it } from "vitest";
import {
  HANDS_FREE,
  handsFree,
  initialHandsFree,
  isCancelPhrase,
  isStopPhrase,
  type HandsFreeEffect,
  type HandsFreeEvent,
  type HandsFreeState,
} from "../../src/voice/hands-free.js";

/** Runs events from a state; returns the last state and every effect, in order. */
function run(events: HandsFreeEvent[], from: HandsFreeState = initialHandsFree()): { state: HandsFreeState; effects: HandsFreeEffect[] } {
  let state = from;
  const effects: HandsFreeEffect[] = [];
  for (const e of events) {
    const r = handsFree(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const started = (opts: { halfDuplex?: boolean } = {}) => run([{ type: "start", now: 0, halfDuplex: opts.halfDuplex ?? true }]).state;
const heard = (text: string, now: number, forward = true): HandsFreeEvent => ({ type: "heard", text, forward, now });

describe("stop and cancel phrases", () => {
  it("recognises what ends the session and what cancels a message, not words inside a request", () => {
    for (const s of ["stop", "Stop.", "stop listening", "Stop listening!", "end voice", "goodbye"]) expect(isStopPhrase(s)).toBe(true);
    for (const s of ["stop the music on spotify", "don't stop", "cancel"]) expect(isStopPhrase(s)).toBe(false);
    for (const s of ["cancel", "Cancel.", "never mind", "Nevermind!", "cancel that"]) expect(isCancelPhrase(s)).toBe(true);
    for (const s of ["cancel my subscription", "stop"]) expect(isCancelPhrase(s)).toBe(false);
  });
});

describe("hands-free: listening -> sending -> working -> speaking -> listening", () => {
  it("starts listening; an utterance waits HANDS_FREE.sendDelayMs in 'sending', then goes out", () => {
    const s0 = started();
    expect(s0.phase).toBe("listening");
    expect(run([{ type: "start", now: 0, halfDuplex: true }]).effects).toEqual([{ type: "transcribe", on: true }]);
    const a = run([heard("Open Gmail and read my newest email", 1000)], s0);
    expect(a.state).toMatchObject({ phase: "sending", pending: "Open Gmail and read my newest email", sendAt: 1000 + HANDS_FREE.sendDelayMs });
    expect(a.effects).toEqual([]);
    expect(run([{ type: "tick", now: 1000 + HANDS_FREE.sendDelayMs - 1 }], a.state).state.phase).toBe("sending");
    const b = run([{ type: "tick", now: 1000 + HANDS_FREE.sendDelayMs }], a.state);
    expect(b.effects).toEqual([{ type: "send", text: "Open Gmail and read my newest email" }]);
    expect(b.state).toMatchObject({ phase: "listening", pending: "" });
  });

  it("while the agent works the mic stays on ('working'); speech then goes in as a mid-task message", () => {
    const working = run([{ type: "agent", working: true, now: 2000 }], started()).state;
    expect(working.phase).toBe("working");
    const r = run([heard("use the second draft", 3000), { type: "tick", now: 3000 + HANDS_FREE.sendDelayMs }], working);
    expect(r.effects).toEqual([{ type: "send", text: "use the second draft" }]);
    expect(r.state.phase).toBe("working");
    expect(run([{ type: "agent", working: false, now: 9000 }], r.state).state.phase).toBe("listening");
  });

  it("a line to say: half-duplex stops transcribing while speaking, and starts again after", () => {
    const r = run([{ type: "say", text: "Opening gmail.com", now: 100 }], started());
    expect(r.state.phase).toBe("speaking");
    expect(r.effects).toEqual([
      { type: "transcribe", on: false },
      { type: "speak", text: "Opening gmail.com" },
    ]);
    const done = run([{ type: "said", now: 900 }], r.state);
    expect(done.state.phase).toBe("listening");
    expect(done.effects).toEqual([{ type: "transcribe", on: true }]);
  });

  it("without half-duplex (the realtime engine hears through its own echo cancellation) speaking leaves transcription alone", () => {
    const r = run([{ type: "say", text: "Done.", now: 100 }, { type: "said", now: 500 }], started({ halfDuplex: false }));
    expect(r.effects).toEqual([{ type: "speak", text: "Done." }]);
  });

  it("the realtime narrator speaking by itself is 'speaking' too, with nothing to say for it", () => {
    const r = run([{ type: "narrating", now: 100 }], started({ halfDuplex: false }));
    expect(r.state.phase).toBe("speaking");
    expect(r.effects).toEqual([]);
    expect(run([{ type: "said", now: 400 }], r.state).state.phase).toBe("listening");
  });

  it("lines that come while speaking are said next (the newest one), not over each other", () => {
    const r = run(
      [
        { type: "say", text: "Opening x.com", now: 0 },
        { type: "say", text: "Typing", now: 100 },
        { type: "say", text: "Posted it.", now: 200 },
        { type: "said", now: 300 },
      ],
      started(),
    );
    expect(r.effects.filter((e) => e.type === "speak")).toEqual([
      { type: "speak", text: "Opening x.com" },
      { type: "speak", text: "Posted it." },
    ]);
    expect(r.state.phase).toBe("speaking");
  });

  it("does not talk over the user: a line waits while they speak or while their message is being sent", () => {
    const talking = run([{ type: "speech", now: 100 }, { type: "say", text: "Opening x.com", now: 150 }], started());
    expect(talking.effects).toEqual([]);
    const after = run([heard("post gm", 900), { type: "tick", now: 900 + HANDS_FREE.sendDelayMs }], talking.state);
    expect(after.effects).toEqual([
      { type: "send", text: "post gm" },
      { type: "transcribe", on: false },
      { type: "speak", text: "Opening x.com" },
    ]);
  });
});

describe("hands-free: barge-in, cancel, stop words, silence", () => {
  it("barge-in: the user speaking cuts the line off and listening goes on", () => {
    const speaking = run([{ type: "say", text: "Here is a long summary", now: 0 }], started()).state;
    const r = run([{ type: "speech", now: 400 }], speaking);
    expect(r.state.phase).toBe("listening");
    expect(r.effects).toEqual([{ type: "hush" }, { type: "transcribe", on: true }]);
    // The queued line is dropped too: the user has the floor.
    expect(r.state.queued).toBeNull();
  });

  it("the voice shortcut while speaking ends the session (and the speech)", () => {
    const speaking = run([{ type: "say", text: "Done.", now: 0 }], started()).state;
    const r = run([{ type: "stop", reason: "shortcut" }], speaking);
    expect(r.state.phase).toBe("off");
    expect(r.effects).toEqual([{ type: "hush" }, { type: "end", reason: "shortcut" }]);
  });

  it("'cancel' or Esc in the sending window drops the message; said later, 'cancel' is not sent", () => {
    const sending = run([heard("delete all my emails", 1000)], started()).state;
    const said = run([heard("cancel", 1500)], sending);
    expect(said.state).toMatchObject({ phase: "listening", pending: "" });
    expect(said.effects).toEqual([{ type: "cancelled" }]);
    expect(run([{ type: "tick", now: 10_000 }], said.state).effects).toEqual([]);
    const esc = run([{ type: "cancel", now: 1500 }], sending);
    expect(esc.state.pending).toBe("");
    expect(esc.effects).toEqual([{ type: "cancelled" }]);
    // Nothing waiting: the word itself is not a message.
    const idle = run([heard("never mind", 2000), { type: "tick", now: 9000 }], started());
    expect(idle.effects).toEqual([]);
  });

  it("speaking again inside the window holds it, and the next words join the same message", () => {
    const r = run(
      [
        heard("open gmail", 1000),
        { type: "speech", now: 1500 },
        { type: "tick", now: 1000 + HANDS_FREE.sendDelayMs + 100 },
        heard("and reply to Sarah", 2600),
        { type: "tick", now: 2600 + HANDS_FREE.sendDelayMs },
      ],
      started(),
    );
    expect(r.effects).toEqual([{ type: "send", text: "open gmail and reply to Sarah" }]);
  });

  it("speech that turns out to be nothing (empty text) re-opens the window for what was waiting", () => {
    const r = run([heard("open gmail", 1000), { type: "speech", now: 1500 }, heard("", 2000), { type: "tick", now: 2000 + HANDS_FREE.sendDelayMs }], started());
    expect(r.effects).toEqual([{ type: "send", text: "open gmail" }]);
  });

  it("'stop' / 'stop listening' ends the session, also with a message waiting (which is dropped)", () => {
    expect(run([heard("Stop listening.", 500)], started()).effects).toEqual([{ type: "end", reason: "voice" }]);
    const r = run([heard("open gmail", 500), heard("stop", 900)], started());
    expect(r.state.phase).toBe("off");
    expect(r.effects).toEqual([{ type: "end", reason: "voice" }]);
    // Heard but not forwarded (the realtime narrator decides what to send): stop words still end it.
    expect(run([heard("stop", 500, false)], started()).effects).toEqual([{ type: "end", reason: "voice" }]);
    expect(run([heard("what is it doing?", 500, false)], started()).effects).toEqual([]);
  });

  it("a forwarded request (the narrator's send_to_agent) goes out at once, with no sending window, and the narrator talks on", () => {
    const r = run([{ type: "forward", text: " Post gm on X ", now: 100 }], started({ halfDuplex: false }));
    expect(r.effects).toEqual([{ type: "send", text: "Post gm on X" }]);
    expect(r.state).toMatchObject({ phase: "listening", pending: "", sendAt: null });
    const speaking = run([{ type: "narrating", now: 50 }, { type: "forward", text: "Post gm on X", now: 100 }], started({ halfDuplex: false }));
    expect(speaking.effects).toEqual([{ type: "send", text: "Post gm on X" }]);
    expect(speaking.state.phase).toBe("speaking");
    expect(run([{ type: "forward", text: "  ", now: 100 }], started({ halfDuplex: false })).effects).toEqual([]);
  });

  it("ends after HANDS_FREE.silenceTimeoutMs without speech, but not while the agent works or a line is said", () => {
    expect(HANDS_FREE.silenceTimeoutMs).toBe(180_000);
    const quiet = run([{ type: "tick", now: HANDS_FREE.silenceTimeoutMs - 1 }], started());
    expect(quiet.state.phase).toBe("listening");
    const ended = run([{ type: "tick", now: HANDS_FREE.silenceTimeoutMs }], started());
    expect(ended.effects).toEqual([{ type: "end", reason: "silence" }]);
    const working = run([{ type: "agent", working: true, now: 10 }, { type: "tick", now: HANDS_FREE.silenceTimeoutMs * 2 }], started());
    expect(working.state.phase).toBe("working");
    // The quiet time counts from when the agent finished.
    const finished = run([{ type: "agent", working: false, now: 500_000 }, { type: "tick", now: 500_000 + HANDS_FREE.silenceTimeoutMs - 1 }], working.state);
    expect(finished.state.phase).toBe("listening");
    const speaking = run([{ type: "say", text: "x", now: 10 }, { type: "tick", now: HANDS_FREE.silenceTimeoutMs * 2 }], started());
    expect(speaking.state.phase).toBe("speaking");
  });

  it("Esc with nothing waiting ends the session; events after the end do nothing", () => {
    const r = run([{ type: "cancel", now: 100 }], started());
    expect(r.effects).toEqual([{ type: "end", reason: "escape" }]);
    expect(run([heard("hello", 200), { type: "say", text: "x", now: 300 }, { type: "tick", now: 999_999 }], r.state).effects).toEqual([]);
  });

  it("start while on does nothing; stop while off does nothing", () => {
    expect(run([{ type: "start", now: 5, halfDuplex: true }], started()).effects).toEqual([]);
    expect(run([{ type: "stop", reason: "shortcut" }]).effects).toEqual([]);
  });
});

describe("hands-free: mute", () => {
  const mute = (muted: boolean, now: number): HandsFreeEvent => ({ type: "mute", muted, now });

  it("mute and unmute tell the engine once each; the phase stays what it was (listening or working)", () => {
    const m = run([mute(true, 100)], started());
    expect(m.effects).toEqual([{ type: "mute", muted: true }]);
    expect(m.state).toMatchObject({ phase: "listening", muted: true, lastActivityAt: 100 });
    expect(run([mute(true, 200)], m.state).effects).toEqual([]);
    const working = run([{ type: "agent", working: true, now: 300 }], m.state).state;
    expect(working).toMatchObject({ phase: "working", muted: true });
    const u = run([mute(false, 400)], working);
    expect(u.effects).toEqual([{ type: "mute", muted: false }]);
    expect(u.state).toMatchObject({ phase: "working", muted: false });
    expect(run([mute(false, 500)], u.state).effects).toEqual([]);
  });

  it("does nothing while off; a session ending unmutes (a new one starts unmuted unless asked)", () => {
    expect(run([mute(true, 0)])).toEqual({ state: initialHandsFree(), effects: [] });
    const ended = run([mute(true, 100), { type: "stop", reason: "button" }], started());
    expect(ended.state.muted).toBe(false);
    expect(run([{ type: "start", now: 200, halfDuplex: true }], ended.state).state.muted).toBe(false);
    // A session moved to another panel keeps its mute: it starts muted, and the engine is told.
    const moved = run([{ type: "start", now: 0, halfDuplex: false, muted: true }]);
    expect(moved.state).toMatchObject({ phase: "listening", muted: true });
    expect(moved.effects).toEqual([{ type: "transcribe", on: true }, { type: "mute", muted: true }]);
  });

  it("muted, the user's speech is not taken (a late detector event cannot cut a line off or hold a message)", () => {
    const m = run([mute(true, 100)], started()).state;
    expect(run([{ type: "speech", now: 200 }], m)).toEqual({ state: m, effects: [] });
    const speaking = run([{ type: "say", text: "Opening mail", now: 300 }], m).state;
    expect(speaking.phase).toBe("speaking");
    expect(run([{ type: "speech", now: 400 }], speaking).effects).toEqual([]);
  });

  it("lines are still said while muted (the agent's updates go on)", () => {
    const m = run([mute(true, 100), { type: "agent", working: true, now: 150 }], started()).state;
    const r = run([{ type: "say", text: "Opening mail", now: 200 }], m);
    expect(r.effects).toEqual([{ type: "transcribe", on: false }, { type: "speak", text: "Opening mail" }]);
    expect(run([{ type: "said", now: 300 }], r.state).state).toMatchObject({ phase: "working", muted: true });
  });

  it("muting mid-utterance: the user no longer counts as speaking, and a held message goes out after the window", () => {
    const talking = run([{ type: "speech", now: 100 }], started()).state;
    expect(talking.userSpeaking).toBe(true);
    // A line waiting for the user to finish is said as they mute.
    const waiting = run([{ type: "say", text: "Done", now: 150 }], talking);
    expect(waiting.effects).toEqual([]);
    const m = run([mute(true, 200)], waiting.state);
    expect(m.state).toMatchObject({ userSpeaking: false, phase: "speaking", queued: null });
    expect(m.effects).toEqual([{ type: "mute", muted: true }, { type: "transcribe", on: false }, { type: "speak", text: "Done" }]);
    // The sending window held by more speech opens again on mute, so what was said is not stuck.
    const held = run([heard("Open Gmail", 1000), { type: "speech", now: 1100 }], started()).state;
    expect(held).toMatchObject({ phase: "sending", sendAt: null });
    const muted = run([mute(true, 1200)], held).state;
    expect(muted.sendAt).toBe(1200 + HANDS_FREE.sendDelayMs);
    expect(run([{ type: "tick", now: 1200 + HANDS_FREE.sendDelayMs }], muted).effects).toEqual([{ type: "send", text: "Open Gmail" }]);
  });

  it("the silence timeout: never while a task runs, muted or not; with nothing running it still ends a muted session", () => {
    const m = run([mute(true, 1000)], started()).state;
    // Muting counts as activity: the quiet time starts then.
    expect(run([{ type: "tick", now: 1000 + HANDS_FREE.silenceTimeoutMs - 1 }], m).state.phase).toBe("listening");
    expect(run([{ type: "tick", now: 1000 + HANDS_FREE.silenceTimeoutMs }], m).effects).toEqual([{ type: "end", reason: "silence" }]);
    const working = run([{ type: "agent", working: true, now: 2000 }, { type: "tick", now: 2000 + HANDS_FREE.silenceTimeoutMs * 5 }], m);
    expect(working.state).toMatchObject({ phase: "working", muted: true });
    expect(working.effects).toEqual([]);
  });
});
