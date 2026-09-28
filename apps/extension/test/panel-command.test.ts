/**
 * The side panel of each window and the keyboard shortcuts: one opens the window's panel with the cursor in its
 * input; the other talks (voice input) there.
 */
import { describe, expect, it, vi } from "vitest";
import { fakePort, type FakePort } from "./chrome-fake.js";
import { PanelCommands, type PanelCommandDeps, type PanelPort } from "../src/panel-command.js";
import { OPEN_CHAT_COMMAND, VOICE_COMMAND } from "../src/shortcut.js";

/** A side panel's port (its messages come in through deliver()). */
function panelPort(): FakePort {
  return fakePort("noa-ui") satisfies PanelPort;
}

const WIN = 3;
const OTHER_WIN = 4;
/** The tab the key is pressed in, in window `windowId`. */
const tab = (id: number, windowId = WIN) => ({ id, windowId });

function setup(opts: { openFails?: boolean } = {}) {
  const calls: string[] = [];
  const open = vi.fn(async (w: number) => {
    calls.push(`open ${w}`);
    if (opts.openFails) throw new Error("`sidePanel.open()` may only be called in response to a user gesture.");
  });
  const closeAllInstantly = vi.fn(async () => void calls.push("close all"));
  const voice = vi.fn();
  const deps: PanelCommandDeps = { open, closeAllInstantly, voice };
  return { pc: new PanelCommands(deps), open, closeAllInstantly, voice, calls };
}

let pages = 0;

/** A window's side panel page that said hello; `focused`: its page has the keyboard focus. Its id: "p<n>". */
function openPanel(pc: PanelCommands, focused = true, draft = "", windowId = WIN, extra: { asTab?: true; job?: string } = {}): FakePort & { id: string } {
  const port = panelPort();
  const id = `p${++pages}`;
  pc.attach(port);
  port.deliver({ type: "panel.hello", windowId, panel: id, ...(extra.asTab ? { asTab: true } : {}) });
  port.deliver({ type: "panel.document", focused, draft, ...(extra.job ? { job: extra.job } : {}) });
  return Object.assign(port, { id });
}

describe("PanelCommands: the shortcut opens the side panel of the window it was pressed in", () => {
  it("no panel in the window: opens it synchronously (the key press is the user gesture), focused when it says hello", () => {
    const { pc, open } = setup();
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("opened");
    // Called before onCommand returned: nothing was awaited first.
    expect(open).toHaveBeenCalledWith(WIN);
    const port = openPanel(pc);
    expect(port.posted).toEqual([{ type: "panel.focus" }]);
    expect(pc.isOpen(WIN)).toBe(true);
  });

  it("the panel is the window's: any tab of the window finds it open (no new panel per tab)", () => {
    const { pc, open } = setup();
    const port = openPanel(pc, true);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(8))).toBe("focused");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(9))).toBe("focused");
    expect(port.posted).toEqual([{ type: "panel.focus" }, { type: "panel.focus" }]);
    expect(open).not.toHaveBeenCalled();
  });

  it("only the panel the shortcut opened is told to focus: once, and not when opening failed", async () => {
    const { pc } = setup();
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    const first = openPanel(pc);
    // A later page of the window (a reconnect after a worker restart) keeps what it shows.
    const later = openPanel(pc);
    expect(first.posted).toEqual([{ type: "panel.focus" }]);
    expect(later.posted).toEqual([]);

    const failing = setup({ openFails: true });
    expect(failing.pc.onCommand(OPEN_CHAT_COMMAND, tab(5))).toBe("opened");
    await Promise.resolve();
    expect(openPanel(failing.pc).posted).toEqual([]);
  });

  it("the panel has the keyboard focus (e.g. on a job's back button): the input gets it, nothing is recreated", () => {
    const { pc, open, closeAllInstantly } = setup();
    const here = openPanel(pc, true);
    const otherWindow = openPanel(pc, true, "", OTHER_WIN);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("focused");
    expect(here.posted).toEqual([{ type: "panel.focus" }]);
    expect(otherWindow.posted).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(closeAllInstantly).not.toHaveBeenCalled();
  });

  it("the focus is in the page: every window's panel is recreated in the gesture (Chrome focuses only a new page)", () => {
    const { pc, calls } = setup();
    const here = openPanel(pc, false, "half a message", WIN, { job: "chat:s1" });
    const other = openPanel(pc, false, "window 4's draft", OTHER_WIN, { job: "task:t9" });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("reopened");
    // Synchronously, in this order: every panel closed at once, then this window's opened anew, then the others.
    expect(calls).toEqual(["close all", `open ${WIN}`, `open ${OTHER_WIN}`]);
    expect([here.posted, other.posted]).toEqual([[], []]);
    here.hostDisconnect();
    other.hostDisconnect();
    // This window's new page gets the focus, its text and job; the other window's only its text and job.
    expect(openPanel(pc, true, "", WIN).posted).toEqual([{ type: "panel.focus", draft: "half a message", job: "chat:s1" }]);
    expect(openPanel(pc, false, "", OTHER_WIN).posted).toEqual([{ type: "panel.restore", draft: "window 4's draft", job: "task:t9" }]);
    // Once: later pages keep their own state.
    expect(openPanel(pc).posted).toEqual([]);
  });

  it("recreating: a panel with nothing to restore in another window is told nothing; an empty box has no draft", () => {
    const { pc } = setup();
    openPanel(pc, false, "");
    openPanel(pc, false, "", OTHER_WIN);
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    expect(openPanel(pc, true, "", WIN).posted).toEqual([{ type: "panel.focus" }]);
    expect(openPanel(pc, false, "", OTHER_WIN).posted).toEqual([]);
  });

  it("recreating: a panel whose open() fails is not told to focus later", async () => {
    const failing = setup({ openFails: true });
    openPanel(failing.pc, false);
    expect(failing.pc.onCommand(OPEN_CHAT_COMMAND, tab(5))).toBe("reopened");
    await Promise.resolve();
    await Promise.resolve();
    expect(openPanel(failing.pc).posted).toEqual([]);
  });

  it("the draft to restore is the one of the panel's last focus change", () => {
    const { pc } = setup();
    const port = openPanel(pc, true, "old");
    port.deliver({ type: "panel.document", focused: false, draft: "newer" });
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    port.hostDisconnect();
    expect(openPanel(pc).posted).toEqual([{ type: "panel.focus", draft: "newer" }]);
  });

  it("the panel page opened as a tab is no side panel: never reopened, and the window still gets its side panel", () => {
    const { pc, calls } = setup();
    const page = openPanel(pc, false, "tab page draft", WIN, { asTab: true });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("opened");
    expect(calls).toEqual([`open ${WIN}`]);
    // The side panel says hello (the page as a tab never takes its focus).
    page.deliver({ type: "panel.hello", windowId: WIN, panel: page.id, asTab: true });
    expect(page.posted).toEqual([]);
    expect(openPanel(pc, true).posted).toEqual([{ type: "panel.focus" }]);
  });

  it("the panel page opened as a tab, with the focus: it gets the input and voice", () => {
    const { pc, open } = setup();
    const page = openPanel(pc, true, "", WIN, { asTab: true });
    expect(pc.onCommand(VOICE_COMMAND, { windowId: WIN })).toBe("voice");
    expect(page.posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
    expect(open).not.toHaveBeenCalled();
  });

  it("voice with no panel: opens it in the gesture; when it says hello it takes the focus, then starts listening", () => {
    const { pc, open } = setup();
    expect(pc.onCommand(VOICE_COMMAND, tab(7))).toBe("opened");
    expect(open).toHaveBeenCalledWith(WIN);
    expect(openPanel(pc, true).posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
  });

  it("voice with the focus in the page: the panels are recreated like open-chat, and this window's new page listens", () => {
    const { pc, calls } = setup();
    const here = openPanel(pc, false, "Post on X:");
    expect(pc.onCommand(VOICE_COMMAND, tab(7))).toBe("reopened");
    expect(calls).toEqual(["close all", `open ${WIN}`]);
    here.hostDisconnect();
    expect(openPanel(pc).posted).toEqual([{ type: "panel.focus", draft: "Post on X:" }, { type: "panel.voice" }]);
  });

  it("voice while the window's panel listens: stops it, wherever the focus is and whichever tab is shown", () => {
    const { pc, open, closeAllInstantly } = setup();
    const port = openPanel(pc, false);
    port.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    // Pressed in another tab of the window (the panel is on screen there too, still listening).
    expect(pc.onCommand(VOICE_COMMAND, tab(8))).toBe("voice");
    expect(port.posted).toEqual([{ type: "panel.voice" }]);
    expect(open).not.toHaveBeenCalled();
    expect(closeAllInstantly).not.toHaveBeenCalled();
    // Stopped: the next press starts again, through the focus path.
    port.deliver({ type: "panel.listening", listening: false });
    port.deliver({ type: "panel.document", focused: true, draft: "" });
    expect(pc.onCommand(VOICE_COMMAND, tab(7))).toBe("voice");
    expect(port.posted.slice(1)).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
  });

  it("a panel listens (this window's or another's) and the focus is in the page: nothing is recreated (the session would end)", () => {
    const { pc, closeAllInstantly, open } = setup();
    const port = openPanel(pc, false);
    port.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("focused");
    expect(port.posted).toEqual([{ type: "panel.focus" }]);

    const elsewhere = openPanel(pc, false, "", OTHER_WIN);
    // The voice key in the other window: that panel is told to take voice there (it moves the session).
    expect(pc.onCommand(VOICE_COMMAND, tab(9, OTHER_WIN))).toBe("voice");
    expect(elsewhere.posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
    expect(closeAllInstantly).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("other commands and calls without a window are ignored", () => {
    const { pc, open } = setup();
    expect(pc.onCommand("other", tab(7))).toBe("ignored");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, undefined)).toBe("ignored");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, {})).toBe("ignored");
    expect(open).not.toHaveBeenCalled();
  });

  it("a closed panel is no longer open; the next press opens it again", () => {
    const { pc } = setup();
    openPanel(pc, false).hostDisconnect();
    expect(pc.isOpen(WIN)).toBe(false);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("opened");
  });
});

describe("PanelCommands: which panel runs hands-free voice", () => {
  it("reports the session (its tab, window, panel and engine) when it starts, moves, changes engine, stops or its panel closes", () => {
    const { pc, voice } = setup();
    const port = openPanel(pc);
    const panel = port.id;
    port.deliver({ type: "panel.listening", listening: true, tabId: 3 });
    expect(voice.mock.calls).toEqual([[{ tabId: 3, windowId: WIN, panel, engine: null }]]);
    // The same again (the panel says hello to a restarted background): nothing new.
    port.deliver({ type: "panel.listening", listening: true, tabId: 3 });
    expect(voice).toHaveBeenCalledTimes(1);
    port.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "realtime" });
    expect(voice.mock.calls.at(-1)).toEqual([{ tabId: 3, windowId: WIN, panel, engine: "realtime" }]);
    // Moved to another tab ("use this tab"): the same panel runs it for tab 8.
    port.deliver({ type: "panel.listening", listening: true, tabId: 8, engine: "realtime" });
    expect(voice.mock.calls.at(-1)).toEqual([{ tabId: 8, windowId: WIN, panel, engine: "realtime" }]);
    port.deliver({ type: "panel.listening", listening: false });
    expect(voice.mock.calls.at(-1)).toEqual([null]);
    // Closed while listening: over.
    port.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "standard" });
    port.hostDisconnect();
    expect(voice.mock.calls.slice(-2)).toEqual([[{ tabId: 3, windowId: WIN, panel, engine: "standard" }], [null]]);
    expect(voice).toHaveBeenCalledTimes(6);
  });

  it("reports the session muted and unmuted (the badges and the other panels follow)", () => {
    const { pc, voice } = setup();
    const port = openPanel(pc);
    const panel = port.id;
    port.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "realtime" });
    port.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "realtime", muted: true });
    expect(voice.mock.calls.at(-1)).toEqual([{ tabId: 3, windowId: WIN, panel, engine: "realtime", muted: true }]);
    port.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "realtime" });
    expect(voice.mock.calls.at(-1)).toEqual([{ tabId: 3, windowId: WIN, panel, engine: "realtime" }]);
    // Anything but true is not muted.
    port.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "realtime", muted: "yes" as unknown as boolean });
    expect(voice).toHaveBeenCalledTimes(3);
  });

  it("listening without a tab is no session (the window still counts as listening)", () => {
    const { pc, voice } = setup();
    const c = openPanel(pc, true, "", 5);
    c.deliver({ type: "panel.listening", listening: true });
    expect(voice).not.toHaveBeenCalled();
    expect(pc.listening(5)).toBe(true);
  });

  it("Stop or Use voice here in another panel reaches the panel running it; with none, a kept session is over", () => {
    const { pc, voice } = setup();
    const a = openPanel(pc);
    const b = openPanel(pc, true, "", OTHER_WIN);
    a.deliver({ type: "panel.listening", listening: true, tabId: 3, engine: "realtime" });
    b.deliver({ type: "panel.voiceStop" });
    expect(a.posted.at(-1)).toEqual({ type: "voice.stop" });
    expect(b.posted.some((m) => (m as { type: string }).type === "voice.stop")).toBe(false);
    a.deliver({ type: "panel.listening", listening: false });
    expect(voice.mock.calls.at(-1)).toEqual([null]);
    // Nobody listens (a session kept across a worker restart whose panel is gone): it is reported over at once.
    voice.mockClear();
    b.deliver({ type: "panel.voiceStop" });
    expect(voice.mock.calls).toEqual([[null]]);
  });

  it("two panels listening at once (a moment during a hand-over): the one that started last is the session", () => {
    const { pc } = setup();
    const a = openPanel(pc);
    const b = openPanel(pc, true, "", OTHER_WIN);
    a.deliver({ type: "panel.listening", listening: true, tabId: 3 });
    b.deliver({ type: "panel.listening", listening: true, tabId: 4 });
    expect(pc.voiceSession()?.panel).toBe(b.id);
    b.deliver({ type: "panel.listening", listening: false });
    expect(pc.voiceSession()?.panel).toBe(a.id);
  });
});
