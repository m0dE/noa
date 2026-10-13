// A scripted brain in the extension's service worker, in place of Claude (no helper, no API key).
import { waitFor } from "./suite.mjs";

/**
 * Installs the fake brain. Each turn is named: the task's instructions, or the first line of the
 * user's words in the next message (which may start with what the chat's tab shows:
 * buildFollowUpMessage). A turn runs `act(opts, name, kind)` in the service worker (kind: "start" | "continue";
 * opts: what the runner gives a brain) and ends "done" with what act returns as the summary (or,
 * returning { summary, suggestion }, with the agent's follow-up suggestion too), or "failed" with
 * the error act throws.
 *
 * `act` is made in the service worker by `makeAct(arg)` (it runs there, so it cannot close over
 * this script's variables: pass them as `arg`). With `gated`, a turn says "working on <name>" and
 * waits for release(name) before it acts.
 *
 * Returns { started(name), release(name) }.
 */
export async function installFakeBrain(sw, { makeAct, arg, gated = false }) {
  const act = await sw.evaluateHandle(makeAct, arg);
  await sw.evaluate(
    ({ act, gated }) => {
      const fake = (globalThis.__fake = { gates: {} });
      const turn = (opts, name, kind) => {
        let resolve;
        const done = new Promise((r) => (resolve = r));
        (async () => {
          if (gated) {
            opts.onEvent({ type: "assistant_text", text: `working on ${name}` });
            await new Promise((r) => (fake.gates[name] = r));
            delete fake.gates[name];
          }
          const r = await act(opts, name, kind);
          resolve({ outcome: "done", ...(r && typeof r === "object" ? r : { summary: r }) });
        })().catch((e) => resolve({ outcome: "failed", reason: String(e?.message ?? e) }));
        return { done, sendUserMessage: async () => true, abort: (reason, outcome) => resolve({ outcome, reason }) };
      };
      const brain = {
        kind: "claude-api",
        start: (opts) => turn(opts, opts.task.instructions, "start"),
        continue: (opts) => turn(opts, opts.text.split("The user's message:\n").at(-1).split("\n")[0], "continue"),
        isOpen: () => true,
      };
      globalThis.__noa.setBrainOverride(async () => ({
        brain,
        status: { effective: "claude-api", helper: null, hasApiKey: true, jevActive: false },
      }));
    },
    { act, gated },
  );
  await act.dispose();

  const waiting = (name) => sw.evaluate((n) => !!globalThis.__fake.gates[n], name);
  /** Waits until a turn named `name` is waiting at its gate. */
  const started = (name) => waitFor(() => waiting(name), `a turn of "${name}" to start`);
  /** Lets the turn named `name` act (waits for it to reach its gate first). */
  const release = async (name) => {
    await started(name);
    await sw.evaluate((n) => globalThis.__fake.gates[n](), name);
  };
  return { started, release };
}
