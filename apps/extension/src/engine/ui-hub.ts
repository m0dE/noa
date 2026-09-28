/** Open side panel ports and the UiPush messages sent to them. */
import type { SessionInfo, StampedAgentEvent } from "@noa/shared";
import { UI_PORT_NAME, type UiPush, type UiState } from "../ui-protocol.js";

export interface PortLike {
  name: string;
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(fn: () => void): void };
}

/** Open UI ports and the pushes to them. State pushes are coalesced, and never go out older than one already sent. */
export class UiHub {
  private readonly ports = new Set<PortLike>();
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

  /** chrome.runtime.onConnect handler. Ignores ports with other names. */
  attach(port: PortLike): boolean {
    if (port.name !== UI_PORT_NAME) return false;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    void this.readState((state) => this.post(port, { type: "state", state }));
    return true;
  }

  push(msg: UiPush): void {
    for (const p of this.ports) this.post(p, msg);
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
    if (this.statePending || this.ports.size === 0) return;
    this.statePending = true;
    setTimeout(() => {
      this.statePending = false;
      if (this.ports.size === 0) return;
      void this.readState((state) => this.push({ type: "state", state }));
    }, this.opts.stateDelayMs ?? 50);
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

  private post(port: PortLike, msg: UiPush): void {
    try {
      port.postMessage(msg);
    } catch {
      this.ports.delete(port);
    }
  }
}
