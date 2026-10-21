import type { DesktopMessage } from "@noa/shared/phone-link/protocol";
import { describe, expect, it } from "vitest";
import { RemoteScreen } from "../../src/phone-link/screen.js";

const flush = async (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup(opts: { running?: boolean; activeTab?: boolean } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const posted: DesktopMessage[] = [];
  let running = opts.running ?? false;
  let shot = 0;
  let painted = 0;
  const screen = new RemoteScreen({
    send: async (_tabId, method, params) => {
      calls.push({ method, params });
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 390, clientHeight: 800, pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: `frame${++shot}` };
      if (method === "Runtime.evaluate") return { result: { value: { editable: true, password: true } } };
      return {};
    },
    tabOf: async () => 5,
    makePaintable: async () => void painted++,
    tabInfo: async () => ({ url: "https://www.facebook.com/login", title: "Log in" }),
    running: () => running,
    post: (m) => posted.push(m),
    log: () => {},
  });
  return { screen, calls, posted, setRunning: (v: boolean) => (running = v), painted: () => painted };
}

describe("RemoteScreen", () => {
  it("taking over a paused job: laid out at the phone's size, frames one at a time, taps and typing reach the page", async () => {
    const t = setup();
    await t.screen.start("s1", 390, 800, true);
    expect(t.painted()).toBe(1);
    expect(t.calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride")?.params).toEqual({ width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    expect(t.posted[0]).toEqual({ type: "screen.started", sessionId: "s1", interactive: true, url: "https://www.facebook.com/login", title: "Log in" });
    await flush();
    const frames = () => t.posted.filter((m) => m.type === "screen.frame");
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({ frameId: 1, jpeg: "frame1", width: 390, height: 800, url: "https://www.facebook.com/login" });
    // No ack yet: no second frame.
    await flush(100);
    expect(frames()).toHaveLength(1);
    t.screen.ack(1);
    await flush(50);
    expect(frames()).toHaveLength(2);

    await t.screen.tap(120, 300);
    const mouse = t.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params?.type);
    expect(mouse).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(t.posted.at(-1)).toEqual({ type: "screen.focus", editable: true, password: true });
    await t.screen.text("hunter2");
    expect(t.calls.at(-1)).toEqual({ method: "Input.insertText", params: { text: "hunter2" } });
    await t.screen.key("Enter");
    expect(t.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params?.type)).toEqual(["keyDown", "keyUp"]);

    await t.screen.stop();
    expect(t.calls.at(-1)?.method).toBe("Emulation.clearDeviceMetricsOverride");
    expect(t.posted.at(-1)).toEqual({ type: "screen.stopped", reason: "stopped" });
  });

  it("while the agent works the screen is view-only: no layout change, no input; a turn starting ends a take-over", async () => {
    const t = setup({ running: true });
    await t.screen.start("s1", 390, 800, true);
    expect(t.posted[0]).toMatchObject({ type: "screen.started", interactive: false });
    expect(t.calls.some((c) => c.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
    await t.screen.tap(1, 1);
    await t.screen.text("x");
    expect(t.calls.some((c) => c.method.startsWith("Input."))).toBe(false);
    await t.screen.stop();

    const u = setup();
    await u.screen.start("s1", 390, 800, true);
    u.setRunning(true);
    await u.screen.text("late");
    expect(u.calls.some((c) => c.method === "Input.insertText")).toBe(false);
    await flush();
    expect(u.calls.some((c) => c.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    expect(u.posted.some((m) => m.type === "screen.started" && !m.interactive)).toBe(true);
    await u.screen.stop();
  });
});
