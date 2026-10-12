import type { NotificationVoice, VoiceEngineId } from "@noa/shared";
import { describe, expect, it, vi } from "vitest";
import { notifier, spokenNotice } from "../src/notify.js";
import type { NoticeSound } from "../src/voice/notice-voice.js";

describe("spokenNotice", () => {
  it("says the title and the message's first sentence", () => {
    expect(spokenNotice("Task paused", "@getbnty is not signed in in this browser. The account switcher currently lists @a, @b.")).toBe(
      "Noa: Task paused. @getbnty is not signed in in this browser.",
    );
  });

  it("cuts a long sentence at a word", () => {
    const line = spokenNotice("Started: x", `${"word ".repeat(80)}end`);
    expect(line.length).toBeLessThanOrEqual(181);
    expect(line).toMatch(/word…$/);
  });
});

describe("notifier", () => {
  const setup = (
    opts: {
      voiceOn?: boolean;
      locked?: () => Promise<boolean>;
      notes?: NotificationVoice;
      speaker?: string;
      voice?: string;
      engine?: VoiceEngineId;
      play?: (sound: NoticeSound) => Promise<void>;
    } = {},
  ) => {
    const created = vi.fn(async () => "n1");
    const speak = vi.fn(async () => {});
    const notify = notifier({
      settings: async () => ({
        notificationVoice: opts.notes ?? "same",
        notificationSpeaker: opts.speaker ?? "",
        speechVoice: opts.voice ?? "",
        speechRate: 1.2,
        voiceEngine: opts.engine ?? "standard",
        realtimeVoice: "ash",
        realtimeSpeed: 1.1,
        deepgramVoice: "thalia",
        deepgramSpeed: 0.9,
      }),
      ...(opts.play ? { play: opts.play } : {}),
      voiceOn: () => opts.voiceOn ?? false,
      ...(opts.locked ? { locked: opts.locked } : {}),
      notifications: { create: created as never },
      tts: { speak: speak as never, getVoices: (async () => [{ voiceName: "Samantha" }]) as never },
      iconUrl: () => "icon.png",
    });
    return { notify, created, speak };
  };

  it("shows the notification and says it aloud, queued, with the browser voice and speed", async () => {
    const { notify, created, speak } = setup({ voice: "Samantha" });
    await notify("Started: post a tip", "Working on it in the background.", "Noa started working on: post a tip");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ title: "Noa: Started: post a tip", message: "Working on it in the background." }));
    expect(speak).toHaveBeenCalledWith("Noa started working on: post a tip", { enqueue: true, rate: 1.2, voiceName: "Samantha" });
  });

  it("uses Chrome's default voice when the chosen one is not Chrome's", async () => {
    const { notify, speak } = setup({ voice: "Not here" });
    await notify("Task paused", "Needs you.");
    expect(speak).toHaveBeenCalledWith("Noa: Task paused. Needs you.", { enqueue: true, rate: 1.2 });
  });

  it("follows the hands-free engine by default: Realtime, Realtime mini and Deepgram in their voice and speed", async () => {
    const cases: [VoiceEngineId, NoticeSound][] = [
      ["realtime", { kind: "realtime", mini: false, line: "a", voice: "ash", speed: 1.1 }],
      ["realtime-mini", { kind: "realtime", mini: true, line: "a", voice: "ash", speed: 1.1 }],
      ["deepgram", { kind: "deepgram", line: "a", voice: "thalia", speed: 0.9 }],
    ];
    for (const [engine, sound] of cases) {
      const play = vi.fn(async () => {});
      const { notify, speak } = setup({ engine, play });
      await notify("x", "y", "a");
      expect(play).toHaveBeenCalledWith(sound);
      expect(speak).not.toHaveBeenCalled();
    }
  });

  it("uses the voice picked for notifications over the hands-free engine's; a chime; or nothing", async () => {
    const play = vi.fn(async () => {});
    const deepgram = setup({ engine: "realtime", notes: "deepgram", play });
    await deepgram.notify("x", "y", "a");
    expect(play).toHaveBeenLastCalledWith({ kind: "deepgram", line: "a", voice: "thalia", speed: 0.9 });

    const browser = setup({ engine: "realtime", notes: "standard", play });
    await browser.notify("x", "y", "a");
    expect(browser.speak).toHaveBeenCalledOnce();

    const chime = setup({ engine: "deepgram", notes: "chime", play });
    await chime.notify("x", "y", "a");
    expect(play).toHaveBeenLastCalledWith({ kind: "chime" });
    expect(chime.speak).not.toHaveBeenCalled();

    play.mockClear();
    const off = setup({ engine: "realtime", notes: "off", play });
    await off.notify("x", "y", "a");
    expect(off.created).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    expect(off.speak).not.toHaveBeenCalled();
  });

  it("says notifications in the voice picked just for them, of the engine they use; another engine's voice falls back to the one above", async () => {
    const play = vi.fn(async () => {});
    await setup({ engine: "realtime", notes: "deepgram", speaker: "apollo", play }).notify("x", "y", "a");
    expect(play).toHaveBeenLastCalledWith({ kind: "deepgram", line: "a", voice: "apollo", speed: 0.9 });
    await setup({ engine: "realtime", speaker: "cedar", play }).notify("x", "y", "a");
    expect(play).toHaveBeenLastCalledWith({ kind: "realtime", mini: false, line: "a", voice: "cedar", speed: 1.1 });
    // Picked for Deepgram, then notifications moved to Realtime: Realtime's own voice.
    await setup({ engine: "realtime", speaker: "apollo", play }).notify("x", "y", "a");
    expect(play).toHaveBeenLastCalledWith({ kind: "realtime", mini: false, line: "a", voice: "ash", speed: 1.1 });

    const browser = setup({ engine: "realtime", notes: "standard", voice: "Not here", speaker: "Samantha", play });
    await browser.notify("x", "y", "a");
    expect(browser.speak).toHaveBeenCalledWith("a", { enqueue: true, rate: 1.2, voiceName: "Samantha" });
    // A Deepgram voice id is no browser voice: the browser voice above.
    const stale = setup({ engine: "standard", voice: "Samantha", speaker: "apollo", play });
    await stale.notify("x", "y", "a");
    expect(stale.speak).toHaveBeenCalledWith("a", { enqueue: true, rate: 1.2, voiceName: "Samantha" });
  });

  it("plays one after the other", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const play = vi.fn(async (sound: NoticeSound) => {
      const line = sound.kind === "chime" ? "chime" : sound.line;
      order.push(`start ${line}`);
      if (line === "a") await first;
      order.push(`end ${line}`);
    });
    const { notify } = setup({ engine: "realtime", play });
    const a = notify("x", "y", "a");
    const b = notify("x", "y", "b");
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start a"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("falls back to Chrome's speech when a voice fails; a failed chime stays silent", async () => {
    const failing = async () => {
      throw new Error("signed out");
    };
    const voice = setup({ engine: "deepgram", play: failing });
    await voice.notify("Task paused", "Needs you.");
    expect(voice.speak).toHaveBeenCalledWith("Noa: Task paused. Needs you.", { enqueue: true, rate: 1.2 });
    const chime = setup({ notes: "chime", play: failing });
    await chime.notify("Task paused", "Needs you.");
    expect(chime.speak).not.toHaveBeenCalled();
  });

  it("is silent while hands-free voice is on; the notification still shows", async () => {
    for (const opts of [{}, { engine: "realtime" as const }, { notes: "chime" as const }]) {
      const play = vi.fn(async () => {});
      const { notify, created, speak } = setup({ ...opts, voiceOn: true, play });
      await notify("Task paused", "Needs you.");
      expect(created).toHaveBeenCalledOnce();
      expect(speak).not.toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();
    }
  });

  it("is silent while the screen is locked (a closed lid); the notification still shows", async () => {
    for (const opts of [{}, { engine: "realtime" as const }, { notes: "chime" as const }]) {
      const play = vi.fn(async () => {});
      const { notify, created, speak } = setup({ ...opts, locked: async () => true, play });
      await notify("Task paused", "Needs you.");
      expect(created).toHaveBeenCalledOnce();
      expect(speak).not.toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();
    }
  });

  it("does not play a notice queued before the screen locked", async () => {
    let locked = false;
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const play = vi.fn(async (sound: NoticeSound) => {
      if (sound.kind !== "chime" && sound.line === "a") await first;
    });
    const { notify, speak } = setup({ engine: "realtime", locked: async () => locked, play });
    const a = notify("x", "y", "a");
    const b = notify("x", "y", "b");
    await new Promise((r) => setTimeout(r, 0));
    locked = true;
    release();
    await Promise.all([a, b]);
    expect(play).toHaveBeenCalledOnce();
    expect(speak).not.toHaveBeenCalled();
  });

  it("speaks when whether the screen is locked cannot be told", async () => {
    const { notify, speak } = setup({ locked: async () => Promise.reject(new Error("no idle")) });
    await notify("Task paused", "Needs you.");
    expect(speak).toHaveBeenCalledOnce();
  });

  it("never throws", async () => {
    const notify = notifier({
      settings: async () => {
        throw new Error("storage");
      },
      voiceOn: () => false,
      notifications: { create: (async () => {
        throw new Error("no");
      }) as never },
      tts: { speak: vi.fn() as never, getVoices: (async () => []) as never },
      iconUrl: () => "icon.png",
    });
    await expect(notify("a", "b")).resolves.toBeUndefined();
  });
});
