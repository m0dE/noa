import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, HttpClient, NotSignedInError } from "../src/http-client.js";

const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

describe("HttpClient", () => {
  it("takes the server's words: message before error, never a bare code; keeps the body", async () => {
    const body = { error: "plan_required", feature: "apiKeys", message: "API keys need a paid plan.", upgradeUrl: "https://dash.test/billing" };
    const http = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", fetch: answer(403, JSON.stringify(body)) });
    const err = (await http.request("POST", "/v1/me/keys", {}).catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 403, message: "API keys need a paid plan.", body });
    const bare = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", fetch: answer(402, JSON.stringify({ error: "out_of_credit" })) });
    await expect(bare.request("GET", "/x")).rejects.toThrow("HTTP 402");
  });

  it("never shows a web page (e.g. Cloudflare's error page) as the message", async () => {
    const page = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie"> <![endif]--> error 1042';
    const http = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", fetch: answer(404, page) });
    const err = await http.request("GET", "/v1/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as Error).message).toBe("The server answered with a web page instead of the API (HTTP 404). Check the server address in Settings.");
  });
  it("raw error text, a label, 401 and a missing token or base", async () => {
    const onUnauthorized = vi.fn();
    const http = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", label: "API", onUnauthorized, fetch: answer(401, "nope") });
    await expect(http.request("GET", "/x")).rejects.toThrow("API 401: nope");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(http.request("GET", "/x", undefined, { auth: false })).rejects.toThrow("API 401: nope");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(new HttpClient({ apiBase: "https://api.test", missingBase: "no base" }).request("GET", "/x")).rejects.toBeInstanceOf(NotSignedInError);
    await expect(new HttpClient({ apiBase: "", missingBase: "no base" }).request("GET", "/x")).rejects.toThrow("no base");
  });
});
