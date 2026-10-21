import type { PhonePanelBridge } from "@noa/shared/phone-link/panel-bridge";
import { describe, expect, it, vi } from "vitest";
import { phoneChrome } from "../../src/phone-panel/chrome-shim.js";

function setup(answer: (req: { type: string } & Record<string, unknown>) => unknown = () => ({ ok: true, data: null })) {
  const requests: Record<string, unknown>[] = [];
  const bridge = {
    request: vi.fn(async (req: { type: string } & Record<string, unknown>) => {
      requests.push(req);
      return answer(req);
    }),
    connect: vi.fn((_name: string, _onPush: (m: unknown) => void, _onClose: () => void) => ({ close: vi.fn() })),
    showScreen: vi.fn(),
    open: vi.fn(),
    openSettings: vi.fn(),
    say: vi.fn(),
  } satisfies PhonePanelBridge;
  return { bridge, requests, c: phoneChrome(bridge, "https://noa.test") };
}

describe("the side panel's chrome on a phone", () => {
  it("sends the panel's requests to the computer and gives back its answers", async () => {
    const { c, requests } = setup(() => ({ ok: true, data: { rev: 1 } }));
    await expect(c.runtime.sendMessage({ type: "state.get" })).resolves.toEqual({ ok: true, data: { rev: 1 } });
    expect(requests).toEqual([{ type: "state.get" }]);
  });

  it("going to a job's tab shows it on the phone's screen, to take over when the job waits", async () => {
    const { c, bridge } = setup(() => ({ ok: true, data: { ok: true, screen: { sessionId: "s1", takeover: true } } }));
    await expect(c.runtime.sendMessage({ type: "tab.focus", tabId: 5 })).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(bridge.showScreen).toHaveBeenCalledWith("s1", true);
  });

  it("has no active tab or window of its own; a tab's title comes from the computer", async () => {
    const { c } = setup((req) => (req.type === "phone.tab" ? { ok: true, data: { title: "Log in", url: "https://market.test/login" } } : { ok: true, data: null }));
    await expect(c.tabs.query({ active: true, currentWindow: true })).resolves.toEqual([]);
    await expect(c.windows.getCurrent()).resolves.toEqual({});
    await expect(c.tabs.get(7)).resolves.toEqual({ id: 7, title: "Log in", url: "https://market.test/login" });
    expect(c.commands).toBeUndefined();
  });

  it("opens web links on the phone, Settings over the panel, and asks for the microphone on the phone", async () => {
    const { c, bridge } = setup();
    await c.tabs.create({ url: "https://noa.test/billing" });
    expect(bridge.open).toHaveBeenCalledWith("https://noa.test/billing");
    await c.tabs.create({ url: c.runtime.getURL("options.html") + "#ai" });
    await c.runtime.openOptionsPage();
    expect(bridge.openSettings.mock.calls).toEqual([["ai"], [""]]);
    await c.tabs.create({ url: "javascript:alert(1)" });
    expect(bridge.open).toHaveBeenCalledTimes(1);
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await c.tabs.create({ url: c.runtime.getURL("mic-permission.html") });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(c.runtime.getURL("pcm-worklet.js")).toBe("https://noa.test/phone-panel/pcm-worklet.js");
    vi.unstubAllGlobals();
  });

  it("on the Settings page: the computer's extension and system; Your phone's answers as the page takes them", async () => {
    const { bridge } = setup();
    bridge.request.mockImplementation(async (req) =>
      req.type === "phone.view" ? { ok: true, data: { phones: [] } } : req.type === "phone.pair" ? { ok: false, error: "Sign in first" } : { ok: true, data: { lastSyncAt: "t" } },
    );
    const c = phoneChrome(bridge, "https://noa.test", { version: "1.2.3", id: "abc", userAgent: "Windows", bookmarks: true, helperCode: "0123456789ab", shortcuts: { "open-chat": "Ctrl+Period", voice: "" } });
    expect(c.runtime.getManifest()).toEqual({ version: "1.2.3" });
    expect(c.runtime.id).toBe("abc");
    expect(c.bookmarks).toBeDefined();
    await expect(c.storage.local.get("bookmarkSync")).resolves.toEqual({ bookmarkSync: { lastSyncAt: "t" } });
    await expect(c.runtime.sendMessage({ type: "phone.view" })).resolves.toEqual({ phones: [] });
    await expect(c.runtime.sendMessage({ type: "phone.pair" })).resolves.toEqual({ error: "Sign in first" });
    await expect(c.commands.getAll()).resolves.toEqual([
      { name: "open-chat", shortcut: "Ctrl+Period" },
      { name: "voice", shortcut: "" },
    ]);
    await c.tabs.create({ url: "chrome://extensions/shortcuts" });
    expect(bridge.say).toHaveBeenCalledTimes(1);
    expect(phoneChrome(bridge, "https://noa.test").bookmarks).toBeUndefined();
  });

  it("the push port: pushes reach the panel, the view it shows is told as watched, a closed link disconnects it", () => {
    const { c, bridge, requests } = setup();
    const port = c.runtime.connect({ name: "noa-ui" });
    const [, onPush, onClose] = bridge.connect.mock.calls[0]!;
    const pushes: unknown[] = [];
    let gone = false;
    port.onMessage.addListener((m: unknown) => void pushes.push(m));
    port.onDisconnect.addListener(() => void (gone = true));
    onPush({ type: "tasks.changed" });
    expect(pushes).toEqual([{ type: "tasks.changed" }]);
    port.postMessage({ type: "panel.document", focused: true, draft: "", job: "chat:s1" });
    port.postMessage({ type: "panel.hello", windowId: 1, panel: "p" });
    expect(requests).toEqual([{ type: "phone.watch", job: "chat:s1" }]);
    onClose();
    expect(gone).toBe(true);
    // Not connected: the panel's port.ts tries again later.
    bridge.connect.mockReturnValueOnce(null as never);
    expect(() => c.runtime.connect({ name: "noa-ui" })).toThrow();
  });
});
