import { describe, expect, it, vi } from "vitest";
import type { BridgeRequest, NoaBrowserHost } from "@noa/shared";
import { Cdp, type DebuggerTransport } from "../../src/cdp.js";
import { HostDebugger, type SocketLike } from "../../src/noa-browser/host-debugger.js";

const HOST: NoaBrowserHost = { url: "ws://127.0.0.1:4100/", token: "tok", version: "0.1.0" };

/** A bridge on the other end of a fake socket: answers each request with `answer`. */
function fakeBridge(answer: (req: BridgeRequest) => { result?: unknown; error?: string } = () => ({ result: {} })) {
  const requests: BridgeRequest[] = [];
  const sockets: FakeSocket[] = [];
  class FakeSocket implements SocketLike {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(data: string) {
      const req = JSON.parse(data) as BridgeRequest;
      requests.push(req);
      const a = answer(req);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: req.id, ...a }) }));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    push(msg: unknown) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }
  return { requests, sockets, connect: () => new FakeSocket() };
}

function chromeFallback(): DebuggerTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    attach: async (t) => void calls.push(`attach ${t}`),
    detach: async (t) => void calls.push(`detach ${t}`),
    sendCommand: async (t, m) => (calls.push(`send ${t} ${m}`), { via: "chrome" }),
  };
}

describe("HostDebugger", () => {
  it("uses chrome.debugger outside Noa Browser", async () => {
    const fallback = chromeFallback();
    const bridge = fakeBridge();
    const t = new HostDebugger({ host: async () => null, targetOf: async () => "T1", connect: bridge.connect, onDetach: () => {}, fallback });
    await t.attach(1);
    expect(await t.sendCommand(1, "Page.navigate", { url: "https://a.test" })).toEqual({ via: "chrome" });
    await t.detach(1);
    expect(fallback.calls).toEqual(["attach 1", "send 1 Page.navigate", "detach 1"]);
    expect(bridge.sockets).toHaveLength(0);
    expect(t.inNoaBrowser).toBe(false);
  });

  it("drives tabs through the bridge in Noa Browser: hello with the token, attach by target id, commands, detach", async () => {
    const fallback = chromeFallback();
    const bridge = fakeBridge((req) => ({ result: req.op === "send" ? { frameId: "F" } : {} }));
    const t = new HostDebugger({ host: async () => HOST, targetOf: async (tabId) => `T${tabId}`, connect: bridge.connect, onDetach: () => {}, fallback });
    await t.attach(7);
    expect(await t.sendCommand(7, "Page.navigate", { url: "https://a.test" })).toEqual({ frameId: "F" });
    await t.detach(7);
    expect(bridge.requests.map(({ id: _id, ...r }) => r)).toEqual([
      { op: "hello", token: "tok" },
      { op: "attach", tabId: 7, targetId: "T7" },
      { op: "send", tabId: 7, method: "Page.navigate", params: { url: "https://a.test" } },
      { op: "detach", tabId: 7 },
    ]);
    expect(fallback.calls).toEqual([]);
    expect(bridge.sockets).toHaveLength(1);
    expect(t.inNoaBrowser).toBe(true);
  });

  it("passes the bridge's errors on as they read (restricted pages classify as in Chrome)", async () => {
    const bridge = fakeBridge((req) => (req.op === "attach" ? { error: "Cannot access a chrome:// URL" } : { result: {} }));
    const t = new HostDebugger({ host: async () => HOST, targetOf: async () => "T1", connect: bridge.connect, onDetach: () => {} });
    await expect(t.attach(1)).rejects.toThrow("Cannot access a chrome:// URL");
    await expect(t.sendCommand(1, "Runtime.evaluate")).rejects.toThrow(/not attached/);
  });

  it("an unknown tab is refused like chrome.debugger refuses it", async () => {
    const bridge = fakeBridge();
    const t = new HostDebugger({ host: async () => HOST, targetOf: async () => null, connect: bridge.connect, onDetach: () => {} });
    await expect(t.attach(99)).rejects.toThrow("No tab with given id 99.");
  });

  it("a detached event and a lost connection detach the tabs; Cdp attaches again on the next command", async () => {
    const bridge = fakeBridge();
    const detached: [number, string][] = [];
    let cdp!: Cdp;
    const t: HostDebugger = new HostDebugger({
      host: async () => HOST,
      targetOf: async (tabId) => `T${tabId}`,
      connect: bridge.connect,
      onDetach: (tabId, reason) => {
        detached.push([tabId, reason]);
        t.forget(tabId);
        cdp.handleDetach({ tabId }, reason);
      },
    });
    cdp = new Cdp(t);
    await cdp.attach(3);
    expect(cdp.attachedTabs).toEqual([3]);
    bridge.sockets[0]!.push({ event: "detached", tabId: 3, reason: "target_closed" });
    expect(cdp.attachedTabs).toEqual([]);
    await cdp.send("Runtime.evaluate", { expression: "1" });
    expect(cdp.attachedTabs).toEqual([3]);
    bridge.sockets[0]!.close();
    expect(detached).toEqual([
      [3, "target_closed"],
      [3, "target_closed"],
    ]);
    // The next command opens a new connection and attaches again.
    await cdp.send("Runtime.evaluate", { expression: "1" });
    expect(bridge.sockets).toHaveLength(2);
    const ops = bridge.requests.map((r) => r.op);
    expect(ops.filter((o) => o === "hello")).toHaveLength(2);
    expect(ops.filter((o) => o === "attach")).toHaveLength(3);
  });

  it("looks for the host again until it announces itself", async () => {
    const bridge = fakeBridge();
    const fallback = chromeFallback();
    const host = vi.fn<() => Promise<NoaBrowserHost | null>>().mockResolvedValueOnce(null).mockResolvedValue(HOST);
    const t = new HostDebugger({ host, targetOf: async () => "T1", connect: bridge.connect, onDetach: () => {}, fallback });
    await t.attach(1);
    expect(fallback.calls).toEqual(["attach 1"]);
    await t.attach(2);
    expect(bridge.requests.some((r) => r.op === "attach" && r.tabId === 2)).toBe(true);
    // Tab 1 stays on chrome.debugger until it is detached.
    await t.sendCommand(1, "Runtime.evaluate");
    expect(fallback.calls).toEqual(["attach 1", "send 1 Runtime.evaluate"]);
  });
});

describe("dialogs through the bridge", () => {
  it("a dialog event from the bridge reaches Cdp, which then refuses commands on that tab as in Chrome", async () => {
    const bridge = fakeBridge();
    let cdp!: Cdp;
    const t = new HostDebugger({
      host: async () => HOST,
      targetOf: async (tabId) => `T${tabId}`,
      connect: bridge.connect,
      onDetach: () => {},
      onEvent: (tabId, method, params) => cdp.handleEvent({ tabId }, method, params),
    });
    cdp = new Cdp(t);
    await cdp.attach(2);
    // Page.enable (dialog events) is on for every attached tab.
    expect(bridge.requests.some((r) => r.op === "send" && r.method === "Page.enable")).toBe(true);
    bridge.sockets[0]!.push({ event: "cdp", tabId: 2, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Leave site?", url: "https://a.test/" } });
    expect(cdp.dialogOf(2)).toMatchObject({ type: "confirm", message: "Leave site?" });
    await expect(cdp.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(/Leave site\?/);
    bridge.sockets[0]!.push({ event: "cdp", tabId: 2, method: "Page.javascriptDialogClosed", params: { result: false } });
    expect(cdp.dialogOf(2)).toBeNull();
  });
});

describe("parseHost", () => {
  it("takes a loopback bridge with a token, and nothing else", async () => {
    const { parseHost } = await import("../../src/noa-browser/host-debugger.js");
    expect(parseHost({ url: "ws://127.0.0.1:4100/", token: "t".repeat(32), version: "0.1.0" })).toEqual({ url: "ws://127.0.0.1:4100/", token: "t".repeat(32), version: "0.1.0" });
    expect(parseHost(null)).toBeNull();
    expect(parseHost({ url: "ws://evil.example:80/", token: "t".repeat(32) })).toBeNull();
    expect(parseHost({ url: "ws://127.0.0.1:4100/", token: "short" })).toBeNull();
  });
});
