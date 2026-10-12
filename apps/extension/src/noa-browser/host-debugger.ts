import { NOA_BROWSER_HOST_FILE, type BridgeMessage, type BridgeRequest, type NoaBrowserHost } from "@noa/shared";
import { chromeDebugger, type DebuggerTransport } from "../cdp.js";

/**
 * Inside Noa Browser the agent drives tabs through the browser's own DevTools connection, which Noa
 * Browser's host process holds (apps/browser/src/tab-bridge.ts), not through chrome.debugger: no
 * debugging bar, nothing the user cancels by mistake. In any other browser nothing changes.
 * Protocol: packages/shared/src/noa-browser.ts.
 */

type Detached = (tabId: number, reason: string) => void;
type CdpEventListener = (tabId: number, method: string, params: Record<string, unknown>) => void;

/** The few WebSocket members used (a fake in tests). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface HostDebuggerDeps {
  /** The host's address and token; null outside Noa Browser. */
  host: () => Promise<NoaBrowserHost | null>;
  /** The CDP target id of a tab (chrome.debugger.getTargets, which attaches nothing). */
  targetOf: (tabId: number) => Promise<string | null>;
  connect: (url: string) => SocketLike;
  /** The tab's session ended on the host's side (the tab closed, or its page is one the agent may not control). */
  onDetach: Detached;
  /** A CDP event of an attached tab (its JavaScript dialogs), as chrome.debugger.onEvent would give it. */
  onEvent?: CdpEventListener;
  /** Where to go outside Noa Browser (default chrome.debugger). */
  fallback?: DebuggerTransport;
}

const OPEN = 1;

/** One bridge connection: requests paired with answers by id. */
class BridgeConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(
    private readonly socket: SocketLike,
    private readonly onDetached: Detached,
    private readonly onCdpEvent: CdpEventListener,
    private readonly onClose: () => void,
  ) {
    socket.onmessage = (ev) => this.receive(String(ev.data));
    socket.onclose = () => this.close();
    socket.onerror = () => this.close();
  }

  static async open(host: NoaBrowserHost, connect: (url: string) => SocketLike, onDetached: Detached, onCdpEvent: CdpEventListener, onClose: () => void): Promise<BridgeConnection> {
    const socket = connect(host.url);
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === OPEN) return resolve();
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Noa Browser's tab bridge did not answer"));
      socket.onclose = () => reject(new Error("Noa Browser's tab bridge closed the connection"));
    });
    const conn = new BridgeConnection(socket, onDetached, onCdpEvent, onClose);
    await conn.request({ op: "hello", token: host.token });
    return conn;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === OPEN;
  }

  request(body: DistributiveOmit<BridgeRequest, "id">): Promise<unknown> {
    if (!this.isOpen) return Promise.reject(new Error("Noa Browser's tab bridge is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, ...body }));
    });
  }

  private receive(text: string): void {
    let m: BridgeMessage;
    try {
      m = JSON.parse(text) as BridgeMessage;
    } catch {
      return;
    }
    if ("event" in m) {
      if (m.event === "detached") this.onDetached(m.tabId, m.reason);
      else if (m.event === "cdp") this.onCdpEvent(m.tabId, m.method, m.params ?? {});
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if ("error" in m) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {}
    for (const p of this.pending.values()) p.reject(new Error("Noa Browser's tab bridge closed the connection"));
    this.pending.clear();
    this.onClose();
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A DebuggerTransport that uses Noa Browser's tab bridge when the host has announced one, and
 * chrome.debugger otherwise. `host` is asked at each attach until it names one, then kept.
 */
export class HostDebugger implements DebuggerTransport {
  private conn: Promise<BridgeConnection> | null = null;
  private host: NoaBrowserHost | null = null;
  /** Tabs attached through the bridge (they go on through it; a reconnection loses them). */
  private readonly viaBridge = new Set<number>();
  /** Tabs attached through chrome.debugger (before the host announced itself, or outside Noa Browser). */
  private readonly viaChrome = new Set<number>();
  private readonly fallback: DebuggerTransport;

  constructor(private readonly deps: HostDebuggerDeps) {
    this.fallback = deps.fallback ?? chromeDebugger;
  }

  /** True once the bridge is known (this is Noa Browser). */
  get inNoaBrowser(): boolean {
    return this.host !== null;
  }

  private async bridge(): Promise<BridgeConnection | null> {
    this.host ??= await this.deps.host().catch(() => null);
    if (!this.host) return null;
    const host = this.host;
    this.conn ??= BridgeConnection.open(host, this.deps.connect, this.deps.onDetach, (tabId, method, params) => this.deps.onEvent?.(tabId, method, params), () => this.lost()).catch((err) => {
      this.conn = null;
      throw err;
    });
    return this.conn;
  }

  /** The connection closed: every tab attached through it is detached. */
  private lost(): void {
    this.conn = null;
    const tabs = [...this.viaBridge];
    this.viaBridge.clear();
    for (const tabId of tabs) this.deps.onDetach(tabId, "target_closed");
  }

  async attach(tabId: number): Promise<void> {
    if (this.viaBridge.has(tabId) || this.viaChrome.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
    const conn = await this.bridge();
    if (!conn) {
      await this.fallback.attach(tabId);
      this.viaChrome.add(tabId);
      return;
    }
    const targetId = await this.deps.targetOf(tabId);
    if (!targetId) throw new Error(`No tab with given id ${tabId}.`);
    await conn.request({ op: "attach", tabId, targetId });
    this.viaBridge.add(tabId);
  }

  async detach(tabId: number): Promise<void> {
    if (this.viaChrome.delete(tabId)) return this.fallback.detach(tabId);
    if (!this.viaBridge.delete(tabId)) {
      // Not attached here: maybe by a previous service worker lifetime (Cdp retries an "already attached").
      if (!this.host) return this.fallback.detach(tabId);
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    }
    const conn = await this.bridge();
    await conn?.request({ op: "detach", tabId });
  }

  async sendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.viaChrome.has(tabId) || (!this.host && !this.viaBridge.has(tabId))) return this.fallback.sendCommand(tabId, method, params);
    if (!this.viaBridge.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    const conn = await this.bridge();
    if (!conn) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    return conn.request({ op: "send", tabId, method, ...(params ? { params } : {}) });
  }

  /** The tab's session ended (the host pushed "detached", or chrome.debugger.onDetach): forget it here too. */
  forget(tabId: number): void {
    this.viaBridge.delete(tabId);
    this.viaChrome.delete(tabId);
  }
}
/** A NoaBrowserHost from the host file's JSON, or null. */
export function parseHost(h: unknown): NoaBrowserHost | null {
  const o = h as Partial<NoaBrowserHost> | null;
  return o && typeof o.url === "string" && typeof o.token === "string" && o.token.length >= 16 && /^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(o.url)
    ? { url: o.url, token: o.token, version: String(o.version ?? "") }
    : null;
}

/**
 * The bridge Noa Browser's host wrote into this extension's folder before the browser started, or null
 * (not Noa Browser: the file is not there). Read once per service worker.
 */
let hostFile: Promise<NoaBrowserHost | null> | null = null;
export function announcedHost(): Promise<NoaBrowserHost | null> {
  hostFile ??= fetch(chrome.runtime.getURL(NOA_BROWSER_HOST_FILE))
    .then((r) => (r.ok ? r.json() : null))
    .then(parseHost)
    .catch(() => null);
  return hostFile;
}

/** A tab's CDP target id, from chrome.debugger.getTargets (which attaches nothing). */
export async function chromeTargetOf(tabId: number): Promise<string | null> {
  const targets = await chrome.debugger.getTargets();
  return targets.find((t) => t.tabId === tabId && t.type === "page")?.id ?? null;
}

/** The transport the service worker's Cdp uses: the tab bridge in Noa Browser, chrome.debugger elsewhere. */
export function noaBrowserAwareDebugger(onDetach: Detached, onEvent?: CdpEventListener): HostDebugger {
  const transport: HostDebugger = new HostDebugger({
    host: announcedHost,
    targetOf: chromeTargetOf,
    connect: (url) => new WebSocket(url) as unknown as SocketLike,
    onDetach: (tabId, reason) => {
      transport.forget(tabId);
      onDetach(tabId, reason);
    },
    onEvent,
  });
  return transport;
}
