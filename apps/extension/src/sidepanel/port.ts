/**
 * The side panel's push port to the background. The background (a service
 * worker) may restart at any time, so the port reconnects by itself and
 * `onConnect` runs again each time (say hello, refetch the state).
 */
import { UI_PORT_NAME, type UiPush } from "../ui-protocol.js";
import type { PanelMessage } from "../panel-command.js";

/** Wait before connecting again after the port dropped. */
const RECONNECT_MS = 1000;

export interface BackgroundPort {
  /** Sends when connected; while reconnecting the message is dropped (onConnect says it again). */
  send(msg: PanelMessage): void;
}

export function connectBackground(onPush: (msg: UiPush) => void, onConnect: () => void): BackgroundPort {
  let port: chrome.runtime.Port | null = null;

  function connect(): void {
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connect({ name: UI_PORT_NAME });
    } catch {
      setTimeout(connect, RECONNECT_MS);
      return;
    }
    port = p;
    p.onMessage.addListener((m: UiPush) => onPush(m));
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      setTimeout(connect, RECONNECT_MS);
    });
    onConnect();
  }

  connect();
  return {
    send(msg) {
      try {
        port?.postMessage(msg);
      } catch {
        // Reconnecting; onConnect says it again.
      }
    },
  };
}
