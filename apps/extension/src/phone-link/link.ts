/**
 * The desktop end of the phone link (docs/MOBILE.md). This browser registers as a desktop with the account
 * (POST /v1/devices/desktop), shows pairing codes, and while a phone is paired keeps a WebSocket to the account's
 * DeviceHub (GET /v1/devices/ws). Everything to and from a phone is end-to-end encrypted (@noa/shared/phone-link):
 * the hub only routes it.
 *
 * The phone shows the extension's own side panel (apps/extension/src/phone-panel/): its requests reach UiRouter as a
 * side panel's do, and the background's pushes reach it through a port of the UiHub (PanelPort), all over the link in
 * parts (UiPart). Older phone pages send the plain messages below instead. Either way a new job opens in a minimized
 * window of its own (a phone never takes over the tab the user is looking at, and the job's tab paints: screen.ts), a message
 * goes on in a conversation, an approval is answered, a run stops. The phone sees the conversation it shows as plain
 * steps (events.ts), the job's tab live (screen.ts), and gets a push notification (through the hub) when a job of
 * its own, or a scheduled one, needs the user or is done.
 */
import type { SessionInfo, StampedAgentEvent } from "@noa/shared";
import {
  answerHandshake,
  decodeHello,
  decodeIdentity,
  encodeIdentity,
  encodeWelcome,
  ensureKeys,
  fingerprint,
  fromB64,
  LINK_PROTOCOL,
  LINK_TOKEN_PROTOCOL_PREFIX,
  PHONE_PATH,
  PhoneMessage,
  publicIdentity,
  randomBytes,
  RegisterDesktopResponse,
  StartPairingResponse,
  toB64,
  verifyPairingProof,
  type DesktopMessage,
  type EncodedIdentity,
  type HubFrame,
  type KeyVault,
  type PairedPhone,
  type Session,
  type StaticKeys,
} from "@noa/shared/phone-link";
import { errorMessage, HELPER_INSTALL_URL } from "@noa/shared";
import { UiAssembler, uiParts, type UiPart } from "@noa/shared/phone-link/protocol";
import type { DesktopInfo } from "@noa/shared/phone-link/panel-bridge";
import { history, phoneJob, stamped } from "./events.js";
import { RemoteScreen, type ScreenDeps } from "./screen.js";

/** What is kept in chrome.storage.local (the device token is a bearer secret, like the account's session token). */
export interface LinkState {
  apiBase: string;
  deviceId: string;
  token: string;
  phones: { id: string; name: string; identity: EncodedIdentity }[];
  /** The code being shown (url: the address the QR code holds). */
  pending?: { pairingId: string; secret: string; expiresAt: string; url: string };
  /** Jobs the phones started (newest last): their news reaches the phone as a push notification. */
  jobs?: string[];
}

export interface PhoneLinkView {
  signedIn: boolean;
  connected: boolean;
  phones: { id: string; name: string; online: boolean }[];
  /** The pairing code being shown: the address the QR code holds. */
  pairing: { url: string; expiresAt: string } | null;
}

type WebSocketLike = Pick<WebSocket, "readyState" | "send" | "close" | "onopen" | "onmessage" | "onclose" | "onerror">;

export interface PhoneLinkDeps {
  session(): Promise<{ token: string; apiBase: string } | null>;
  loadState(): Promise<LinkState | undefined>;
  saveState(state: LinkState | undefined): Promise<void>;
  vault: KeyVault;
  fetch: typeof fetch;
  openSocket(url: string, protocols: string[]): WebSocketLike;
  /** The side panel's requests (UiRouter.handle). */
  handle(msg: Record<string, unknown> & { type: string }): Promise<unknown>;
  /** The phone's side panel (or Settings) opened its push port: the background pushes to it as to theirs (UiHub). */
  attachPanel(port: PanelPort): void;
  /** What the phone's Settings page shows of this extension (its version and id, the browser, bookmark sync). */
  info(): Promise<DesktopInfo>;
  /** A value of chrome.storage.local the Settings page reads (only PHONE_READABLE keys are asked for). */
  stored(key: string): Promise<unknown>;
  /** A new tab for a job the phone starts: the active tab of a minimized window of its own. */
  openTab(): Promise<number>;
  /** What the remote screen needs (screen.ts), but where it posts. */
  screen: Omit<ScreenDeps, "post" | "log" | "running">;
  sessions: {
    list(limit: number): Promise<SessionInfo[]>;
    get(sessionId: string): Promise<SessionInfo | null>;
    eventsOf(sessionId: string): Promise<StampedAgentEvent[]>;
  };
  running(): string[];
  awaiting(): string[];
  desktopName(): Promise<string>;
  onChange(): void;
  log(message: string): void;
}

const PING_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const UPLOAD_TTL_MS = 10 * 60_000;
const STATE_DEBOUNCE_MS = 300;
const JOBS_SHOWN = 20;
/** A phone-started job's id is kept this long (the most recent ones) for its notifications. */
const JOBS_KEPT = 100;
/** A pairing proof is still checked this long after its code expired (the hub may tell a paired phone late). */
const PROOF_GRACE_MS = 30 * 60_000;
/** Close code of a revoked device (apps/api devices/hub.ts HUB_CLOSE.revoked). */
const CLOSE_REVOKED = 4401;

interface Upload {
  name: string;
  type: string;
  /** The parts that came, base64 each; the file is whole once every one did. */
  parts: (string | undefined)[];
  width?: number;
  height?: number;
  at: number;
}

/** A phone's side panel port, as the UiHub sees a side panel's: what is posted to it goes to the phone. */
export interface PanelPort {
  name: string;
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(fn: () => void): void };
}

/** Signing in to the account opens Google's window on the computer: the phone cannot do it. */
const PHONE_REFUSED = /^account\.signIn$/;
const ON_THE_COMPUTER = "Do this in Noa on your computer.";
/** Where the helper's installers are (the phone's Settings asks the computer whether one is there). */
const HELPER_INSTALL_DIR = HELPER_INSTALL_URL.slice(0, HELPER_INSTALL_URL.lastIndexOf("/") + 1);
/** chrome.storage.local keys the phone's Settings page may read: Noa Browser's bookmark sync state (bookmarks/sync.ts). */
const PHONE_READABLE = new Set(["bookmarkSync"]);

/** One paired phone's live end: its session (after a handshake), what it shows, files it sent for its next request. */
interface PhoneEnd {
  session: Promise<Session> | null;
  /** Sends and opens run one at a time: the session's counters are strict. */
  chain: Promise<void>;
  watching: string | null;
  uploads: Map<string, Upload>;
  screen: RemoteScreen;
  /** Side panel messages coming in parts. */
  parts: UiAssembler;
  /** The phone's side panel ports that are open, by id; closing one tells its listeners. */
  ports: Map<string, () => void>;
}

export class PhoneLink {
  private ws: WebSocketLike | null = null;
  private connected = false;
  private online = new Set<string>();
  private ends = new Map<string, PhoneEnd>();
  private backoff = 1000;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private keys: StaticKeys | null = null;

  constructor(private readonly deps: PhoneLinkDeps) {}

  /** Connects when a phone is paired or a code is shown (called at every worker start and on sign-in changes). */
  async start(): Promise<void> {
    const state = await this.state();
    if (!state || (!state.phones.length && !this.pendingOf(state))) return this.stop();
    if (this.ws) return;
    this.connect(state);
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.online.clear();
    this.dropEnds();
    ws?.close(1000, "stopped");
  }

  async view(): Promise<PhoneLinkView> {
    const signedIn = !!(await this.deps.session());
    const state = await this.state();
    const pending = state ? this.pendingOf(state) : null;
    return {
      signedIn,
      connected: this.connected,
      phones: (state?.phones ?? []).map((p) => ({ id: p.id, name: p.name, online: this.online.has(p.id) })),
      pairing: pending ? { url: pending.url, expiresAt: pending.expiresAt } : null,
    };
  }

  /** A new pairing code: registers this browser first if needed. Returns the address the QR code holds. */
  async pair(): Promise<{ url: string; expiresAt: string }> {
    const state = await this.ensureRegistered();
    const res = await this.call(state, "/v1/devices/pairings", { method: "POST" });
    const pairing = StartPairingResponse.parse(await res.json());
    const secret = randomBytes(32);
    const keys = await this.loadKeys();
    const fp = fingerprint(publicIdentity(keys));
    // The fragment never reaches a server: the phone's page reads it.
    const url = `${state.apiBase}${PHONE_PATH}#${pairing.pairingId}.${pairing.pairToken}.${toB64(secret)}.${toB64(fp)}`;
    await this.deps.saveState({ ...state, pending: { pairingId: pairing.pairingId, secret: toB64(secret), expiresAt: pairing.expiresAt, url } });
    await this.start();
    this.deps.onChange();
    return { url, expiresAt: pairing.expiresAt };
  }

  async unpair(phoneId: string): Promise<void> {
    const state = await this.state();
    if (!state) return;
    const res = await this.call(state, `/v1/devices/${encodeURIComponent(phoneId)}`, { method: "DELETE" }, true);
    if (!res.ok && res.status !== 404) throw new Error(`Unpairing failed (HTTP ${res.status})`);
    await this.forgetPhone(phoneId);
  }

  /** The phone shows this conversation: it counts as watched (scheduled runs then wait for its OK, not pause). */
  isWatching(sessionId: string): boolean {
    return [...this.ends.values()].some((e) => e.watching === sessionId);
  }

  /** Every event of every conversation (SessionStore.subscribe). */
  onEvent(e: StampedAgentEvent): void {
    for (const [phoneId, end] of this.ends) {
      if (end.watching !== e.sessionId) continue;
      const line = stamped(e);
      if (line) this.sendTo(phoneId, { type: "event", sessionId: e.sessionId, event: line });
    }
    if (e.type === "approval_request" || e.type === "approval_resolved" || e.type === "task_end" || e.type === "user_message") this.stateSoon();
    if (e.type === "approval_request" || e.type === "task_end") void this.notifyPhones(e).catch((err) => this.deps.log(`phone link: ${errorMessage(err)}`));
  }

  onSession(): void {
    this.stateSoon();
  }

  // ---- connection -------------------------------------------------------------------------------------------------

  private connect(state: LinkState): void {
    const url = `${state.apiBase.replace(/^http/, "ws")}/v1/devices/ws`;
    let ws: WebSocketLike;
    try {
      ws = this.deps.openSocket(url, [LINK_PROTOCOL, `${LINK_TOKEN_PROTOCOL_PREFIX}${state.token}`]);
    } catch (e) {
      this.deps.log(`phone link: connect failed: ${errorMessage(e)}`);
      return this.later();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this.startPing();
      this.deps.onChange();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let frame: HubFrame;
      try {
        frame = JSON.parse(ev.data) as HubFrame;
      } catch {
        return;
      }
      void this.onFrame(frame).catch((e) => this.deps.log(`phone link: ${errorMessage(e)}`));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.online.clear();
      this.dropEnds();
      this.stopPing();
      this.deps.onChange();
      if (ev.code === CLOSE_REVOKED) {
        // This browser was unlinked (from the dashboard, or the account went away): start over at the next pairing.
        void this.deps.saveState(undefined).then(() => this.deps.onChange());
        return;
      }
      this.later();
    };
    ws.onerror = () => {};
  }

  private later(): void {
    if (this.retry) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start().catch(() => {});
    }, wait);
  }

  private startPing(): void {
    this.stopPing();
    // Traffic on the socket keeps the service worker alive (Chrome 116+); the hub answers without waking up.
    this.ping = setInterval(() => this.raw({ t: "ping" }), PING_MS);
  }

  private stopPing(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  private raw(frame: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private async onFrame(frame: HubFrame): Promise<void> {
    switch (frame.t) {
      case "peers":
        this.online = new Set(frame.online);
        this.deps.onChange();
        return;
      case "presence":
        if (frame.online) this.online.add(frame.device);
        else {
          this.online.delete(frame.device);
          this.dropEnd(frame.device);
        }
        this.deps.onChange();
        return;
      case "paired":
        return this.onPaired(frame.phone);
      case "revoked":
        return this.forgetPhone(frame.device);
      case "recv":
        return this.onRecv(frame.from, frame.kind, frame.body);
      default:
        return;
    }
  }

  private async onPaired(phone: PairedPhone): Promise<void> {
    const state = await this.state();
    // Told again (the hub replays recent pairings when this desktop connects): already known.
    if (state?.phones.some((p) => p.id === phone.id)) return;
    const pending = state?.pending && Date.parse(state.pending.expiresAt) + PROOF_GRACE_MS > Date.now() ? state.pending : null;
    const keys = await this.loadKeys();
    let ok = false;
    try {
      ok = !!pending && verifyPairingProof(fromB64(pending.secret), decodeIdentity(phone.identity), fingerprint(publicIdentity(keys)), fromB64(phone.proof));
    } catch {
      ok = false;
    }
    if (!state || !ok) {
      // Not the phone that read this computer's code: whoever it is gets nothing.
      this.deps.log(`phone link: refused a phone whose pairing proof did not check out (${phone.id})`);
      if (state) await this.call(state, `/v1/devices/${encodeURIComponent(phone.id)}`, { method: "DELETE" }, true).catch(() => undefined);
      return;
    }
    const { pending: _done, ...rest } = state;
    await this.deps.saveState({ ...rest, phones: [...state.phones.filter((p) => p.id !== phone.id), { id: phone.id, name: phone.name, identity: phone.identity }] });
    this.deps.onChange();
  }

  private dropEnd(phoneId: string): void {
    const end = this.ends.get(phoneId);
    void end?.screen.stop("disconnected");
    if (end) closePorts(end);
    this.ends.delete(phoneId);
  }

  private dropEnds(): void {
    for (const id of [...this.ends.keys()]) this.dropEnd(id);
  }

  private screenFor(phoneId: string): RemoteScreen {
    return new RemoteScreen({
      ...this.deps.screen,
      running: (sessionId) => this.deps.running().includes(sessionId),
      post: (msg) => this.sendTo(phoneId, msg),
      log: this.deps.log,
    });
  }

  private async forgetPhone(phoneId: string): Promise<void> {
    const state = await this.state();
    this.dropEnd(phoneId);
    this.online.delete(phoneId);
    if (state) await this.deps.saveState({ ...state, phones: state.phones.filter((p) => p.id !== phoneId) });
    this.deps.onChange();
    await this.start();
  }

  private async onRecv(from: string, kind: string, body: string): Promise<void> {
    const state = await this.state();
    const phone = state?.phones.find((p) => p.id === from);
    if (!phone) return;
    if (kind === "hello") {
      const keys = await this.loadKeys();
      const { welcome, session } = answerHandshake(keys, decodeIdentity(phone.identity), decodeHello(JSON.parse(body)));
      const old = this.ends.get(from);
      void old?.screen.stop("replaced");
      if (old) closePorts(old);
      this.ends.set(from, {
        session,
        chain: Promise.resolve(),
        watching: null,
        uploads: new Map(),
        screen: this.screenFor(from),
        parts: new UiAssembler(),
        ports: new Map(),
      });
      this.raw({ t: "send", to: from, kind: "welcome", body: JSON.stringify(encodeWelcome(welcome)) });
      return;
    }
    if (kind !== "sealed") return;
    const end = this.ends.get(from);
    // No session for this phone (one that went wrong was dropped): it must start a new one, or its messages go nowhere.
    if (!end?.session) return this.raw({ t: "send", to: from, kind: "rekey", body: "" });
    const session = end.session;
    end.chain = end.chain.then(async () => {
      let msg: PhoneMessage;
      try {
        const parsed = PhoneMessage.safeParse(JSON.parse(await (await session).open(fromB64(body))));
        if (!parsed.success) return this.deps.log("phone link: a phone message did not match the protocol");
        msg = parsed.data;
      } catch (e) {
        // Changed, replayed or out of order: this session is over; the phone starts a new handshake.
        this.deps.log(`phone link: ${errorMessage(e)}`);
        if (this.ends.get(from) === end) {
          closePorts(end);
          this.ends.delete(from);
        }
        this.raw({ t: "send", to: from, kind: "rekey", body: "" });
        return;
      }
      await this.onMessage(from, end, msg).catch((e) =>
        this.sendTo(from, { type: "error", ...("requestId" in msg ? { requestId: msg.requestId } : {}), message: errorMessage(e) }),
      );
    });
  }

  // ---- what a phone asks ------------------------------------------------------------------------------------------

  private async onMessage(phoneId: string, end: PhoneEnd, msg: PhoneMessage): Promise<void> {
    switch (msg.type) {
      case "ui":
        return this.onUi(phoneId, end, msg);
      case "sync":
        return this.sendState(phoneId);
      case "attachment": {
        const now = Date.now();
        for (const [id, u] of end.uploads) if (now - u.at > UPLOAD_TTL_MS) end.uploads.delete(id);
        let u = end.uploads.get(msg.id);
        if (!u || u.parts.length !== msg.parts) {
          u = {
            name: msg.name,
            type: msg.mime,
            parts: new Array<string | undefined>(msg.parts).fill(undefined),
            ...(msg.width ? { width: msg.width } : {}),
            ...(msg.height ? { height: msg.height } : {}),
            at: now,
          };
          end.uploads.set(msg.id, u);
        }
        if (msg.part >= u.parts.length) throw new Error("A file part is out of range");
        u.parts[msg.part] = msg.data;
        u.at = now;
        // Parts may come in any order; any of them may carry the picture's size.
        if (msg.width) u.width = msg.width;
        if (msg.height) u.height = msg.height;
        return;
      }
      case "screen.start":
        return end.screen.start(msg.sessionId, msg.width, msg.height, msg.takeover);
      case "screen.stop":
        return end.screen.stop();
      case "screen.ack":
        return end.screen.ack(msg.frameId);
      case "screen.tap":
        return end.screen.tap(msg.x, msg.y);
      case "screen.text":
        return end.screen.text(msg.text);
      case "screen.key":
        return end.screen.key(msg.key);
      case "screen.scroll":
        return end.screen.scroll(msg.dy);
      case "job.start": {
        const attachments = this.takeUploads(end, msg.attachmentIds);
        const tabId = await this.deps.openTab();
        const res = (await this.deps.handle({ type: "run.message", text: msg.text, tabId, attachments })) as { sessionId?: string; error?: string };
        if (!res?.sessionId) throw new Error(res?.error ?? "The job did not start");
        this.sendTo(phoneId, { type: "started", requestId: msg.requestId, sessionId: res.sessionId });
        end.watching = res.sessionId;
        await this.rememberJob(res.sessionId);
        await this.sendHistory(phoneId, res.sessionId);
        this.stateSoon();
        return;
      }
      case "chat.message": {
        const attachments = this.takeUploads(end, msg.attachmentIds);
        const res = (await this.deps.handle({ type: "run.message", sessionId: msg.sessionId, text: msg.text, attachments })) as { sessionId?: string; error?: string };
        if (!res?.sessionId) throw new Error(res?.error ?? "The message was not sent");
        this.sendTo(phoneId, { type: "started", requestId: msg.requestId, sessionId: res.sessionId });
        return;
      }
      case "approval.answer": {
        const res = (await this.deps.handle({ type: "approval.answer", sessionId: msg.sessionId, id: msg.id, answer: msg.answer, by: "card" })) as { ok?: boolean };
        if (!res?.ok) throw new Error("That request is no longer waiting");
        return;
      }
      case "stop":
        await this.deps.handle({ type: "run.stop", sessionId: msg.sessionId });
        return;
      case "watch":
        end.watching = msg.sessionId;
        if (msg.sessionId) await this.sendHistory(phoneId, msg.sessionId);
        return;
    }
  }

  // ---- the phone's side panel -------------------------------------------------------------------------------------

  private async onUi(phoneId: string, end: PhoneEnd, part: UiPart): Promise<void> {
    const json = end.parts.add(part);
    if (json === null) return;
    switch (part.ch) {
      case "open": {
        if (end.ports.has(part.id)) return;
        const listeners: (() => void)[] = [];
        let open = true;
        end.ports.set(part.id, () => {
          open = false;
          for (const fn of listeners) fn();
        });
        this.deps.attachPanel({
          name: String(JSON.parse(json)),
          postMessage: (msg) => {
            if (!open) throw new Error("The phone's panel is closed");
            this.sendUi(phoneId, "push", part.id, msg);
          },
          onDisconnect: { addListener: (fn) => void listeners.push(fn) },
        });
        return;
      }
      case "close":
        end.ports.get(part.id)?.();
        end.ports.delete(part.id);
        return;
      case "req": {
        let res: { ok: true; data: unknown } | { ok: false; error: string };
        try {
          res = { ok: true, data: await this.panelRequest(end, JSON.parse(json) as Record<string, unknown> & { type: string }) };
        } catch (e) {
          res = { ok: false, error: errorMessage(e) };
        }
        this.sendUi(phoneId, "res", part.id, res);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A request of the phone's side panel, as the router takes a side panel's. The phone has no tab of the computer's in
   * front: a new job gets a minimized window of its own (as job.start), and is remembered for its notifications.
   */
  private async panelRequest(end: PhoneEnd, req: Record<string, unknown> & { type: string }): Promise<unknown> {
    if (typeof req?.type !== "string") throw new Error("Not a request");
    if (PHONE_REFUSED.test(req.type)) throw new Error(ON_THE_COMPUTER);
    switch (req.type) {
      // The job the phone's panel shows (its view's job key): it counts as watched.
      case "phone.watch":
        end.watching = typeof req.job === "string" && req.job.startsWith("chat:") ? req.job.slice("chat:".length) : null;
        return { ok: true };
      case "phone.info":
        return await this.deps.info();
      // Settings checks the helper's installer is on the site: the phone's browser may not ask another site (CORS).
      case "phone.installer": {
        const url = String(req.url ?? "");
        if (!url.startsWith(HELPER_INSTALL_DIR)) throw new Error("Not the helper's installer");
        return { status: (await this.deps.fetch(url, { method: "HEAD", cache: "no-store" })).status };
      }
      case "phone.storage":
        return typeof req.key === "string" && PHONE_READABLE.has(req.key) ? ((await this.deps.stored(req.key)) ?? null) : null;
      // Settings > Account > Your phone, from the phone.
      case "phone.view":
        return await this.view();
      case "phone.pair":
        return await this.pair();
      case "phone.unpair":
        await this.unpair(String(req.id ?? ""));
        return { ok: true };
      // A tab of the computer's, for the job page's "Working in" row.
      case "phone.tab":
        return typeof req.tabId === "number" ? await this.deps.screen.tabInfo(req.tabId) : null;
      // Going to a job's tab: the phone shows it live (screen.start), to watch, or to take over while the job waits.
      case "tab.focus":
      case "agent.show": {
        const sessionId = req.type === "agent.show" ? (typeof req.sessionId === "string" ? req.sessionId : this.deps.running()[0]) : await this.sessionOfTab(Number(req.tabId));
        return sessionId ? { ok: true, screen: { sessionId, takeover: !this.deps.running().includes(sessionId) } } : { ok: false };
      }
    }
    const isNew = req.type === "run.adhoc" || (req.type === "run.message" && !req.sessionId);
    const out = isNew && typeof req.tabId !== "number" ? { ...req, tabId: await this.deps.openTab() } : req;
    const data = await this.deps.handle(out);
    if (isNew) {
      const sessionId = (data as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId === "string") await this.rememberJob(sessionId);
    }
    return data;
  }

  /** The conversation a tab of this computer belongs to: its chat's, or a run's acting there, or one the agent kept open. */
  private async sessionOfTab(tabId: number): Promise<string | undefined> {
    const state = (await this.deps.handle({ type: "state.get" })) as {
      tabChats?: Record<string, string>;
      runningTabs?: Record<string, number[]>;
      chatTabs?: Record<string, number[]>;
    };
    const holding = (map: Record<string, number[]> | undefined) => Object.entries(map ?? {}).find(([, tabs]) => tabs.includes(tabId))?.[0];
    return state.tabChats?.[String(tabId)] ?? holding(state.runningTabs) ?? holding(state.chatTabs);
  }

  private sendUi(phoneId: string, ch: UiPart["ch"], id: string, msg: unknown): void {
    for (const p of uiParts(ch, id, JSON.stringify(msg))) this.sendTo(phoneId, p);
  }

  /** The files `ids` as the side panel sends them (UiAttachmentUpload), each whole. */
  private takeUploads(end: PhoneEnd, ids: string[]): { name: string; type: string; dataBase64: string; width?: number; height?: number }[] {
    const out: { name: string; type: string; dataBase64: string; width?: number; height?: number }[] = [];
    for (const id of ids) {
      const u = end.uploads.get(id);
      if (!u || u.parts.some((p) => p === undefined)) throw new Error("A file did not arrive whole; send it again");
      end.uploads.delete(id);
      out.push({
        name: u.name,
        type: u.type,
        dataBase64: joinBase64(u.parts as string[]),
        ...(u.width ? { width: u.width } : {}),
        ...(u.height ? { height: u.height } : {}),
      });
    }
    return out;
  }

  private async rememberJob(sessionId: string): Promise<void> {
    const state = await this.state();
    if (!state) return;
    const jobs = [...(state.jobs ?? []).filter((j) => j !== sessionId), sessionId].slice(-JOBS_KEPT);
    await this.deps.saveState({ ...state, jobs });
  }

  /**
   * A push notification on every paired phone (the hub sends it only to a phone whose page is not in front), for a job
   * a phone started, or a scheduled one (nobody at the computer started it).
   */
  private async notifyPhones(e: StampedAgentEvent): Promise<void> {
    const kind = e.type === "approval_request" ? "needs_you" : e.type === "task_end" ? (e.outcome === "paused" ? "needs_you" : "done") : null;
    if (!kind || !this.connected) return;
    const state = await this.state();
    if (!state?.phones.length) return;
    const ours = state.jobs?.includes(e.sessionId) || (await this.deps.sessions.get(e.sessionId))?.source !== "adhoc";
    if (!ours) return;
    for (const p of state.phones) this.raw({ t: "notify", to: p.id, kind });
  }

  private async sendHistory(phoneId: string, sessionId: string): Promise<void> {
    const s = await this.deps.sessions.get(sessionId);
    if (!s) return this.sendTo(phoneId, { type: "error", message: "That job is gone from this computer" });
    this.sendTo(phoneId, { type: "history", sessionId, title: s.title, events: history(s, await this.deps.sessions.eventsOf(sessionId)) });
  }

  private stateSoon(): void {
    if (this.stateTimer || !this.ends.size) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      for (const phoneId of this.ends.keys()) void this.sendState(phoneId).catch(() => {});
    }, STATE_DEBOUNCE_MS);
  }

  private async sendState(phoneId: string): Promise<void> {
    const running = new Set(this.deps.running());
    const awaiting = new Set(this.deps.awaiting());
    const jobs = (await this.deps.sessions.list(JOBS_SHOWN)).map((s) => phoneJob(s, running.has(s.sessionId), awaiting.has(s.sessionId)));
    this.sendTo(phoneId, { type: "state", desktopName: await this.deps.desktopName(), jobs });
  }

  private sendTo(phoneId: string, msg: DesktopMessage): void {
    const end = this.ends.get(phoneId);
    if (!end?.session) return;
    const session = end.session;
    end.chain = end.chain
      .then(async () => {
        const sealed = await (await session).seal(JSON.stringify(msg));
        this.raw({ t: "send", to: phoneId, kind: "sealed", body: toB64(sealed) });
      })
      .catch((e: unknown) => {
        // A message that could not be sealed leaves this session's counters out of step with the phone's: the session
        // is over. Dropping it (only if it is still this one) and saying rekey makes the phone start a fresh one.
        this.deps.log(`phone link: sending to ${phoneId} failed, ending its session: ${errorMessage(e)}`);
        if (this.ends.get(phoneId) !== end) return;
        closePorts(end);
        this.ends.delete(phoneId);
        this.raw({ t: "send", to: phoneId, kind: "rekey", body: "" });
      });
  }

  // ---- registration -----------------------------------------------------------------------------------------------

  private async loadKeys(): Promise<StaticKeys> {
    this.keys ??= await ensureKeys(this.deps.vault);
    return this.keys;
  }

  /** The stored link, if it belongs to the account server signed in to now. */
  private async state(): Promise<LinkState | null> {
    const [state, session] = await Promise.all([this.deps.loadState(), this.deps.session()]);
    if (!state || !session || state.apiBase !== session.apiBase) return null;
    return state;
  }

  private pendingOf(state: LinkState): LinkState["pending"] | null {
    return state.pending && Date.parse(state.pending.expiresAt) > Date.now() ? state.pending : null;
  }

  private async ensureRegistered(): Promise<LinkState> {
    const existing = await this.state();
    if (existing) return existing;
    const session = await this.deps.session();
    if (!session) throw new Error("Sign in to Noa on this computer first");
    const keys = await this.loadKeys();
    const res = await this.deps.fetch(`${session.apiBase}/v1/devices/desktop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: await this.deps.desktopName(), identity: encodeIdentity(publicIdentity(keys)) }),
    });
    if (!res.ok) throw new Error(`Could not link this computer (HTTP ${res.status})`);
    const reg = RegisterDesktopResponse.parse(await res.json());
    const state: LinkState = { apiBase: session.apiBase, deviceId: reg.deviceId, token: reg.token, phones: [] };
    await this.deps.saveState(state);
    return state;
  }

  private async call(state: LinkState, path: string, init: RequestInit, allowFail = false): Promise<Response> {
    const res = await this.deps.fetch(`${state.apiBase}${path}`, { ...init, headers: { Authorization: `Bearer ${state.token}` } });
    if (res.status === 401) {
      // This computer was unlinked: forget it, so the next pairing registers again.
      await this.deps.saveState(undefined);
      this.stop();
      throw new Error("This computer was unlinked from your phone. Try again.");
    }
    if (!res.ok && !allowFail) throw new Error(`HTTP ${res.status}`);
    return res;
  }
}

/** The phone's side panel ports of this end are gone (its session ended): the UiHub lets them go. */
function closePorts(end: PhoneEnd): void {
  for (const close of end.ports.values()) close();
  end.ports.clear();
}

/** Base64 parts (each from whole bytes, so each may end in padding) as one base64 string. */
export function joinBase64(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  let bin = "";
  for (const p of parts) bin += atob(p);
  return btoa(bin);
}
