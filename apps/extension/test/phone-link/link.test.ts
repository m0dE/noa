import type { SessionInfo, StampedAgentEvent } from "@noa/shared";
import {
  decodeIdentity,
  decodeWelcome,
  encodeHello,
  encodeIdentity,
  finishHandshake,
  fingerprint,
  fromB64,
  generateStaticKeys,
  MemoryKeyVault,
  pairingProof,
  publicIdentity,
  startHandshake,
  toB64,
  type DesktopMessage,
  type HubFrame,
  type PhoneMessage,
  type Session,
} from "@noa/shared/phone-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneLink, type LinkState, type PanelPort, type PhoneLinkDeps } from "../../src/phone-link/link.js";
import { UiAssembler, uiParts, type UiPart } from "@noa/shared/phone-link/protocol";
import { fakeFetch, jsonResponse } from "../fake-fetch.js";

const API = "https://app.test";

class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  hub(frame: HubFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: `Job ${id}`, brain: "noa", jev: false, startedAt: "2026-10-16T10:00:00.000Z", ...extra } as SessionInfo;
}

function setup() {
  let state: LinkState | undefined;
  const sockets: FakeSocket[] = [];
  const handled: Record<string, unknown>[] = [];
  const events = new Map<string, StampedAgentEvent[]>();
  const sessions = new Map<string, SessionInfo>();
  const screenCalls: string[] = [];
  const panels: PanelPort[] = [];
  const { fn, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/v1/devices/desktop")) return jsonResponse({ deviceId: "desk1", token: `nd_${"a".repeat(48)}` }, 201);
    if (url.endsWith("/v1/devices/pairings")) return jsonResponse({ pairingId: "pair1", pairToken: `np_${"b".repeat(48)}`, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return jsonResponse({ error: "nope" }, 404);
  });
  const deps: PhoneLinkDeps = {
    session: async () => ({ token: "bt_s_x", apiBase: API }),
    loadState: async () => state,
    saveState: async (s) => void (state = s),
    vault: new MemoryKeyVault(),
    fetch: fn,
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    handle: async (msg) => {
      handled.push(msg);
      if (msg.type === "run.message") {
        const id = (msg.sessionId as string | undefined) ?? "s1";
        // As the runner does: the first message is the session's instructions, not an event.
        if (!sessions.has(id)) sessions.set(id, session(id, { instructions: String(msg.text) }));
        events.set(id, []);
        return { sessionId: id, mode: "new" };
      }
      if (msg.type === "approval.answer") return { ok: true };
      if (msg.type === "run.adhoc") return { sessionId: "s9" };
      if (msg.type === "sessions.list") return { sessions: [session("s1", { title: "Long ".repeat(200_000) })] };
      if (msg.type === "state.get") throw new Error("The background is busy");
      return { ok: true };
    },
    attachPanel: (port) => void panels.push(port),
    info: async () => ({ version: "9.9.9", id: "extid", userAgent: "Mozilla/5.0 (Windows NT 10.0)", bookmarks: false, helperCode: "0123456789ab", shortcuts: {} }),
    stored: async (key) => ({ bookmarkSync: { lastSyncAt: "t" }, phoneLink: { token: "secret" } })[key],
    openTab: async () => 77,
    screen: {
      send: async (_tab, method) => {
        screenCalls.push(method);
        return method === "Page.captureScreenshot" ? { data: "/9j/frame" } : {};
      },
      tabOf: async () => 77,
      makePaintable: async () => {},
      tabInfo: async () => ({ url: "https://www.facebook.com/login", title: "Log in" }),
    },
    sessions: {
      list: async () => [...sessions.values()],
      get: async (id) => sessions.get(id) ?? null,
      eventsOf: async (id) => events.get(id) ?? [],
    },
    running: () => ["s1"],
    awaiting: () => [],
    desktopName: async () => "Noa on Linux",
    onChange: () => {},
    log: () => {},
  };
  return { deps, link: new PhoneLink(deps), sockets, handled, calls, screenCalls, panels, getState: () => state };
}

/** A phone that read the QR code: pairs, then handshakes and talks through the fake hub. */
async function phoneFor(env: ReturnType<typeof setup>, url: string) {
  const [, fragment] = url.split("#");
  const [, , secret, fp] = fragment!.split(".");
  const keys = generateStaticKeys();
  const identity = encodeIdentity(publicIdentity(keys));
  const proof = toB64(pairingProof(fromB64(secret!), publicIdentity(keys), fromB64(fp!)));
  return { keys, identity, proof };
}

afterEach(() => vi.useRealTimers());

describe("PhoneLink (desktop end)", () => {
  it("pairs: registers, shows a code whose fingerprint is this desktop's, accepts the phone that proves it read it", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    expect(url).toMatch(new RegExp(`^${API}/phone#pair1\\.np_b{48}\\.`));
    expect(env.sockets).toHaveLength(1);
    expect(env.sockets[0]!.protocols).toEqual(["noa-link", `nd.nd_${"a".repeat(48)}`]);
    env.sockets[0]!.open();

    const phone = await phoneFor(env, url);
    env.sockets[0]!.hub({ t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } });
    await flush();
    expect(env.getState()?.phones).toEqual([{ id: "ph1", name: "iPhone", identity: phone.identity }]);
    expect(env.getState()?.pending).toBeUndefined();
    expect((await env.link.view()).phones).toEqual([{ id: "ph1", name: "iPhone", online: false }]);
  });

  it("refuses and unlinks a phone whose proof is wrong (not the one that read the code)", async () => {
    const env = setup();
    await env.link.pair();
    env.sockets[0]!.open();
    const other = generateStaticKeys();
    env.sockets[0]!.hub({
      t: "paired",
      phone: { id: "evil", name: "x", identity: encodeIdentity(publicIdentity(other)), proof: toB64(new Uint8Array(48)) },
    });
    await flush();
    expect(env.getState()?.phones).toEqual([]);
    expect(env.calls.some((c) => c.url.endsWith("/v1/devices/evil") && c.init.method === "DELETE")).toBe(true);
  });

  it("starts a job in a new background tab with the phone's photo, and the phone gets the conversation", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    const ws = env.sockets[0]!;
    ws.open();
    const phone = await phoneFor(env, url);
    ws.hub({ t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } });
    await flush();

    // The desktop's public keys, as the server hands them to the phone (it checks them against the QR code).
    const [, fragment] = url.split("#");
    const desktopIdentity = decodeIdentity(JSON.parse(JSON.stringify((await env.deps.vault.load()) && encodeIdentity(publicIdentity((await env.deps.vault.load())!)))));
    expect(toB64(fingerprint(desktopIdentity))).toBe(fragment!.split(".")[3]);

    const pending = startHandshake(desktopIdentity);
    ws.hub({ t: "recv", from: "ph1", kind: "hello", body: JSON.stringify(encodeHello(pending.hello)) });
    await flush();
    const welcome = ws.sent.find((f) => f.kind === "welcome")!;
    const s: Session = await finishHandshake(phone.keys, desktopIdentity, pending, decodeWelcome(JSON.parse(String(welcome.body))));

    const received: DesktopMessage[] = [];
    let seen = 0;
    const read = async () => {
      for (const f of ws.sent.slice(seen)) {
        seen++;
        if (f.kind === "sealed" && f.to === "ph1") received.push(JSON.parse(await s.open(fromB64(String(f.body)))));
      }
    };
    const say = async (m: PhoneMessage) => ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: toB64(await s.seal(JSON.stringify(m))) });

    await say({ type: "sync" });
    await flush();
    await read();
    expect(received[0]).toMatchObject({ type: "state", desktopName: "Noa on Linux" });

    // In two parts, as the phone sends a file larger than one message.
    await say({ type: "attachment", id: "p1", name: "printer.jpg", mime: "image/jpeg", part: 1, parts: 2, data: btoa("def") });
    await say({ type: "attachment", id: "p1", name: "printer.jpg", mime: "image/jpeg", part: 0, parts: 2, data: btoa("abc"), width: 10, height: 8 });
    await say({ type: "job.start", requestId: "r1", text: "Sell this printer", attachmentIds: ["p1"] });
    await flush();
    await read();
    expect(env.handled.at(-1)).toEqual({
      type: "run.message",
      text: "Sell this printer",
      tabId: 77,
      attachments: [{ name: "printer.jpg", type: "image/jpeg", dataBase64: btoa("abcdef"), width: 10, height: 8 }],
    });
    expect(received).toContainEqual({ type: "started", requestId: "r1", sessionId: "s1" });
    expect(received.find((m) => m.type === "history")).toMatchObject({ sessionId: "s1", events: [{ k: "user", text: "Sell this printer" }] });
    expect(env.link.isWatching("s1")).toBe(true);

    // A live event of the watched conversation reaches the phone as a plain step; a typed password never does.
    env.link.onEvent({ type: "tool_call", id: "c1", name: "type", args: { index: 3, text: "hunter2" }, ts: "t2", sessionId: "s1" } as StampedAgentEvent);
    env.link.onEvent({ type: "tool_call", id: "c2", name: "navigate", args: { url: "https://www.facebook.com/marketplace/create" }, ts: "t3", sessionId: "s1" } as StampedAgentEvent);
    await flush();
    await read();
    const lines = received.filter((m) => m.type === "event").map((m) => (m as { event: { text?: string } }).event.text);
    expect(lines).toEqual(["Typed into a field", expect.stringMatching(/^Opened facebook\.com/)]);
    expect(JSON.stringify(received)).not.toContain("hunter2");

    await say({ type: "approval.answer", sessionId: "s1", id: "a1", answer: "allow_once" });
    await flush();
    expect(env.handled.at(-1)).toEqual({ type: "approval.answer", sessionId: "s1", id: "a1", answer: "allow_once", by: "card" });

    // A photo id it never sent: the request fails, and the phone hears why.
    await say({ type: "job.start", requestId: "r2", text: "again", attachmentIds: ["nope"] });
    await flush();
    await read();
    expect(received.at(-1)).toEqual({ type: "error", requestId: "r2", message: "A file did not arrive whole; send it again" });
  });

  it("serves the phone's side panel: requests as a panel's (a new job in its own window), pushes on its port, large answers in parts", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    const ws = env.sockets[0]!;
    ws.open();
    const phone = await phoneFor(env, url);
    ws.hub({ t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } });
    await flush();
    const desktopIdentity = decodeIdentity(encodeIdentity(publicIdentity((await env.deps.vault.load())!)));
    const pending = startHandshake(desktopIdentity);
    ws.hub({ t: "recv", from: "ph1", kind: "hello", body: JSON.stringify(encodeHello(pending.hello)) });
    await flush();
    const welcome = ws.sent.find((f) => f.kind === "welcome")!;
    const s = await finishHandshake(phone.keys, desktopIdentity, pending, decodeWelcome(JSON.parse(String(welcome.body))));
    let seen = 0;
    const parts = new UiAssembler();
    const got: { ch: string; id: string; msg: unknown }[] = [];
    const read = async () => {
      for (const f of ws.sent.slice(seen)) {
        seen++;
        if (f.kind !== "sealed") continue;
        expect(String(f.body).length).toBeLessThan(900_000);
        const m = JSON.parse(await s.open(fromB64(String(f.body)))) as UiPart;
        const json = parts.add(m);
        if (json !== null) got.push({ ch: m.ch, id: m.id, msg: JSON.parse(json) });
      }
    };
    const say = async (ch: UiPart["ch"], id: string, msg: unknown) => {
      for (const p of uiParts(ch, id, JSON.stringify(msg))) ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: toB64(await s.seal(JSON.stringify(p))) });
    };

    // The panel's port: the background's pushes reach the phone through it.
    await say("open", "port1", "noa-ui");
    await flush();
    expect(env.panels).toHaveLength(1);
    expect(env.panels[0]!.name).toBe("noa-ui");
    env.panels[0]!.postMessage({ type: "tasks.changed" });
    await flush();
    await read();
    expect(got).toContainEqual({ ch: "push", id: "port1", msg: { type: "tasks.changed" } });

    // A new job: its own minimized window's tab, and remembered for its notifications.
    await say("req", "r1", { type: "run.adhoc", instructions: "Sell my printer — for 40 €" });
    await flush();
    await read();
    expect(env.handled.at(-1)).toEqual({ type: "run.adhoc", instructions: "Sell my printer — for 40 €", tabId: 77 });
    expect(got).toContainEqual({ ch: "res", id: "r1", msg: { ok: true, data: { sessionId: "s9" } } });
    expect(env.getState()?.jobs).toContain("s9");

    // An answer over one frame comes in parts; a failure comes back as the router's would.
    await say("req", "r2", { type: "sessions.list" });
    await say("req", "r3", { type: "state.get" });
    await flush();
    await read();
    const list = got.find((g) => g.id === "r2")!.msg as { data: { sessions: SessionInfo[] } };
    expect(list.data.sessions[0]!.title).toHaveLength(1_000_000);
    expect(got).toContainEqual({ ch: "res", id: "r3", msg: { ok: false, error: "The background is busy" } });

    // Signing in opens Google's window on the computer: not from the phone. Saved logins and the rest are the panel's.
    const before = env.handled.length;
    await say("req", "r4", { type: "account.signIn" });
    await say("req", "r5", { type: "vault.list" });
    await flush();
    await read();
    expect(env.handled.slice(before)).toEqual([{ type: "vault.list" }]);
    expect(got.find((g) => g.id === "r4")!.msg).toEqual({ ok: false, error: "Do this in Noa on your computer." });

    // The Settings page: the computer's extension, one storage key it may read (never the link's token).
    await say("req", "r8", { type: "phone.info" });
    await say("req", "r9", { type: "phone.storage", key: "bookmarkSync" });
    await say("req", "r10", { type: "phone.storage", key: "phoneLink" });
    await flush();
    await read();
    expect(got.find((g) => g.id === "r8")!.msg).toEqual({ ok: true, data: { version: "9.9.9", id: "extid", userAgent: "Mozilla/5.0 (Windows NT 10.0)", bookmarks: false, helperCode: "0123456789ab", shortcuts: {} } });
    expect(got.find((g) => g.id === "r9")!.msg).toEqual({ ok: true, data: { lastSyncAt: "t" } });
    expect(got.find((g) => g.id === "r10")!.msg).toEqual({ ok: true, data: null });
    // Whether the site has the helper's installer, asked by the computer; no other address.
    await say("req", "r11", { type: "phone.installer", url: "https://noa.bot/helper/install.sh" });
    await say("req", "r12", { type: "phone.installer", url: "https://evil.test/x" });
    await flush();
    await read();
    expect(got.find((g) => g.id === "r11")!.msg).toEqual({ ok: true, data: { status: 404 } });
    expect(got.find((g) => g.id === "r12")!.msg).toEqual({ ok: false, error: "Not the helper's installer" });

    // The job the panel shows counts as watched; a tab's title for the "Working in" row.
    await say("req", "r6", { type: "phone.watch", job: "chat:s9" });
    await say("req", "r7", { type: "phone.tab", tabId: 77 });
    await flush();
    await read();
    expect(env.link.isWatching("s9")).toBe(true);
    expect(got).toContainEqual({ ch: "res", id: "r7", msg: { ok: true, data: { url: "https://www.facebook.com/login", title: "Log in" } } });

    // The phone goes away: its port closes, and the hub's pushes to it stop.
    let closed = false;
    env.panels[0]!.onDisconnect.addListener(() => (closed = true));
    ws.hub({ t: "presence", device: "ph1", online: false });
    await flush();
    expect(closed).toBe(true);
    expect(() => env.panels[0]!.postMessage({ type: "tasks.changed" })).toThrow();
  });

  it("a message that cannot be sealed ends the session and asks the phone to start over; later ones are not lost", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    const ws = env.sockets[0]!;
    ws.open();
    const phone = await phoneFor(env, url);
    ws.hub({ t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } });
    await flush();
    const desk = publicIdentity((await env.deps.vault.load())!);
    const handshake = async () => {
      const pending = startHandshake(desk);
      const before = ws.sent.length;
      ws.hub({ t: "recv", from: "ph1", kind: "hello", body: JSON.stringify(encodeHello(pending.hello)) });
      await flush();
      const welcome = ws.sent.slice(before).find((f) => f.kind === "welcome")!;
      return finishHandshake(phone.keys, desk, pending, decodeWelcome(JSON.parse(String(welcome.body))));
    };
    const s1 = await handshake();
    const sync = toB64(await s1.seal(JSON.stringify({ type: "sync" })));
    // The desktop's next seal (its answer to sync) fails.
    const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("OperationError"));
    ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: sync });
    await flush();
    encrypt.mockRestore();
    expect(ws.sent.at(-1)).toEqual({ t: "send", to: "ph1", kind: "rekey", body: "" });

    // The phone's new handshake works, and the desktop's messages reach it again.
    const s2 = await handshake();
    const before = ws.sent.length;
    ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: toB64(await s2.seal(JSON.stringify({ type: "sync" }))) });
    await flush();
    const reply = ws.sent.slice(before).find((f) => f.kind === "sealed")!;
    expect(JSON.parse(await s2.open(fromB64(String(reply.body))))).toMatchObject({ type: "state", desktopName: "Noa on Linux" });
  });

  it("a phone-started job that needs the user, or is done, asks the hub to notify every phone; the user's own desktop chats do not", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    const ws = env.sockets[0]!;
    ws.open();
    const phone = await phoneFor(env, url);
    ws.hub({ t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } });
    await flush();
    const desk = publicIdentity((await env.deps.vault.load())!);
    const pending = startHandshake(desk);
    ws.hub({ t: "recv", from: "ph1", kind: "hello", body: JSON.stringify(encodeHello(pending.hello)) });
    await flush();
    const s = await finishHandshake(phone.keys, desk, pending, decodeWelcome(JSON.parse(String(ws.sent.find((f) => f.kind === "welcome")!.body))));
    ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: toB64(await s.seal(JSON.stringify({ type: "job.start", requestId: "r", text: "go", attachmentIds: [] }))) });
    await flush();
    const notes = () => ws.sent.filter((f) => f.t === "notify");
    env.link.onEvent({ type: "approval_request", request: { id: "a", action: "Click Publish", site: "x", why: "publishes", expiresAt: "z" }, ts: "t", sessionId: "s1" } as StampedAgentEvent);
    env.link.onEvent({ type: "task_end", outcome: "done", ts: "t", sessionId: "s1" } as StampedAgentEvent);
    // A chat typed at the desktop (not the phone's): the user is there.
    env.deps.sessions.get = async (id) => session(id);
    env.link.onEvent({ type: "task_end", outcome: "paused", ts: "t", sessionId: "desk-chat" } as StampedAgentEvent);
    await flush();
    expect(notes()).toEqual([
      { t: "notify", to: "ph1", kind: "needs_you" },
      { t: "notify", to: "ph1", kind: "done" },
    ]);
  });

  it("a pairing told again when the desktop reconnects is ignored; one told late is still checked with the code's secret", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    const ws = env.sockets[0]!;
    ws.open();
    const phone = await phoneFor(env, url);
    const paired = { t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } } as const;
    ws.hub(paired);
    await flush();
    ws.hub(paired);
    await flush();
    expect(env.getState()?.phones).toHaveLength(1);
    expect(env.calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  it("a changed message ends the session; a revoked socket forgets the link", async () => {
    const env = setup();
    const { url } = await env.link.pair();
    const ws = env.sockets[0]!;
    ws.open();
    const phone = await phoneFor(env, url);
    ws.hub({ t: "paired", phone: { id: "ph1", name: "iPhone", identity: phone.identity, proof: phone.proof } });
    await flush();
    const desk = publicIdentity((await env.deps.vault.load())!);
    const pending = startHandshake(desk);
    ws.hub({ t: "recv", from: "ph1", kind: "hello", body: JSON.stringify(encodeHello(pending.hello)) });
    await flush();
    const s = await finishHandshake(phone.keys, desk, pending, decodeWelcome(JSON.parse(String(ws.sent.find((f) => f.kind === "welcome")!.body))));
    const sealed = await s.seal(JSON.stringify({ type: "stop", sessionId: "s1" }));
    sealed[3]! ^= 1;
    ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: toB64(sealed) });
    await flush();
    expect(env.handled.find((m) => m.type === "run.stop")).toBeUndefined();
    expect(env.link.isWatching("s1")).toBe(false);
    // The phone is told to start over; until it does, what it sends is answered the same way.
    expect(ws.sent.filter((f) => f.kind === "rekey")).toEqual([{ t: "send", to: "ph1", kind: "rekey", body: "" }]);
    ws.hub({ t: "recv", from: "ph1", kind: "sealed", body: toB64(await s.seal("{}")) });
    await flush();
    expect(ws.sent.filter((f) => f.kind === "rekey")).toHaveLength(2);

    ws.close(4401, "device revoked");
    await flush();
    expect(env.getState()).toBeUndefined();
  });
});
