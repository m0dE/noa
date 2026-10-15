import { describe, expect, it } from "vitest";
import { SETTLE_REQUESTS_MAX_MS } from "@noa/shared";
import { Cdp, type DebuggerTransport } from "../src/cdp.js";
import { CdpActions, settleAfterInput } from "../src/cdp-actions.js";
import { keyEvents } from "../src/keys.js";

const TAB = 7;

/**
 * A debugger whose page answers a key press with the requests in `requests` (type, and the ms after the key when
 * it finishes; null: never). Time passes only through the actions' sleep.
 */
function setup(requests: { type: string; doneAfter: number | null }[]) {
  let now = 0;
  const sent: string[] = [];
  const due: { at: number; method: string; id: string }[] = [];
  let cdp!: Cdp;
  const transport: DebuggerTransport = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_tabId, method, params) => {
      sent.push(method);
      if (method === "Input.dispatchKeyEvent" && (params as { type?: string }).type === "keyUp") {
        requests.forEach((r, i) => {
          cdp.handleEvent({ tabId: TAB }, "Network.requestWillBeSent", { requestId: `r${i}`, type: r.type });
          if (r.doneAfter !== null) due.push({ at: now + r.doneAfter, method: "Network.loadingFinished", id: `r${i}` });
        });
      }
      return {};
    },
  };
  cdp = new Cdp(transport);
  const sleep = async (ms: number) => {
    now += ms;
    for (const d of due.filter((x) => x.at <= now)) {
      due.splice(due.indexOf(d), 1);
      cdp.handleEvent({ tabId: TAB }, d.method, { requestId: d.id });
    }
  };
  const actions = new CdpActions(cdp, sleep);
  return { actions, sent, elapsed: () => now };
}

describe("an input with settleMs", () => {
  it("waits settleMs when the page sends nothing, and says it settled", async () => {
    const s = setup([]);
    const r = await s.actions.pressKey(TAB, keyEvents("Enter"), { settleMs: 500 });
    expect(r).toEqual({ ok: true, settled: true });
    expect(s.elapsed()).toBe(500);
    expect(s.sent).toContain("Network.enable");
    expect(s.sent.at(-1)).toBe("Network.disable");
  });

  it("waits on while a fetch the input started is loading, then lets the page draw it", async () => {
    const s = setup([{ type: "Fetch", doneAfter: 1450 }]);
    await s.actions.pressKey(TAB, keyEvents("Enter"), { settleMs: 300 });
    expect(s.elapsed()).toBeGreaterThanOrEqual(1450);
    expect(s.elapsed()).toBeLessThan(1450 + 300);
  });

  it("does not wait for images or scripts, only fetch and XHR", async () => {
    const s = setup([{ type: "Image", doneAfter: 3000 }]);
    await s.actions.pressKey(TAB, keyEvents("Enter"), { settleMs: 300 });
    expect(s.elapsed()).toBe(300);
  });

  it("stops waiting for a request that never ends", async () => {
    const s = setup([{ type: "XHR", doneAfter: null }]);
    await s.actions.pressKey(TAB, keyEvents("Enter"), { settleMs: 300 });
    expect(s.elapsed()).toBeGreaterThanOrEqual(SETTLE_REQUESTS_MAX_MS);
    expect(s.elapsed()).toBeLessThan(SETTLE_REQUESTS_MAX_MS + 300);
  });

  it("without settleMs: only the input, no wait and no Network domain", async () => {
    const s = setup([{ type: "Fetch", doneAfter: 1000 }]);
    const r = await s.actions.pressKey(TAB, keyEvents("Enter"));
    expect(r).toEqual({ ok: true });
    expect(s.elapsed()).toBe(0);
    expect(s.sent).not.toContain("Network.enable");
  });
});

describe("settleAfterInput: a request that starts late (a search field's debounce)", () => {
  /** A request that starts `startAt` ms after the input and takes `takes` ms. */
  function lateRequest(startAt: number, takes: number) {
    let now = 0;
    const watch = { open: () => (now >= startAt && now < startAt + takes ? 1 : 0), started: () => (now >= startAt ? 1 : 0) };
    const sleep = async (ms: number) => void (now += ms);
    return { watch, sleep, elapsed: () => now };
  }

  it("given a start window, waits for a request that starts after settleMs, then for it to load", async () => {
    const r = lateRequest(600, 900);
    await settleAfterInput(r.watch, r.sleep, 300, 1200);
    expect(r.elapsed()).toBeGreaterThanOrEqual(1500);
    expect(r.elapsed()).toBeLessThan(1500 + 300);
  });

  it("without one, it does not wait for it (an ordinary field costs settleMs only)", async () => {
    const r = lateRequest(600, 900);
    await settleAfterInput(r.watch, r.sleep, 300);
    expect(r.elapsed()).toBe(300);
  });

  it("a search field that sends nothing costs the start window, no more", async () => {
    const r = lateRequest(Infinity, 0);
    await settleAfterInput(r.watch, r.sleep, 300, 1200);
    expect(r.elapsed()).toBe(1200);
  });
});
