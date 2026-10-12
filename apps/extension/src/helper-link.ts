import {
  errorMessage,
  NATIVE_HOST_NAME,
  RpcPeer,
  type BrowserMethods,
  type HelperInfo,
  type HelperMethods,
  type HelperNotifications,
  type RpcMessage,
  type MemoryMethods,
  type TodoMethods,
} from "@noa/shared";
import { Listeners } from "./listeners.js";

export type HelperPeer = RpcPeer<HelperMethods, BrowserMethods & TodoMethods & MemoryMethods>;

export interface HelperLinkOptions {
  /** Registers the browser.* and vault.* handlers on each new peer. */
  registerHandlers: (peer: HelperPeer) => void;
  hostName?: string;
}

/** helper.hello may run the Claude Code self-test (up to 60 s) before answering. */
const HELLO_TIMEOUT_MS = 75_000;
/** A quick helper call (logs, ending a session): not a task run. */
export const HELPER_CALL_TIMEOUT_MS = 15_000;

type NotificationName = keyof HelperNotifications & string;
type NotificationListeners = { [N in NotificationName]?: Listeners<[HelperNotifications[N]]> };

/** Why the link is down when Chrome gives no reason. */
const DISCONNECTED = "Helper disconnected";

/** Chrome could not find the native messaging host. */
export const HELPER_NOT_INSTALLED = "Helper not installed";

/** Chrome's native messaging errors, in plain words. */
const CHROME_ERRORS: [RegExp, string][] = [
  [/native messaging host not found/i, HELPER_NOT_INSTALLED],
  [/access to the specified native messaging host is forbidden/i, "Helper installed for another extension ID"],
  [/native host has exited/i, "Helper exited"],
  [/error when communicating with the native messaging host/i, "Helper crashed"],
];

export function helperErrorText(chromeMessage: string): string {
  return CHROME_ERRORS.find(([re]) => re.test(chromeMessage))?.[1] ?? chromeMessage;
}

/**
 * The native messaging connection to the local helper. One RpcPeer per port;
 * connect() opens a new port when the previous one is gone.
 */
export class HelperLink {
  private port: chrome.runtime.Port | null = null;
  private peer: HelperPeer | null = null;
  private helperInfo: HelperInfo | null = null;
  private connecting: Promise<HelperInfo> | null = null;
  private readonly disconnects = new Listeners<[reason: string]>();
  private readonly infos = new Listeners<[info: HelperInfo | null]>();
  /** Per notification the helper sends, its listeners (only those subscribed to are delivered). */
  private readonly notifications: NotificationListeners = {};
  /** Delivers each subscribed notification from a peer to its listeners. */
  private readonly deliveries: ((peer: HelperPeer) => void)[] = [];
  private lastErrorText: string | null = null;

  constructor(private readonly opts: HelperLinkOptions) {}

  get connected(): boolean {
    return this.peer !== null && this.helperInfo !== null;
  }

  get info(): HelperInfo | null {
    return this.helperInfo;
  }

  /** Why the last connect failed or the port closed; null while connected. */
  get lastError(): string | null {
    return this.lastErrorText;
  }

  /**
   * Opens the port if needed and says hello. Resolves with the helper info.
   * selfTest: ask the helper to (re-)run its Claude Code self-test, also on
   * an existing connection.
   */
  connect(timeoutMs = HELLO_TIMEOUT_MS, opts: { selfTest?: boolean } = {}): Promise<HelperInfo> {
    if (this.peer && this.helperInfo) return opts.selfTest ? this.rehello(this.peer, timeoutMs) : Promise.resolve(this.helperInfo);
    if (!this.connecting) {
      this.connecting = this.open(timeoutMs, !!opts.selfTest).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /** Subscribe to a helper notification (survives reconnects). Returns an unsubscribe function. */
  onNotification<N extends NotificationName>(method: N, fn: (params: HelperNotifications[N]) => void): () => void {
    return this.listenersOf(method).add(fn);
  }

  /** Called with the new info after every hello and with null on disconnect. */
  onInfo(fn: (info: HelperInfo | null) => void): () => void {
    return this.infos.add(fn);
  }

  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts: { timeoutMs?: number } = {},
  ): Promise<HelperMethods[M]["result"]> {
    if (!this.peer || !this.helperInfo) return Promise.reject(new Error("Helper not connected"));
    return this.peer.call(method, params, opts);
  }

  /** Subscribe to port loss. Returns an unsubscribe function. */
  onDisconnect(fn: (reason: string) => void): () => void {
    return this.disconnects.add(fn);
  }

  disconnect(reason = DISCONNECTED): void {
    const port = this.port;
    this.teardown(reason);
    try {
      port?.disconnect();
    } catch {
      /* already gone */
    }
  }

  private async rehello(peer: HelperPeer, timeoutMs: number): Promise<HelperInfo> {
    const info = await peer.call("helper.hello", { selfTest: true }, { timeoutMs });
    if (this.peer === peer) this.setInfo(info);
    return info;
  }

  private setInfo(info: HelperInfo | null): void {
    this.helperInfo = info;
    this.infos.emit(info);
  }

  /** The listeners of a notification; the first subscriber has it delivered from the current peer (later peers: open()). */
  private listenersOf<N extends NotificationName>(method: N): Listeners<[HelperNotifications[N]]> {
    const known = this.notifications[method];
    if (known) return known;
    const created = new Listeners<[HelperNotifications[N]]>();
    // TypeScript cannot check a write through a generic key of a mapped type; this is the entry for N.
    this.notifications[method] = created as NotificationListeners[N];
    const deliver = (peer: HelperPeer) => peer.onNotification<HelperNotifications[N]>(method, (params) => created.emit(params));
    this.deliveries.push(deliver);
    if (this.peer) deliver(this.peer);
    return created;
  }

  private async open(timeoutMs: number, selfTest: boolean): Promise<HelperInfo> {
    const hostName = this.opts.hostName ?? NATIVE_HOST_NAME;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(hostName);
    } catch (err) {
      this.lastErrorText = helperErrorText(errorMessage(err));
      throw new Error(this.lastErrorText);
    }
    const peer: HelperPeer = new RpcPeer<HelperMethods, BrowserMethods & TodoMethods & MemoryMethods>((msg) => port.postMessage(msg), "e");
    this.opts.registerHandlers(peer);
    for (const deliver of this.deliveries) deliver(peer);
    this.port = port;
    this.peer = peer;
    port.onMessage.addListener((m: unknown) => {
      void peer.receive(m as RpcMessage);
    });
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message;
      const reason = message ? helperErrorText(message) : DISCONNECTED;
      if (this.port === port) this.teardown(reason);
      else peer.close(reason);
    });
    try {
      const info = await peer.call("helper.hello", selfTest ? { selfTest: true } : {}, { timeoutMs });
      if (this.port !== port) throw new Error(this.lastErrorText ?? DISCONNECTED);
      this.lastErrorText = null;
      this.setInfo(info);
      return info;
    } catch (err) {
      const msg = errorMessage(err);
      if (this.port === port) this.disconnect(msg);
      this.lastErrorText = msg;
      throw err;
    }
  }

  private teardown(reason: string): void {
    const hadPeer = this.peer !== null;
    const wasConnected = this.helperInfo !== null;
    this.peer?.close(reason);
    this.port = null;
    this.peer = null;
    this.lastErrorText = reason;
    if (wasConnected) this.setInfo(null);
    else this.helperInfo = null;
    if (hadPeer && wasConnected) this.disconnects.emit(reason);
  }
}
