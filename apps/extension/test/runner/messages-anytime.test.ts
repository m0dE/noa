/**
 * A message for a running conversation is never refused for its timing (hands-free voice sends each utterance
 * the moment it is said): before the brain's run has started it is handed to the run when it does; after the
 * run ended while the session is still closing it opens the next turn; while the next turn is starting it goes
 * into that turn.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentSlot } from "../../src/agent-slots.js";
import { Runner } from "../../src/engine/runner.js";
import { AGENT_TAB, harness, setupRunnerTests, withoutClock, type Harness } from "./harness.js";

setupRunnerTests();

/** A gate a test opens when it wants: wait() resolves once open() was called. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { wait: () => opened, open };
}

/** The harness with its one slot's tab preparation held until `held` opens (the brain starts after it). */
function heldAtPrepare(h: Harness, held: Promise<void>): void {
  const slot: AgentSlot = {
    index: 0,
    prepare: async (opts) => {
      h.prepared.push(opts);
      await held;
      return opts.tabId ?? AGENT_TAB;
    },
    browser: h.browser,
    isAgentTab: async (tabId) => tabId === AGENT_TAB,
    screenshot: async () => ({ base64: btoa("JPG"), mimeType: "image/jpeg" }),
    onWait: () => () => {},
  };
  h.deps.slots = { size: 1, take: () => slot, release: () => {}, endChat: async () => {} };
  h.runner = new Runner(h.deps);
}

const userTexts = async (h: Harness, sessionId: string) =>
  (await h.sessions.eventsOf(sessionId)).filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text);

describe("Runner: messages at any moment of a turn", () => {
  it("a message sent before the brain's run started is handed to the run as it starts, and shown once", async () => {
    const h = harness();
    const prepare = gate();
    heldAtPrepare(h, prepare.wait());
    h.brain.script = (_o, ctl) => {
      void vi.waitFor(() => expect(ctl.said).toEqual(["and make it short"])).then(() => ctl.resolve({ outcome: "done", summary: "ok" }));
      return "hang";
    };
    const { sessionId } = await h.runner.message(undefined, "Write a note", { voice: true });
    expect(h.brain.starts).toHaveLength(0);
    expect(await h.runner.message(sessionId, "and make it short", { voice: true })).toEqual({ sessionId, mode: "inject" });
    prepare.open();
    await h.runner.idle();
    await h.sessions.flush();
    expect(h.brain.ctls[0]!.said).toEqual(["and make it short"]);
    expect(await userTexts(h, sessionId)).toEqual(["and make it short"]);
    expect((await h.sessions.get(sessionId))!.outcome).toBe("done");
  });

  it("a message sent after the run ended, while the session is still closing, opens the next turn once it has ended", async () => {
    const h = harness();
    const verifying = gate();
    let verifyStarted!: () => void;
    const inVerify = new Promise<void>((r) => (verifyStarted = r));
    h.verify.mockImplementation(async () => {
      verifyStarted();
      await verifying.wait();
      return { ok: true, detail: "found" };
    });
    h.brain.script = () => ({ outcome: "done", summary: "posted", url: "https://x.com/me/status/1" });
    const { sessionId } = await h.runner.message(undefined, "Post hello on X");
    await inVerify;
    expect(await h.runner.message(sessionId, "now like it", { voice: true })).toEqual({ sessionId, mode: "turn" });
    verifying.open();
    await vi.waitFor(() => expect(h.brain.continues).toHaveLength(1));
    await h.runner.idle();
    await h.sessions.flush();
    expect(withoutClock(h.brain.continues[0]!.text)).toContain("now like it");
    expect(await userTexts(h, sessionId)).toEqual(["now like it"]);
    expect((await h.sessions.get(sessionId))!.turns).toBe(2);
  });

  it("a message sent while the next turn is starting goes into that turn", async () => {
    const h = harness();
    h.brain.script = () => ({ outcome: "done", summary: "first" });
    const { sessionId } = await h.runner.message(undefined, "Read the page");
    await h.runner.idle();
    h.brain.continueScript = (_o, ctl) => {
      void vi.waitFor(() => expect(ctl.said).toEqual(["and the second one"])).then(() => ctl.resolve({ outcome: "done", summary: "both" }));
      return "hang";
    };
    const [first, second] = await Promise.all([h.runner.message(sessionId, "open the first link"), h.runner.message(sessionId, "and the second one")]);
    expect(first.mode).toBe("turn");
    expect(second.mode).toBe("inject");
    await h.runner.idle();
    await h.sessions.flush();
    expect(h.brain.continues).toHaveLength(1);
    expect(h.brain.ctls.at(-1)!.said).toEqual(["and the second one"]);
    expect(await userTexts(h, sessionId)).toEqual(["open the first link", "and the second one"]);
  });
});
