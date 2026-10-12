/**
 * Live Jev check (network). Runs only when NOA_LIVE_JEV_KEY is set:
 *   NOA_LIVE_JEV_KEY=<TYPESAFE_API_KEY> pnpm --filter @noa/core test live-jev
 */
import { describe, expect, it } from "vitest";
import { createJev, createToolExecutor } from "../src/index.js";
import { FakeX } from "./fake-x.js";

const key: string | undefined = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NOA_LIVE_JEV_KEY;

describe.runIf(!!key)("live Jev", () => {
  it("picks the composer and the Post button on the fake X page, and act posts", async () => {
    const jev = createJev(key!);
    const x = new FakeX({ url: "https://x.com/home" });
    const t0 = Date.now();
    const d = await jev.decide({ goal: "type the post text into the post composer", snapshot: x.snapshot() });
    const ms = Date.now() - t0;
    console.log("live jev decision", d, `${ms} ms`);
    expect(d.operation).toBe("type");
    expect(d.index).toBe(2);

    const jevEvents: unknown[] = [];
    const exec = createToolExecutor({
      browser: x.caller(),
      jev,
      jevThreshold: 0.5,
      onEvent: (e) => e.type === "jev" && jevEvents.push(e),
      mediaPaths: [],
    });
    const r = await exec.call("act", {
      steps: [{ goal: "type the post text into the post composer", text: "live jev check" }, { goal: "click the Post button" }],
    });
    console.log(r.text?.split("\n").slice(0, 4).join("\n"), jevEvents);
    expect(x.posts.map((p) => p.text)).toEqual(["live jev check"]);
  }, 60_000);
});
