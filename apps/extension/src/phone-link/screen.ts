/**
 * The remote screen (docs/MOBILE.md, section 3): a job's tab, live on the paired phone, and driven from it when the
 * user takes over (a sign-in, a code, a CAPTCHA).
 *
 * Frames are screenshots of the tab (Page.captureScreenshot), one in flight: the next is taken once the phone drew
 * the last, at once after the user's input, else when the page changed. Chrome paints a background tab unreliably
 * (driver.ts BACKGROUND_SHOT_TIMEOUT_MS) but always the active tab of a window, so a tab that is not active in its
 * window is moved to a minimized window of its own first.
 *
 * Taking over is only for a job whose turn is not running (the agent paused for the user, or finished): the agent and
 * the user never act on the page at once. The tab is then laid out at the phone's size (Emulation), and put back when
 * the screen stops or a turn starts. What the user types is typed into the page and nowhere else: never stored,
 * logged or sent to the AI.
 */
import type { DesktopMessage } from "@noa/shared/phone-link/protocol";

export interface ScreenDeps {
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The job's tab (null: it has none now). */
  tabOf(sessionId: string): Promise<number | null>;
  /** Makes the tab the active tab of a window, so it paints (a minimized window of its own when it is not). */
  makePaintable(tabId: number): Promise<void>;
  tabInfo(tabId: number): Promise<{ url: string; title: string; favIconUrl?: string } | null>;
  running(sessionId: string): boolean;
  post(msg: DesktopMessage): void;
  log(message: string): void;
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
};

/** How long to wait for the phone to draw a frame before sending the next anyway. */
const ACK_TIMEOUT_MS = 3000;
/** A quiet page is looked at this often. */
const IDLE_MS = 400;
/** After the user's input, the page's moment to react before the next look. */
const AFTER_INPUT_MS = 90;
const JPEG_QUALITY = 60;

const FOCUSED = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e) return { editable: false, password: false };
  const tag = e.tagName;
  const type = (e.getAttribute && (e.getAttribute("type") || "")).toLowerCase();
  const editable = e.isContentEditable || tag === "TEXTAREA" || (tag === "INPUT" && !["button", "submit", "checkbox", "radio", "file", "image", "reset", "range", "color", "hidden"].includes(type));
  return { editable, password: tag === "INPUT" && type === "password" };
})()`;

export class RemoteScreen {
  private active: {
    sessionId: string;
    tabId: number;
    width: number;
    height: number;
    interactive: boolean;
    frameId: number;
    acked: (() => void) | null;
    poke: (() => void) | null;
    last: string;
    stopped: boolean;
  } | null = null;

  constructor(private readonly deps: ScreenDeps) {}

  get sessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  async start(sessionId: string, width: number, height: number, takeover: boolean): Promise<void> {
    await this.stop("replaced");
    const tabId = await this.deps.tabOf(sessionId);
    if (tabId === null) {
      this.deps.post({ type: "screen.stopped", reason: "This job has no open tab on the computer." });
      return;
    }
    await this.deps.makePaintable(tabId);
    const interactive = takeover && !this.deps.running(sessionId);
    const a = { sessionId, tabId, width, height, interactive, frameId: 0, acked: null, poke: null, last: "", stopped: false };
    this.active = a;
    if (interactive) await this.layOut(a);
    const info = await this.deps.tabInfo(tabId);
    this.deps.post({ type: "screen.started", sessionId, interactive, url: info?.url ?? "", title: info?.title ?? "" });
    void this.loop(a);
  }

  async stop(reason = "stopped"): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    a.stopped = true;
    a.acked?.();
    a.poke?.();
    if (a.interactive) await this.deps.send(a.tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    if (reason !== "replaced") this.deps.post({ type: "screen.stopped", reason });
  }

  ack(frameId: number): void {
    if (this.active?.frameId === frameId) this.active.acked?.();
  }

  async tap(x: number, y: number): Promise<void> {
    const a = this.driving();
    if (!a) return;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.deps.send(a.tabId, "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
    this.soon(a);
    const focus = (await this.deps.send(a.tabId, "Runtime.evaluate", { expression: FOCUSED, returnByValue: true }).catch(() => null)) as {
      result?: { value?: { editable?: boolean; password?: boolean } };
    } | null;
    const v = focus?.result?.value;
    this.deps.post({ type: "screen.focus", editable: !!v?.editable, password: !!v?.password });
  }

  async text(text: string): Promise<void> {
    const a = this.driving();
    if (!a || !text) return;
    await this.deps.send(a.tabId, "Input.insertText", { text });
    this.soon(a);
  }

  async key(name: string): Promise<void> {
    const a = this.driving();
    const k = KEYS[name];
    if (!a || !k) return;
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.deps.send(a.tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await this.deps.send(a.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    this.soon(a);
  }

  async scroll(dy: number): Promise<void> {
    const a = this.driving();
    if (!a) return;
    await this.deps.send(a.tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: a.width / 2, y: a.height / 2, deltaX: 0, deltaY: dy });
    this.soon(a);
  }

  /** The session the user drives now; a turn that started since ends the driving (the agent has the page). */
  private driving(): NonNullable<RemoteScreen["active"]> | null {
    const a = this.active;
    if (!a?.interactive) return null;
    if (this.deps.running(a.sessionId)) {
      void this.downgrade(a);
      return null;
    }
    return a;
  }

  private async downgrade(a: NonNullable<RemoteScreen["active"]>): Promise<void> {
    if (!a.interactive) return;
    a.interactive = false;
    await this.deps.send(a.tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    const info = await this.deps.tabInfo(a.tabId);
    this.deps.post({ type: "screen.started", sessionId: a.sessionId, interactive: false, url: info?.url ?? "", title: info?.title ?? "" });
  }

  private async layOut(a: NonNullable<RemoteScreen["active"]>): Promise<void> {
    // The page at the phone's size, so a sign-in form is readable and tappable there.
    await this.deps.send(a.tabId, "Emulation.setDeviceMetricsOverride", { width: a.width, height: a.height, deviceScaleFactor: 2, mobile: true }).catch((e: unknown) => {
      this.deps.log(`remote screen: could not lay the page out for the phone: ${String(e)}`);
    });
  }

  private soon(a: NonNullable<RemoteScreen["active"]>): void {
    setTimeout(() => a.poke?.(), AFTER_INPUT_MS);
  }

  private async loop(a: NonNullable<RemoteScreen["active"]>): Promise<void> {
    while (!a.stopped) {
      if (a.interactive && this.deps.running(a.sessionId)) await this.downgrade(a);
      let shot: string | null = null;
      let width = a.width;
      let height = a.height;
      try {
        const m = (await this.deps.send(a.tabId, "Page.getLayoutMetrics")) as { cssVisualViewport?: { clientWidth: number; clientHeight: number; pageX: number; pageY: number } };
        const v = m.cssVisualViewport;
        if (v) {
          width = Math.round(v.clientWidth);
          height = Math.round(v.clientHeight);
        }
        // Wide desktop pages are scaled down to about twice the phone's width; the phone pinches to zoom.
        const scale = v ? Math.min(2, (a.width * 2) / Math.max(1, v.clientWidth)) : 1;
        const clip = v ? { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } : undefined;
        const r = (await this.deps.send(a.tabId, "Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY, ...(clip ? { clip } : {}) })) as { data?: string };
        shot = r.data ?? null;
      } catch (e) {
        if (a.stopped) return;
        this.deps.log(`remote screen: ${String(e)}`);
        if (/No tab with given id|Cannot access|detached|closed/i.test(String(e))) return void this.stop("The job's tab was closed.");
      }
      if (a.stopped) return;
      if (shot && shot !== a.last) {
        a.last = shot;
        a.frameId++;
        const info = await this.deps.tabInfo(a.tabId);
        const acked = new Promise<void>((resolve) => {
          a.acked = resolve;
          setTimeout(resolve, ACK_TIMEOUT_MS);
        });
        this.deps.post({ type: "screen.frame", frameId: a.frameId, jpeg: shot, width, height, url: info?.url ?? "" });
        await acked;
        a.acked = null;
        // It changed: look again at once (a page loading or moving keeps the phone current).
        continue;
      }
      // Quiet: look again in a moment, or at once after the user's input.
      await new Promise<void>((resolve) => {
        a.poke = resolve;
        setTimeout(resolve, IDLE_MS);
      });
      a.poke = null;
    }
  }
}
