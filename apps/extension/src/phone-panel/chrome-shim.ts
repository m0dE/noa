/**
 * The part of `chrome` the side panel (sidepanel/, ui/, voice/) and Settings (options/) use, for those pages on a paired
 * phone (panel.ts, settings.ts). Requests and the push port go over the phone link to the computer's background (PhonePanelBridge), so
 * the panel works on the computer's jobs and tabs as it does there. What only exists on the computer has a phone's
 * stand-in:
 *
 * - The phone has no tab of the computer's in front: no active tab, no window, so a new job gets a window of its own
 *   there (phone-link/link.ts).
 * - Going to a job's tab (View on its page) shows that tab live on the phone (the remote screen), to watch it, or to
 *   take it over while the job waits for the user.
 * - Links open on the phone. Settings open over the panel, on the computer's settings. The panel has no keyboard
 *   shortcuts on a phone (no `chrome.commands`: it offers none).
 * - On the Settings page, the extension's version and id, its keyboard shortcuts, the computer's system (the helper's
 *   install steps) and Noa Browser's bookmark sync are the computer's (DesktopInfo); Chrome's shortcuts page is too.
 * - The microphone is the phone's: its own prompt asks for it.
 */
import type { DesktopInfo, PhonePanelBridge } from "@noa/shared/phone-link/panel-bridge";
import type { PanelMessage } from "../panel-command.js";
import type { UiResponse } from "../ui-protocol.js";
import { MIC_PERMISSION_PAGE } from "../voice/mic-access.js";

/** Where the extension's files are on the phone's site (the PCM worklet, icons; the pages below are only names here). */
export const PHONE_PANEL_BASE = "/phone-panel/";
const OPTIONS_PAGE = "options.html";
export const SHORTCUTS_ON_COMPUTER = "Keyboard shortcuts are set in Chrome on your computer: open chrome://extensions/shortcuts there.";
/** Settings > Account > Your phone asks the background with these, and takes its answer as it is (not a UiResponse). */
const PHONE_SECTION = new Set(["phone.view", "phone.pair", "phone.unpair"]);

type Listener = (...args: never[]) => unknown;
const noEvent = () => ({ addListener: (_fn: Listener) => {}, removeListener: (_fn: Listener) => {}, hasListener: () => false });

/** What `tab.focus` and `agent.show` answer the phone with (link.ts): the job whose tab it is, to show on the phone. */
interface ScreenAnswer {
  ok: boolean;
  screen?: { sessionId: string; takeover: boolean };
}

export function phoneChrome(bridge: PhonePanelBridge, origin: string, desktop?: DesktopInfo): typeof chrome {
  const base = `${origin}${PHONE_PANEL_BASE}`;

  async function sendMessage(req: { type: string } & Record<string, unknown>): Promise<unknown> {
    const res = (await bridge.request(req)) as UiResponse;
    if (PHONE_SECTION.has(req.type)) return res.ok ? res.data : { error: res.error };
    // The job's tab: on the phone's screen, not brought forward on the computer (where nobody may be looking).
    if (res.ok && (req.type === "tab.focus" || req.type === "agent.show")) {
      const screen = (res.data as ScreenAnswer | undefined)?.screen;
      if (screen) bridge.showScreen(screen.sessionId, screen.takeover);
      return { ok: true, data: { ok: !!screen } };
    }
    return res;
  }

  /** The phone's microphone prompt (the extension asks on a page of its own: mic-access.ts). */
  async function askMic(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
    } catch {
      // Refused: the panel sees the permission as it is.
    }
  }

  async function createTab(props: { url?: string }): Promise<chrome.tabs.Tab> {
    const url = props.url ?? "";
    if (url.startsWith(base)) {
      const page = url.slice(base.length);
      if (page.startsWith(MIC_PERMISSION_PAGE)) await askMic();
      else if (page.startsWith(OPTIONS_PAGE)) bridge.openSettings(page.split("#")[1] ?? "");
    } else if (url.startsWith("chrome://extensions/shortcuts")) bridge.say(SHORTCUTS_ON_COMPUTER);
    else if (/^https?:/.test(url)) bridge.open(url);
    return { id: -1 } as chrome.tabs.Tab;
  }

  function connect(info: { name?: string } = {}): chrome.runtime.Port {
    const message: Listener[] = [];
    const disconnect: Listener[] = [];
    const port = bridge.connect(
      info.name ?? "",
      (msg) => {
        for (const fn of message) (fn as (m: unknown) => void)(msg);
      },
      () => {
        for (const fn of disconnect) (fn as () => void)();
      },
    );
    if (!port) throw new Error("Your computer is not connected");
    return {
      name: info.name ?? "",
      onMessage: { addListener: (fn: Listener) => void message.push(fn) },
      onDisconnect: { addListener: (fn: Listener) => void disconnect.push(fn) },
      postMessage: (msg: PanelMessage) => {
        // The view the panel shows: the computer counts its conversation as watched. The rest is about the
        // computer's windows (its keyboard shortcuts, hands-free voice's badges).
        if (msg.type === "panel.document") void bridge.request({ type: "phone.watch", job: msg.job ?? null }).catch(() => {});
      },
      disconnect: () => port.close(),
    } as unknown as chrome.runtime.Port;
  }

  return {
    runtime: {
      id: desktop?.id ?? "phone",
      sendMessage,
      connect,
      getURL: (path: string) => `${base}${path.replace(/^\//, "")}`,
      getManifest: () => (desktop ? { version: desktop.version } : {}),
      openOptionsPage: async () => bridge.openSettings(""),
      onMessage: noEvent(),
    },
    // Noa Browser's bookmark sync: its state is in the computer's storage (the Settings page reads that one key).
    ...(desktop?.bookmarks ? { bookmarks: {} } : {}),
    // The computer's keyboard shortcuts, on the Settings page.
    ...(desktop ? { commands: { getAll: async () => Object.entries(desktop.shortcuts).map(([name, shortcut]) => ({ name, shortcut })) } } : {}),
    storage: {
      local: {
        get: async (key: string) => {
          const res = (await bridge.request({ type: "phone.storage", key })) as UiResponse;
          return res.ok ? { [key]: res.data ?? undefined } : {};
        },
      },
      onChanged: noEvent(),
    },
    tabs: {
      // A tab of the computer's: its title and address, for the job page's "Working in" row.
      get: async (tabId: number) => {
        const res = (await bridge.request({ type: "phone.tab", tabId })) as UiResponse<{ title: string; url: string; favIconUrl?: string } | null>;
        if (!res.ok || !res.data) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, ...res.data } as chrome.tabs.Tab;
      },
      query: async () => [],
      getCurrent: async () => undefined,
      create: createTab,
      update: async () => undefined,
      remove: async () => undefined,
      onActivated: noEvent(),
      onUpdated: noEvent(),
      onRemoved: noEvent(),
      onAttached: noEvent(),
      onDetached: noEvent(),
    },
    windows: {
      getCurrent: async () => ({}),
      update: async () => undefined,
      onFocusChanged: noEvent(),
    },
  } as unknown as typeof chrome;
}
