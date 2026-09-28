/**
 * Hands-free voice across tabs (the owner's report: voice started in one tab looked live in every other, and the
 * narrator answered questions about a tab it could not see). The side panel is the window's and stays on screen on
 * every tab; the panel running the session follows its window's active tab: the bar always names the session's tab,
 * on another tab with Go to tab and Use voice here, messages and the narrator get a note naming both tabs, and "use
 * this tab" moves it. Another window's panel shows where voice is on, nothing live, and Use voice here ends it where
 * it runs before starting it there (one microphone).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, VoiceEngineId, VoiceEnginesResponse } from "@noa/shared";
import { initHandsFree, RECONNECT_DELAYS_MS, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import type { HandsFreeLook } from "../../src/sidepanel/voice-input.js";
import type { EngineEvents, HandsFreeEngine } from "../../src/voice/engine.js";
import { HANDS_FREE } from "../../src/voice/hands-free.js";
import { lookingHomeNote } from "../../src/voice/hands-free-tab.js";
import type { VoiceSessionView } from "../../src/voice-session.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

class FakeEngine implements HandsFreeEngine {
  readonly halfDuplex: boolean;
  stopped = false;
  notes: string[] = [];
  spoken: string[] = [];
  /** Each setMuted call, in order. */
  mutes: boolean[] = [];
  constructor(
    readonly id: VoiceEngineId,
    readonly events: EngineEvents,
    readonly takeover = false,
    private readonly begin: () => Promise<void> = async () => {},
  ) {
    this.halfDuplex = id === "standard";
  }
  start(): Promise<void> {
    return this.begin();
  }
  stop(): void {
    this.stopped = true;
  }
  speak(text: string): void {
    this.spoken.push(text);
  }
  hush(): void {}
  setTranscribing(): void {}
  setMuted(muted: boolean): void {
    this.mutes.push(muted);
  }
  agentEvent(): void {}
  note(text: string): void {
    this.notes.push(text);
  }
  tick(): void {}
}

const ENGINES: VoiceEnginesResponse = {
  default: "realtime",
  engines: [
    { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6, assumption: "", available: true },
    { id: "standard", name: "Standard", model: "whisper", approxCentsPerMinute: 0.07, assumption: "", available: true },
  ],
};

const PAGES: Record<number, { title: string; url: string }> = {
  1: { title: "Inbox", url: "https://mail.example.com/" },
  2: { title: "Recipes", url: "https://recipes.example/b" },
};

/** Walks the bar for the element with this class. */
function find(el: MiniElement, cls: string): MiniElement | null {
  if (el.className.split(" ").includes(cls)) return el;
  for (const kid of el.childNodes) if (kid instanceof MiniElement) {
    const hit = find(kid, cls);
    if (hit) return hit;
  }
  return null;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A window's side panel, showing tab `shownTab` (its window's active tab); `id`: the page's id ("p1" runs the
 * session in these tests, "p2" is another window's panel). show(tab): the user switches tabs in its window.
 */
function panel(shownTab: number, opts: { id?: string; engine?: VoiceEngineId; begin?: (n: number) => Promise<void> } = {}) {
  let shown = shownTab;
  const engines: FakeEngine[] = [];
  const looks: (HandsFreeLook | null)[] = [];
  const reports: [boolean, number | null, VoiceEngineId | null][] = [];
  /** Whether each report said the microphone is muted. */
  const mutedReports: boolean[] = [];
  const sounds: string[] = [];
  const bar = new MiniElement("div");
  const deps: HandsFreeDeps = {
    voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: (l) => void looks.push(l), setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
    composer: { draft: () => "", setDraft: () => {} },
    notify: () => {},
    activeTab: () => shown,
    panel: opts.id ?? "p1",
    chatOf: () => null,
    tabsOf: () => [],
    send: vi.fn(async () => "s-voice"),
    tabPage: async (id) => PAGES[id] ?? null,
    goToTab: vi.fn(),
    onSpeaking: () => {},
    keepSpoken: () => {},
    keepHeard: () => {},
    settings: () => ({ voiceEngine: opts.engine ?? "realtime", realtimeCostNoticed: true }) as ExtensionSettings,
    account: () => undefined,
    engines: async () => ENGINES,
    saveSettings: async () => {},
    openVoiceSettings: () => {},
    createEngine: (id, events, o) => {
      const n = engines.length;
      const e = new FakeEngine(id, events, o?.takeover ?? false, opts.begin && (() => opts.begin!(n)));
      engines.push(e);
      return e;
    },
    stopTask: async () => "",
    answerApproval: async () => true,
    openBilling: () => {},
    signIn: () => {},
    onActive: (on, tab, engine, muted) => {
      reports.push([on, tab, engine]);
      mutedReports.push(muted);
    },
    stopRemote: vi.fn(),
    bar: bar as unknown as HTMLElement,
    earcons: { play: (kind) => void sounds.push(kind) },
  };
  const hf = initHandsFree(deps);
  const button = (cls: string) => find(bar, cls)!;
  /** The user switches to `tab`: the panel follows its window's active tab and looks again (sidepanel.ts setActive). */
  const show = (tab: number) => {
    shown = tab;
    hf.refresh();
  };
  return { hf, deps, engines, looks, reports, mutedReports, sounds, bar, button, show };
}

/** What the background says: panel p1 runs the session, for tab 1, and the user looks at `viewing`. */
const inTab1 = (viewing: number, s: Partial<VoiceSessionView> = {}): VoiceSessionView => ({ tabId: 1, windowId: 5, panel: "p1", engine: "realtime", viewing, ...s });

describe("hands-free voice in the panel that runs it, while the user looks at another tab", () => {
  beforeAll(installMiniDom);

  it("the bar says where it listens; what is said carries a note naming both tabs; the narrator is told, and when the user is back", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    expect(t.reports.at(-1)).toEqual([true, 1, "realtime"]);
    t.hf.setSession(inTab1(1));
    await settle();
    expect(rt.notes).toEqual([]);
    expect(t.bar.dataset.state).toBe("listening");

    // The user switches to tab 2 (the panel stays on screen, and follows).
    t.show(2);
    await settle();
    expect(t.bar.dataset.state).toBe("elsewhere");
    expect(rt.notes).toEqual(["The user is looking at another tab: Recipes (recipes.example). You work in Inbox (mail.example.com)."]);
    // Still listening (it belongs to tab 1), and the box there is not written into.
    expect(t.hf.active).toBe(true);
    expect(t.looks.at(-1)).toMatchObject({ elsewhere: true, orb: false });

    rt.events.forward("What is on this page?");
    await settle();
    // The words as said; the note goes with them as the message's context (the agent gets it, the chat does not show it).
    expect(t.deps.send).toHaveBeenLastCalledWith(
      "What is on this page?",
      { tabId: 1, sessionId: null },
      { context: "The user is looking at another tab: Recipes (recipes.example). You work in Inbox (mail.example.com)." },
    );

    // Back on tab 1: the narrator hears so; messages go as said.
    t.show(1);
    await settle();
    expect(rt.notes.at(-1)).toBe(lookingHomeNote(PAGES[1]!));
    rt.events.forward("Reply to Sarah");
    await settle();
    expect(t.deps.send).toHaveBeenLastCalledWith("Reply to Sarah", { tabId: 1, sessionId: "s-voice" });
    expect(t.bar.dataset.state).not.toBe("elsewhere");
  });

  it("use_this_tab moves it to the tab the user looks at (its chat, its badge), or says why not", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    expect(await rt.events.useThisTab()).toBe("The user is already looking at the tab you work in.");
    t.show(3);
    expect(await rt.events.useThisTab()).toBe("That tab is gone: nothing moved.");
    t.show(2);
    await settle();
    expect(await rt.events.useThisTab()).toBe("Moved: you now work in Recipes (recipes.example); what the user says goes to that tab's chat.");
    expect(t.reports.at(-1)).toEqual([true, 2, "realtime"]);
    expect(t.hf.tab).toBe(2);
    t.hf.setSession(inTab1(2, { tabId: 2 }));
    expect(t.bar.dataset.state).not.toBe("elsewhere");
    rt.events.forward("What is on this page?");
    await settle();
    expect(t.deps.send).toHaveBeenLastCalledWith("What is on this page?", { tabId: 2, sessionId: null });
  });

  it("Standard: 'use this tab' said is not sent as a message; it moves the session and says so", async () => {
    const t = panel(1, { engine: "standard" });
    t.hf.toggle("button");
    await settle();
    const std = t.engines[0]!;
    expect(std.id).toBe("standard");
    t.show(2);
    std.events.heard("Use this tab.", true);
    await settle();
    await settle();
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.hf.tab).toBe(2);
    expect(std.spoken).toEqual(["Now working in Recipes."]);
  });

  it("the background asks it to stop (Stop or Use voice here in another panel): it ends and says so", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    t.hf.stopHere();
    expect(t.hf.active).toBe(false);
    expect(t.engines[0]!.stopped).toBe(true);
    expect(t.reports.at(-1)).toEqual([false, null, null]);
  });
});

describe("hands-free voice seen from another window's panel", () => {
  beforeAll(installMiniDom);

  it("says where voice is on, with Go to tab, Use voice here and Turn off, and nothing live", async () => {
    const t = panel(2, { id: "p2" });
    t.hf.setSession(inTab1(2));
    await settle();
    expect(t.bar.hidden).toBe(false);
    expect(t.bar.dataset.state).toBe("elsewhere");
    expect(find(t.bar, "vb-label")!.textContent).toBe("Voice on · Inbox");
    expect(find(t.bar, "vb-links")!.hidden).toBe(false);
    expect(find(t.bar, "vb-off")!.hidden).toBe(false);
    expect(find(t.bar, "vb-meter")!.hidden).toBe(true);
    expect(t.bar.dataset.phase).toBeUndefined();
    expect(t.hf.active).toBe(false);
    // The mic button and the box stay as they are when voice is off.
    expect(t.looks.every((l) => l === null)).toBe(true);
    expect(t.engines).toEqual([]);

    t.button("vb-go").click();
    expect(t.deps.goToTab).toHaveBeenCalledWith(1);
    t.button("vb-off").click();
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    // It ended there: the notice goes.
    t.hf.setSession(null);
    expect(t.bar.hidden).toBe(true);
    expect(t.engines).toEqual([]);
  });

  it("Use voice here: ends it where it runs, then (once it ended) starts here on the same engine; never two at once", async () => {
    const t = panel(2, { id: "p2" });
    t.hf.setSession(inTab1(2, { engine: "standard" }));
    t.button("vb-use").click();
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    // Not before the other panel let go of the microphone.
    await settle();
    expect(t.engines).toEqual([]);
    expect(t.hf.active).toBe(false);
    // A second press meanwhile does nothing more.
    t.hf.toggle("button");
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    t.hf.setSession(null);
    await settle();
    // Settings say Realtime; the session goes on on Standard, as it ran.
    expect(t.engines.map((e) => e.id)).toEqual(["standard"]);
    // The session the other panel just closed may still be closing on the server: this one takes its place
    // (the handover once found it open, "busy", and fell back to Standard).
    expect(t.engines[0]!.takeover).toBe(true);
    expect(t.hf.active).toBe(true);
    expect(t.hf.tab).toBe(2);
    expect(t.reports.at(-1)).toEqual([true, 2, "standard"]);
  });

  it("the mic in that panel moves the session here too (it does not start a second one)", async () => {
    const t = panel(2, { id: "p2" });
    t.hf.setSession(inTab1(2));
    t.hf.toggle("button");
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    expect(t.engines).toEqual([]);
  });

  it("its own report of a session it no longer runs is no other panel's session: no strip, and the mic starts one", async () => {
    const t = panel(1);
    t.hf.setSession(inTab1(1));
    expect(t.bar.hidden).toBe(true);
    t.hf.toggle("button");
    await settle();
    expect(t.deps.stopRemote).not.toHaveBeenCalled();
    expect(t.engines).toHaveLength(1);
  });
});

describe("hands-free voice muted", () => {
  beforeAll(installMiniDom);

  it("Mute (the composer's toggle): the engine stops taking the microphone, the strip goes 'Muted', the badge is told, a soft sound; Unmute undoes it", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    expect(t.looks.at(-1)?.mute).toEqual({ pressed: false, label: "Mute the microphone · Alt+M" });
    t.hf.toggleMute();
    expect(t.hf.muted).toBe(true);
    expect(rt.mutes).toEqual([true]);
    expect(t.bar.dataset.state).toBe("muted");
    expect(t.bar.dataset.muted).toBe("true");
    expect(find(t.bar, "vb-status")!.textContent).toBe("Muted");
    expect(find(t.bar, "vb-meter")!.hidden).toBe(true);
    expect(t.looks.at(-1)?.mute).toEqual({ pressed: true, label: "Unmute the microphone · Alt+M" });
    expect(t.reports.at(-1)).toEqual([true, 1, "realtime"]);
    expect(t.mutedReports.at(-1)).toBe(true);
    expect(t.looks.at(-1)).toMatchObject({ muted: true });
    expect(t.sounds).toEqual(["start", "mute"]);
    // Still on: the narrator speaking shows as speaking, the Mute still pressed.
    rt.events.narrating();
    expect(t.bar.dataset.state).toBe("speaking");
    expect(t.bar.dataset.muted).toBe("true");
    rt.events.said();
    t.hf.toggleMute();
    expect(rt.mutes).toEqual([true, false]);
    expect(t.bar.dataset.state).toBe("listening");
    expect(t.bar.dataset.muted).toBeUndefined();
    expect(t.mutedReports.at(-1)).toBe(false);
    expect(t.looks.at(-1)).toMatchObject({ muted: false });
    expect(t.sounds).toEqual(["start", "mute", "unmute"]);
  });

  it("no Mute while it starts or when voice is off; toggling then does nothing", async () => {
    const t = panel(1);
    t.hf.toggleMute();
    expect(t.hf.muted).toBe(false);
    t.hf.toggle("button");
    expect(t.looks.at(-1)?.mute).toBeNull();
    await settle();
    expect(t.looks.at(-1)?.mute).not.toBeNull();
  });

  it("the session ending unmutes: the next one starts with the microphone on", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    t.hf.toggleMute();
    t.hf.toggle("button");
    expect(t.hf.active).toBe(false);
    expect(t.hf.muted).toBe(false);
    expect(t.reports.at(-1)).toEqual([false, null, null]);
    expect(t.mutedReports.at(-1)).toBe(false);
    t.hf.toggle("button");
    await settle();
    expect(t.hf.muted).toBe(false);
    expect(t.engines[1]!.mutes).toEqual([]);
  });

  it("moved to another tab it stays muted (a move never turns the microphone on)", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    t.hf.toggleMute();
    t.show(2);
    await settle();
    expect(t.bar.dataset.state).toBe("elsewhere");
    expect(find(t.bar, "vb-status")!.textContent).toBe("Muted");
    // Mute is still there, looking at another tab.
    expect(t.looks.at(-1)?.mute).toMatchObject({ pressed: true });
    expect(await rt.events.useThisTab()).toMatch(/^Moved/);
    expect(t.hf.tab).toBe(2);
    expect(t.hf.muted).toBe(true);
    expect(rt.mutes).toEqual([true]);
    expect(t.mutedReports.at(-1)).toBe(true);
  });

  it("Use voice here in another window's panel: the session starts there muted, as it was", async () => {
    const t = panel(2, { id: "p2" });
    t.hf.setSession(inTab1(2, { muted: true }));
    expect(find(t.bar, "vb-status")!.textContent).toBe("Muted");
    expect(t.bar.title).toBe("Realtime voice · Listening in another window");
    // The mic and Mute stay as they are when voice is off here.
    expect(t.looks.every((l) => l === null)).toBe(true);
    t.button("vb-use").click();
    t.hf.setSession(null);
    await settle();
    const rt = t.engines[0]!;
    // Muted before it opened the microphone: nothing was heard in between.
    expect(rt.mutes[0]).toBe(true);
    expect(t.hf.muted).toBe(true);
    expect(t.bar.dataset.state).toBe("muted");
    expect(t.mutedReports.at(-1)).toBe(true);
  });

  it("Realtime reconnecting after a drop keeps the microphone muted (and the engine)", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    t.hf.toggleMute();
    t.engines[0]!.events.failed({ kind: "upstream", transient: true, message: "Voice disconnected." });
    await settle();
    const std = t.engines[1]!;
    expect(std.id).toBe("realtime");
    expect(std.mutes).toEqual([true]);
    expect(t.hf.muted).toBe(true);
    expect(t.bar.dataset.state).toBe("muted");
  });
});

describe("hands-free voice narrates its own chat only (the owner's report: TODO runs' results read out in the system voice)", () => {
  beforeAll(installMiniDom);

  it("a scheduled run's result while voice is on with no request of its own: nothing is said, and it does not keep the session alive", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(1, { engine: "standard" });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const std = t.engines[0]!;
      expect(t.hf.phase).toBe("listening");
      // A scheduled X run works (its own chat, not the session's): its steps and result come in all along.
      t.hf.setRunning(["sched-1"]);
      const at = () => new Date().toISOString();
      for (let i = 0; i < 6; i++) {
        t.hf.onEvent({ type: "tool_call", id: `t${i}`, name: "navigate", args: { url: "https://x.com/compose/post" }, ts: at(), sessionId: "sched-1" });
        t.hf.onEvent({ type: "task_end", outcome: "done", summary: "Posted", spoken: "Made a post for Mecha Royale.", ts: at(), sessionId: "sched-1" });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(std.spoken).toEqual([]);
      // No speech of the user's for the silence timeout: it ends, whatever other chats did meanwhile.
      await vi.advanceTimersByTimeAsync(HANDS_FREE.silenceTimeoutMs);
      expect(t.hf.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Standard: the speaker's own line heard back is not the user (echo)", () => {
  beforeAll(installMiniDom);

  it("a transcript of the line just said is not sent; the user's own words are", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(1, { engine: "standard" });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.hf.setSession(inTab1(1));
      const std = t.engines[0]!;
      // "Use this tab" said on its own tab: the line "I'm already working in this tab." is said.
      std.events.heard("Use this tab.", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(std.spoken).toEqual(["I'm already working in this tab."]);
      std.events.said();
      // The microphone picks it up.
      std.events.heard("I'm already working in this tab", true);
      await vi.advanceTimersByTimeAsync(HANDS_FREE.sendDelayMs * 2);
      expect(t.deps.send).not.toHaveBeenCalled();
      std.events.heard("Post gm on X", true);
      await vi.advanceTimersByTimeAsync(HANDS_FREE.sendDelayMs * 2);
      expect((t.deps.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["Post gm on X"]);
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hands-free voice stopped and started again while it still starts (a double press): one engine, the one on", () => {
  beforeAll(installMiniDom);

  /** A promise and its resolve. */
  const held = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  };

  it("during the microphone check: the older start opens no engine", async () => {
    const t = panel(1);
    const mics: ((ok: boolean) => void)[] = [];
    t.deps.voice.ensureMic = () => new Promise((r) => mics.push(r));
    t.hf.toggle("button");
    t.hf.toggle("button");
    t.hf.toggle("button");
    // Both checks answer together (one permission prompt).
    mics[0]!(true);
    mics[1]!(true);
    await settle();
    expect(t.engines).toHaveLength(1);
    expect(t.engines[0]!.stopped).toBe(false);
    expect(t.hf.active).toBe(true);
    t.hf.toggle("button");
    expect(t.engines[0]!.stopped).toBe(true);
    expect(t.hf.active).toBe(false);
  });

  it("while the engine connects: the older engine is stopped, and the newer start still counts as on", async () => {
    const starts = [held(), held()];
    const t = panel(1, { begin: (n) => starts[n]!.promise });
    t.hf.toggle("button");
    await settle();
    t.hf.toggle("button");
    t.hf.toggle("button");
    await settle();
    expect(t.engines).toHaveLength(2);
    starts[0]!.release();
    await settle();
    expect(t.engines[0]!.stopped).toBe(true);
    // Still starting: the next press stops it (not a third start).
    expect(t.hf.active).toBe(true);
    starts[1]!.release();
    await settle();
    expect(t.engines[1]!.stopped).toBe(false);
    expect(t.hf.phase).toBe("listening");
    t.hf.toggle("button");
    expect(t.engines.map((e) => e.stopped)).toEqual([true, true]);
  });

  it("while Realtime waits to reconnect: the older session opens no engine after its wait", async () => {
    vi.useFakeTimers();
    try {
      const drop = { kind: "upstream", transient: true, message: "Voice disconnected." };
      const t = panel(1, { begin: (n) => (n === 1 ? Promise.reject(drop) : Promise.resolve()) });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.engines[0]!.events.failed(drop);
      await vi.advanceTimersByTimeAsync(0);
      // The reconnect failed once and waits to try again; the user stops and starts voice meanwhile.
      expect(t.engines).toHaveLength(2);
      t.hf.toggle("button");
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
      expect(t.engines).toHaveLength(3);
      expect(t.engines[2]!.stopped).toBe(false);
      expect(t.hf.phase).toBe("listening");
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });
});
