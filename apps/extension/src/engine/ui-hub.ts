/** Open side panel ports and the UiPush messages sent to them; options page ports get the state pushes only. */
import type { SessionInfo, StampedAgentEvent } from "@noa/shared";
import { OPTIONS_PORT_NAME, UI_PORT_NAME, type UiPush, type UiState } from "../ui-protocol.js";

export interface PortLike {
  name: string;
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(fn: () => void): void };
}

/** Open UI ports and the pushes to them. State pushes are coalesced, and never go out older than one already sent. */
export class UiHub {
  private readonly ports = new Set<PortLike>();
  /** Options page ports: they get each state, nothing else. */
  private readonly watchers = new Set<PortLike>();
  private statePending = false;
  /** Each state read is numbered; a read that finishes after a later one was pushed is stale and dropped. */
  private stateReads = 0;
  private statePushed = 0;

  constructor(
    private readonly getState: () => Promise<UiState>,
    private readonly opts: { stateDelayMs?: number } = {},
  ) {}

  get size(): number {
    return this.ports.size;
  }

  /** chrome.runtime.onConnect handler for side panels. Ignores ports with other names. */
  attach(port: PortLike): boolean {
    return this.add(port, UI_PORT_NAME, this.ports);
  }

  /** chrome.runtime.onConnect handler for options pages (state pushes only). Ignores ports with other names. */
  watch(port: PortLike): boolean {
    return this.add(port, OPTIONS_PORT_NAME, this.watchers);
  }

  private add(port: PortLike, name: string, set: Set<PortLike>): boolean {
    if (port.name !== name) return false;
    set.add(port);
    port.onDisconnect.addListener(() => set.delete(port));
    void this.readState((state) => this.post(port, { type: "state", state }, set));
    return true;
  }

  push(msg: UiPush): void {
    for (const p of this.ports) this.post(p, msg, this.ports);
  }

  event(event: StampedAgentEvent): void {
    this.push({ type: "event", event });
  }

  session(session: SessionInfo): void {
    this.push({ type: "session", session });
    this.pushState();
  }

  /** Pushes a fresh UiState soon (several calls in a row send one). */
  pushState(): void {
    if (this.statePending || !this.listening) return;
    this.statePending = true;
    setTimeout(() => {
      this.statePending = false;
      if (!this.listening) return;
      void this.readState((state) => {
        const msg: UiPush = { type: "state", state };
        this.push(msg);
        for (const p of this.watchers) this.post(p, msg, this.watchers);
      });
    }, this.opts.stateDelayMs ?? 50);
  }

  private get listening(): boolean {
    return this.ports.size + this.watchers.size > 0;
  }

  /**
   * Reads the state and sends it, unless a read started later was sent first (reads take a while and can
   * finish out of order: an older state must not overwrite a newer one in the panel).
   */
  private async readState(send: (state: UiState) => void): Promise<void> {
    const read = ++this.stateReads;
    try {
      const state = await this.getState();
      if (read < this.statePushed) return;
      this.statePushed = read;
      send(state);
    } catch {
      // The next change pushes again.
    }
  }

  private post(port: PortLike, msg: UiPush, set: Set<PortLike>): void {
    try {
      port.postMessage(msg);
    } catch {
      set.delete(port);
    }
  }
}
