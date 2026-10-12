/** A scripted fake of the Noa API over fetch, for account tests. */
import { fakeFetch, jsonResponse } from "../fake-fetch.js";

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; body?: unknown } | undefined;

export function fakeApi(base = "https://api.test") {
  const calls: Call[] = [];
  const routes = new Map<string, Handler>();
  const on = (key: string, h: Handler | { status?: number; body?: unknown }) => {
    routes.set(key, typeof h === "function" ? h : () => h);
  };
  const { fn: fetchFn } = fakeFetch(async (input, init) => {
    const url = new URL(input);
    if (url.origin !== base) throw new TypeError(`fetch to unexpected origin ${url.origin}`);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (init.body instanceof FormData) {
      const f = init.body.get("file") as File | null;
      body = { file: f ? { name: f.name, size: f.size, type: f.type } : null };
    } else if (init.body instanceof Blob) {
      body = { blob: { size: init.body.size, type: init.body.type, bytes: new Uint8Array(await init.body.arrayBuffer()) } };
    } else if (typeof init.body === "string") body = JSON.parse(init.body);
    const call: Call = { method: init.method ?? "GET", path: url.pathname + url.search, headers, body };
    calls.push(call);
    const h = routes.get(`${call.method} ${url.pathname}`) ?? routes.get(`${call.method} ${call.path}`);
    const r = h?.(call) ?? { status: 404, body: { error: "not found" } };
    const status = r.status ?? 200;
    return status === 204 ? new Response(null, { status }) : jsonResponse(r.body ?? {}, status);
  });
  return { fetch: fetchFn, calls, on, base };
}


/** A base64url JWT with these claims (unsigned: the extension only reads it). */
export function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "RS256", kid: "k" })}.${enc(claims)}.c2ln`;
}


export const USER = { id: "u1", email: "ada@example.com", name: "Ada", pictureUrl: "https://lh3.googleusercontent.com/a/ada" };
export const FREE_PLAN = { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } as const;
export const PLUS_PLAN = { id: "plus", status: "active", currentPeriodEnd: "2026-10-24T00:00:00.000Z", cancelAtPeriodEnd: false } as const;
export const credit = (sub: number, top: number) => ({
  subscriptionCents: sub,
  topupCents: top,
  totalCents: sub + top,
  periodGrantCents: sub ? 2000 : 0,
  periodEnd: sub ? "2026-10-24T00:00:00.000Z" : null,
});
