import { describe, expect, it } from "vitest";
import { APPROVAL_TIMEOUT_MS, WAIT_CALL_LIMIT_MS, WAIT_SLICE_MS } from "@noa/shared";
import { BROWSER_RPC_TIMEOUT_MS, rpcBrowser, type RpcBrowser } from "../src/tool-router.js";
import { TOOL_CALL_TIMEOUT_MS } from "../src/mcp-tools.js";

describe("browser calls to the extension", () => {
  it("an action that may wait for the user's approval gets that much longer; reads do not", async () => {
    const seen: [string, number | undefined][] = [];
    const peer: RpcBrowser = { call: async (method, _params, opts) => (seen.push([method, opts?.timeoutMs]), {} as never) };
    const b = rpcBrowser(peer);
    await b.call("browser.readPage", {});
    await b.call("browser.click", { index: 1 });
    await b.call("browser.navigate", { url: "https://x.com" });
    await b.call("browser.scroll", { direction: "down" });
    expect(seen).toEqual([
      ["browser.readPage", BROWSER_RPC_TIMEOUT_MS],
      ["browser.click", BROWSER_RPC_TIMEOUT_MS + APPROVAL_TIMEOUT_MS],
      ["browser.navigate", BROWSER_RPC_TIMEOUT_MS + APPROVAL_TIMEOUT_MS],
      ["browser.scroll", BROWSER_RPC_TIMEOUT_MS],
    ]);
  });

  it("a tool call's own limit allows one full approval wait on top of its browser calls", () => {
    expect(TOOL_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(BROWSER_RPC_TIMEOUT_MS + APPROVAL_TIMEOUT_MS);
  });

  it("wait_for fits: one slice inside a browser call's timeout, one call's whole wait inside the tool call's limit", () => {
    expect(WAIT_SLICE_MS + 5000).toBeLessThan(BROWSER_RPC_TIMEOUT_MS);
    expect(WAIT_CALL_LIMIT_MS + BROWSER_RPC_TIMEOUT_MS).toBeLessThanOrEqual(TOOL_CALL_TIMEOUT_MS);
  });
});
