import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@noa/shared";
import { ANTHROPIC_MODELS_URL, testClaude, testJev, type TestJevDeps } from "../src/engine/settings-tests.js";

const withKey = { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-ant", anthropicModel: "claude-sonnet-5" };

describe("testClaude", () => {
  it("GETs /v1/models with the browser-access headers", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-5" }] }));
    const r = await testClaude(withKey, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: { "x-api-key": "sk-ant", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    });
    expect(r).toEqual({ ok: true, detail: "Key accepted (2 models); model claude-sonnet-5 is available" });
  });

  it("reports rejected keys, HTTP errors, network errors and a missing key", async () => {
    const f = (res: Response | Error) =>
      (async () => {
        if (res instanceof Error) throw res;
        return res;
      }) as unknown as typeof fetch;
    expect(await testClaude(withKey, f(Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 })))).toEqual({
      ok: false,
      detail: "Claude API key rejected (HTTP 401)",
    });
    expect((await testClaude(withKey, f(Response.json({ error: { message: "overloaded" } }, { status: 529 })))).detail).toMatch(/HTTP 529: overloaded/);
    expect((await testClaude(withKey, f(new Error("offline")))).detail).toMatch(/Cannot reach api.anthropic.com: offline/);
    expect(await testClaude(DEFAULT_SETTINGS)).toEqual({ ok: false, detail: "No Claude API key set" });
  });
});

describe("testJev", () => {
  const onApi = { jevSource: "key" } as const;
  const HOSTED = { token: "bt_s_tok", apiBase: "https://api.test/" };
  const deps = (createJev: TestJevDeps["core"]["createJev"], hosted: TestJevDeps["hosted"] = null): TestJevDeps => ({ core: { createJev }, hosted });

  it("asks Jev for one decision on a two-element page", async () => {
    const decide = vi.fn(async () => ({ operation: "click" as const, index: 1, confidence: 0.93 }));
    const createJev = vi.fn(() => ({ decide }));
    const r = await testJev({ ...DEFAULT_SETTINGS, jevApiKey: "jk" }, onApi, deps(createJev));
    expect(createJev).toHaveBeenCalledWith("jk", undefined);
    expect((decide.mock.calls[0] as unknown as [{ snapshot: { elements: unknown[] } }])[0].snapshot.elements).toHaveLength(2);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/click element 1 \(confidence 0.93\)$/);
  });

  it("fails without a key or when Jev throws", async () => {
    expect((await testJev(DEFAULT_SETTINGS, {}, deps(vi.fn()))).detail).toMatch(/^No Jev: set a Jev key, or log in/);
    const createJev = () => ({ decide: async () => Promise.reject(new Error("401 bad key")) });
    expect(await testJev({ ...DEFAULT_SETTINGS, jevApiKey: "jk" }, onApi, deps(createJev))).toEqual({ ok: false, detail: "Jev test failed: 401 bad key" });
  });

  // Bug: "if it's using Noa AI, then it shouldn't be asking for JEV api key".
  it("does not ask for a Jev key when the brain is Noa AI (the server provides Jev)", async () => {
    const r = await testJev({ ...DEFAULT_SETTINGS, brain: "noa", jevApiKey: "" }, { jevSource: "cloud" }, deps(vi.fn()));
    expect(r.detail).not.toMatch(/Jev key/i);
  });

  it("with the cloud as the source (Noa AI, even with a key set here) tests the account's Jev (the server's /v1/ai/jev)", async () => {
    const decide = vi.fn(async () => ({ operation: "click" as const, index: 1, confidence: 0.9 }));
    const createJev = vi.fn(() => ({ decide }));
    const r = await testJev({ ...DEFAULT_SETTINGS, jevApiKey: "jk" }, { jevSource: "cloud" }, deps(createJev, HOSTED));
    expect(createJev).toHaveBeenCalledWith("bt_s_tok", { endpoint: "https://api.test/v1/ai/jev" });
    expect(r).toMatchObject({ ok: true, detail: expect.stringMatching(/^Noa's cloud Jev answered in \d+ ms: click element 1/) });
    expect((await testJev(DEFAULT_SETTINGS, { jevSource: "cloud" }, deps(vi.fn()))).detail).toMatch(/Sign in/);
  });

  it("on local Claude Code with the helper's own key and none here: says the helper's key is used", async () => {
    const r = await testJev(DEFAULT_SETTINGS, { jevSource: "helper" }, deps(vi.fn()));
    expect(r.detail).toMatch(/helper's own/);
  });
});
