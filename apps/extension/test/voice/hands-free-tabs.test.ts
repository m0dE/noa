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
import { initHandsFree, RECONNECT_DELAYS_MS, START_SLOW_MS, START_TIMEOUT_MS, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import type { HandsFreeLook, VoiceTip } from "../../src/sidepanel/voice-input.js";
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
    /** The microphone's audio reaches it once it opened (false: none comes, as with a stuck audio pipeline). */
    private readonly audio = true,
  ) {
    this.halfDuplex = id === "standard";
  }
  async start(): Promise<void> {
    await this.begin();
    if (this.audio && !this.stopped) this.events.capturing();
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
    { id: "deepgram", name: "Deepgram", model: "nova-3", approxCentsPerMinute: 0.5, assumption: "", available: true },
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
function panel(shownTab: number, opts: { id?: string; engine?: VoiceEngineId; begin?: (n: number) => Promise<void>; audio?: boolean } = {}) {
  let shown = shownTab;
  const engines: FakeEngine[] = [];
  const looks: (HandsFreeLook | null)[] = [];
  const reports: [boolean, number | null, VoiceEngineId | null][] = [];
  /** Whether each report said the microphone is muted. */
  const mutedReports: boolean[] = [];
  const sounds: string[] = [];
  const tips: (VoiceTip & { key?: string })[] = [];
  const bar = new MiniElement("div");
  const deps: HandsFreeDeps = {
    voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: (l) => void looks.push(l), setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
    composer: { draft: () => "", setDraft: () => {} },
    notify: (tip) => void tips.push(tip),
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
    settings: () => ({ voiceEngine: opts.engine ?? "realtime" }) as ExtensionSettings,
    account: () => undefined,
    engines: async () => ENGINES,
    saveSettings: async () => {},
    createEngine: (id, events, o) => {
      const n = engines.length;
      const e = new FakeEngine(id, events, o?.takeover ?? false, opts.begin && (() => opts.begin!(n)), opts.audio ?? true);
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
  return { hf, deps, engines, looks, reports, mutedReports, sounds, tips, bar, button, show };
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

describe("voice off and the task's Stop", () => {
  beforeAll(installMiniDom);

  it("the Voice button (or the key) ends voice only: the task goes on", async () => {
    const t = panel(1);
    const stopTask = vi.fn(async () => "Stopped the task.");
    t.deps.stopTask = stopTask;
    t.deps.chatOf = (tab) => (tab === 1 ? "s-voice" : null);
    t.hf.toggle("button");
    await settle();
    t.hf.setRunning(["s-voice"]);
    t.hf.toggle("button");
    expect(t.hf.active).toBe(false);
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("the task's Stop ends voice too, when voice talks to that chat or listens for the tab shown (or Stop stops everything)", async () => {
    const t = panel(1);
    t.deps.chatOf = (tab) => (tab === 1 ? "s-voice" : null);
    t.hf.toggle("button");
    await settle();
    t.hf.endWith("s-voice");
    expect(t.hf.active).toBe(false);

    t.hf.toggle("button");
    await settle();
    t.hf.endWith(null);
    expect(t.hf.active).toBe(false);

    // Voice listens for tab 1 while the user stops a task in tab 2: voice goes on.
    t.hf.toggle("button");
    await settle();
    t.show(2);
    t.hf.endWith("s-other");
    expect(t.hf.active).toBe(true);
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

describe("hands-free voice says it listens only once it does (the owner's report: voice looked on while it was not listening, and 'starting…' never changed)", () => {
  beforeAll(installMiniDom);

  const status = (t: ReturnType<typeof panel>) => find(t.bar, "vb-status")!.textContent;

  it("Realtime: Connecting…, then Opening the mic… until its audio reaches the engine; only then Listening, with the listen-on sound", async () => {
    let connected!: () => void;
    const t = panel(1, { audio: false, begin: () => new Promise<void>((r) => (connected = r)) });
    t.hf.toggle("button");
    await settle();
    // Not listening yet: the strip, the orb and the box all say so; no sound.
    expect([t.bar.dataset.state, status(t)]).toEqual(["starting", "Connecting…"]);
    expect(t.looks.at(-1)).toMatchObject({ orb: true, phase: "opening", listening: false, caption: "Not listening yet · connecting…" });
    expect(t.sounds).toEqual([]);
    // The connection is up and the microphone open, but no audio has reached the engine.
    connected();
    await settle();
    expect([t.bar.dataset.state, status(t)]).toEqual(["starting", "Opening the mic…"]);
    expect(t.looks.at(-1)).toMatchObject({ phase: "opening", listening: false, caption: "Not listening yet · opening the mic…" });
    expect(t.sounds).toEqual([]);
    // Its first audio: now it listens, and says so everywhere at once.
    t.engines[0]!.events.capturing();
    expect([t.bar.dataset.state, status(t)]).toEqual(["listening", "Listening"]);
    expect(t.looks.at(-1)).toMatchObject({ phase: "listening", listening: true, caption: "Listening · go ahead · say “stop” to end" });
    expect(t.sounds).toEqual(["start"]);
    t.engines[0]!.events.capturing();
    expect(t.sounds).toEqual(["start"]);
  });

  it("Whisper: Opening the mic… from the start (nothing to connect)", async () => {
    const t = panel(1, { engine: "standard", audio: false });
    t.hf.toggle("button");
    expect(status(t)).toBe("Opening the mic…");
    await settle();
    expect(status(t)).toBe("Opening the mic…");
    t.engines[0]!.events.capturing();
    expect(t.bar.dataset.state).toBe("listening");
  });

  it("never stays starting: slow, it says it is still at it; then it stops with what went wrong and Try again", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(1, { begin: () => new Promise<void>(() => {}) });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(START_SLOW_MS);
      expect(status(t)).toBe("Still connecting…");
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - START_SLOW_MS);
      expect(t.hf.active).toBe(false);
      expect(t.bar.hidden).toBe(true);
      expect(t.looks.at(-1)).toBeNull();
      expect(t.engines[0]!.stopped).toBe(true);
      const tip = t.tips.at(-1)!;
      expect([tip.level, tip.text, tip.actions?.map((a) => a.label)]).toEqual(["error", "Voice couldn't connect, so it isn't listening.", ["Try again", "Use browser voice"]]);
      // Never started: no stop sound either.
      expect(t.sounds).toEqual([]);
      tip.actions![0]!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines).toHaveLength(2);
      expect(t.hf.active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a microphone that opens but sends nothing stops it too, saying so", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(1, { engine: "standard", audio: false });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
      expect(t.hf.active).toBe(false);
      const tip = t.tips.at(-1)!;
      expect([tip.level, tip.text, tip.actions?.map((a) => a.label)]).toEqual(["error", "The mic didn't start, so voice isn't listening. Check no other app is using it.", ["Try again"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("started muted (moved here muted): Muted once the engine is open, no audio needed, and no timeout", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(2, { id: "p2", audio: false });
      t.hf.setSession(inTab1(2, { muted: true }));
      t.button("vb-use").click();
      t.hf.setSession(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.bar.dataset.state).toBe("muted");
      expect(t.looks.at(-1)).toMatchObject({ listening: false, muted: true });
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
      expect(t.hf.active).toBe(true);
      // Unmuted: it listens once its audio comes.
      t.hf.toggleMute();
      expect(t.bar.dataset.state).toBe("starting");
      t.engines[0]!.events.capturing();
      expect(t.bar.dataset.state).toBe("listening");
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnecting after a drop: not listening until the new connection's audio flows; then the listen-on sound again", async () => {
    const t = panel(1, { audio: false });
    t.hf.toggle("button");
    await settle();
    t.engines[0]!.events.capturing();
    expect(t.sounds).toEqual(["start"]);
    t.engines[0]!.events.failed({ kind: "upstream", transient: true, message: "Voice disconnected." });
    await settle();
    expect(t.engines).toHaveLength(2);
    expect([t.bar.dataset.state, status(t)]).toEqual(["reconnecting", "Reconnecting…"]);
    expect(t.looks.at(-1)).toMatchObject({ listening: false });
    t.engines[1]!.events.capturing();
    expect(t.bar.dataset.state).toBe("listening");
    expect(t.sounds).toEqual(["start", "start"]);
  });
});

describe("Whisper keeps the user informed on a long run (the owner's report: silent during long pauses)", () => {
  beforeAll(installMiniDom);

  it("the trace's turn 3 on Standard: a step line when the agent starts something new, and a 'Still …' line in a long pause", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(1, { engine: "standard" });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const std = t.engines[0]!;
      const said: [number, string][] = [];
      const T0 = Date.now();
      // Each line takes 1.5 s to say.
      std.speak = (text) => {
        said.push([Date.now() - T0, text]);
        setTimeout(() => std.events.said(), 1_500);
      };
      const nav = (url: string) => ({ type: "tool_call" as const, id: "n", name: "navigate", args: { url } });
      const call = (name: string) => ({ type: "tool_call" as const, id: "c", name, args: {} });
      const timeline: [number, Record<string, unknown>][] = [
        [0, { type: "user_message", text: "Take a look at my edits.", voice: true }],
        [1_853, nav("https://x.com/bboym0dE")],
        [20_824, call("wait_for")],
        [22_756, call("press_key")],
        [22_797, call("screenshot")],
        [25_389, nav("https://x.com/bboym0dE/status/1")],
        [26_815, call("wait_for")],
        [27_673, call("read_page")],
        [29_500, call("list_scheduled_tasks")],
        [38_045, { type: "task_end", outcome: "done", summary: "Reviewed", spoken: "I don't see your edits yet." }],
      ];
      t.hf.setRunning(["s-1"]);
      (t.deps as { chatOf: (tab: number | null) => string | null }).chatOf = () => "s-1";
      t.hf.refresh();
      let at = 0;
      for (const [ms, ev] of timeline) {
        await vi.advanceTimersByTimeAsync(ms - at);
        at = ms;
        if (ev.type === "task_end") t.hf.setRunning([]);
        t.hf.onEvent({ ...ev, sessionId: "s-1", ts: new Date().toISOString() } as never);
      }
      await vi.advanceTimersByTimeAsync(2_000);
      const times = said.map(([ms]) => ms);
      let last = 0;
      let longest = 0;
      for (const ms of [...times.filter((x) => x <= 38_045), 38_045]) {
        longest = Math.max(longest, ms - last);
        last = ms;
      }
      expect({ silenceUnder20s: longest <= 20_000, resultOnce: said.filter(([, s]) => s === "I don't see your edits yet.").length }).toEqual({ silenceUnder20s: true, resultOnce: 1 });
      expect(said).toEqual([
        [1_853, "Opening x.com"],
        [19_900, "Still opening x.com"],
        [22_797, "Looking at the page"],
        [38_045, "I don't see your edits yet."],
      ]);
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Deepgram said the greeting twice (the owner's trace, session d8fbe33c)", () => {
  beforeAll(installMiniDom);

  it("the greeting is said once: the opening the turn's end follows at once is not said as a plan", async () => {
    vi.useFakeTimers();
    try {
      const t = panel(1, { engine: "deepgram" });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const eng = t.engines[0]!;
      const said: string[] = [];
      eng.speak = (text) => {
        said.push(text);
        setTimeout(() => eng.events.said(), 3_700);
      };
      t.hf.setRunning(["s-1"]);
      (t.deps as { chatOf: (tab: number | null) => string | null }).chatOf = () => "s-1";
      t.hf.refresh();
      const timeline: [number, Record<string, unknown>][] = [
        [0, { type: "user_message", text: "Hey, how you doing?", voice: true }],
        [1_800, { type: "assistant_text", text: "I'm doing well, thanks for asking! Ready to help with whatever you need." }],
        [2_440, { type: "tool_call", id: "c", name: "task_complete", args: { summary: "Replied to greeting" } }],
        [2_450, { type: "task_end", outcome: "done", summary: "Replied to greeting", spoken: "I'm doing well, thanks for asking! What can I help you with?" }],
      ];
      let at = 0;
      for (const [ms, ev] of timeline) {
        await vi.advanceTimersByTimeAsync(ms - at);
        at = ms;
        if (ev.type === "task_end") t.hf.setRunning([]);
        t.hf.onEvent({ ...ev, sessionId: "s-1", ts: new Date().toISOString() } as never);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(said).toEqual(["I'm doing well, thanks for asking! What can I help you with?"]);
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });
});
