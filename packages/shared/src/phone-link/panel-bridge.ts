/**
 * Between the phone page (apps/dashboard/src/phone/) and the extension's pages it shows (apps/extension/src/phone-panel/:
 * the side panel, and Settings in a frame over it): the page keeps the link to the computer and hands them this bridge,
 * as `globalThis.__noaPhoneBridge` (the Settings frame reads its parent's), before it loads them. The panel's requests and pushes are the extension's own (ui-protocol.ts), carried as plain JSON values.
 */
export interface PhonePanelBridge {
  /** A side panel request; resolves to its UiResponse. Waits while the computer is not connected. */
  request(req: { type: string } & Record<string, unknown>): Promise<unknown>;
  /** Opens the panel's push port (UI_PORT_NAME); null while the computer is not connected (the panel tries again). */
  connect(name: string, onPush: (msg: unknown) => void, onClose: () => void): { close(): void } | null;
  /** The job's tab on the computer, live on the phone (screen-view.ts); takeover: the user drives it. */
  showScreen(sessionId: string, takeover: boolean): void;
  /** An address opened on the phone (a result's link, the dashboard). */
  open(url: string): void;
  /** The extension's Settings over the panel, on a section (`ai`, `account`, …; "": the first). */
  openSettings(section: string): void;
  /** Something only the computer can do (Chrome's keyboard shortcuts page): said on the phone. */
  say(text: string): void;
}

export const PHONE_BRIDGE_GLOBAL = "__noaPhoneBridge";

/** What the Settings page shows of the computer's extension (`phone.info`, answered by the computer). */
export interface DesktopInfo {
  /** The extension's version. */
  version: string;
  /** The extension's id (the helper's install command names it). */
  id: string;
  /** The computer's browser (the helper's install steps are for its system). */
  userAgent: string;
  /** Noa Browser (its copy of Noa has bookmark sync). */
  bookmarks: boolean;
  /** The helper code the extension was built with (its install command and status name it). */
  helperCode: string;
  /** The extension's keyboard shortcuts in the computer's Chrome (command name -> keys; "": none set). */
  shortcuts: Record<string, string>;
}
