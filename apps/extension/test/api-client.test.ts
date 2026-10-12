import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { ApiRequestError } from "../src/http-client.js";
import { fakeFetch, jsonResponse as json } from "./fake-fetch.js";
import { claimFixture } from "./fixtures.js";

describe("ApiClient", () => {
  it("claims a task with auth header and runnerId body", async () => {
    const claim = claimFixture("t1");
    const f = fakeFetch(() => json(claim));
    const api = new ApiClient({ apiBase: "https://api.test", token: "session-token", fetch: f.fn });
    expect(await api.claim("runner-1")).toEqual(claim);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.test/v1/runner/claim");
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer session-token");
    expect(new Headers(call.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({ runnerId: "runner-1" });
  });

  it("returns null on 204", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const api = new ApiClient({ apiBase: "https://api.test", token: "k", fetch: f.fn });
    expect(await api.claim("r")).toBeNull();
  });

  it("rejects a malformed claim body", async () => {
    const f = fakeFetch(() => json({ nope: true }));
    const api = new ApiClient({ apiBase: "https://api.test", token: "k", fetch: f.fn });
    await expect(api.claim("r")).rejects.toThrow(/claim response/i);
  });

  it("posts heartbeat and result with the right shapes", async () => {
    const f = fakeFetch((url) => (url.endsWith("/heartbeat") ? json({ leaseExpiresAt: "2026-09-23T00:15:00.000Z" }) : json({ ok: true })));
    const api = new ApiClient({ apiBase: "https://api.test", token: "k", fetch: f.fn });
    expect(await api.heartbeat("t 1", "r")).toEqual({ leaseExpiresAt: "2026-09-23T00:15:00.000Z" });
    await api.result("t1", { runnerId: "r", outcome: "done", summary: "posted", url: "https://x.com/a/status/1", screenshotId: "m1", retryAfterMinutes: 15 });
    expect(f.calls[0]!.url).toBe("https://api.test/v1/runner/tasks/t%201/heartbeat");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ runnerId: "r" });
    expect(f.calls[1]!.url).toBe("https://api.test/v1/runner/tasks/t1/result");
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({
      runnerId: "r",
      outcome: "done",
      summary: "posted",
      url: "https://x.com/a/status/1",
      screenshotId: "m1",
      retryAfterMinutes: 15,
    });
  });

  it("maps error bodies to ApiRequestError with status", async () => {
    const f = fakeFetch(() => json({ error: "lease not owned" }, 409));
    const api = new ApiClient({ apiBase: "https://api.test", token: "k", fetch: f.fn });
    const err = await api.result("t1", { runnerId: "r", outcome: "failed", reason: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(409);
    expect((err as Error).message).toBe("API 409: lease not owned");
  });

  it("maps non-JSON errors and network failures", async () => {
    const api1 = new ApiClient({ apiBase: "https://api.test", token: "k", fetch: fakeFetch(() => new Response("Bad Gateway", { status: 502 })).fn });
    await expect(api1.claim("r")).rejects.toThrow("API 502: Bad Gateway");
    const api2 = new ApiClient({
      apiBase: "https://api.test",
      token: "k",
      fetch: fakeFetch(() => {
        throw new TypeError("Failed to fetch");
      }).fn,
    });
    await expect(api2.claim("r")).rejects.toThrow("Cannot reach API at https://api.test: Failed to fetch");
  });

  it("uploads media as multipart field 'file'", async () => {
    const info = { id: "m1", filename: "result.jpg", contentType: "image/jpeg", size: 3 };
    const f = fakeFetch(() => json(info, 201));
    const api = new ApiClient({ apiBase: "https://api.test", token: "k", fetch: f.fn });
    const got = await api.uploadMedia(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "result.jpg");
    expect(got).toEqual(info);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.test/v1/media");
    expect(call.init.method).toBe("POST");
    const body = call.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get("file") as File;
    expect(file.name).toBe("result.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(3);
    // fetch must set the multipart boundary itself.
    expect(new Headers(call.init.headers).get("content-type")).toBeNull();
  });
});
