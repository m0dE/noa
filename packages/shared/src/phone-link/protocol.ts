/**
 * The phone link's wire formats (docs/MOBILE.md). Two layers:
 *
 * - Hub frames: plain JSON between a device and apps/api's DeviceHub. The hub routes them by device id and
 *   never sees inside `body`: a handshake message, or a sealed message (base64url AES-GCM ciphertext).
 * - Link messages: what is sealed inside, between the paired phone and desktop.
 */
import { z } from "zod";

/** WebSocket subprotocol of GET /v1/devices/ws; the device token rides as a second one, `nd.<token>`. */
export const LINK_PROTOCOL = "noa-link";
export const LINK_TOKEN_PROTOCOL_PREFIX = "nd.";
/** Device tokens: `nd_` + 48 hex. Only their SHA-256 is stored. */
export const DEVICE_TOKEN_RE = /^nd_[0-9a-f]{48}$/;
/** Pairing tokens (the part of the QR code the server checks): `np_` + 48 hex. */
export const PAIR_TOKEN_RE = /^np_[0-9a-f]{48}$/;
export const PAIRING_MINUTES = 10;
/** A frame's largest body. Workers accept WebSocket messages up to 1 MiB. */
export const MAX_FRAME_BODY = 900_000;
/**
 * Bytes of a file per `attachment` message: base64 inside the sealed JSON, sealed, then base64 again on the wire grows
 * it about 1.8 times, so a part stays under MAX_FRAME_BODY.
 */
export const ATTACHMENT_PART_BYTES = 384 * 1024;
/** A phone file's largest size (the extension's per-file limit, packages/shared/src/attachments.ts). */
export const MAX_PHONE_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Characters of a side panel request, answer or push per `ui` message (see UiPart): sealed and base64 on the wire, a
 * part stays under MAX_FRAME_BODY.
 */
export const UI_PART_CHARS = 400_000;
/** A whole side panel message's largest size, in parts (a chat's attachments, a long conversation's events). */
export const MAX_UI_PARTS = 120;
/** What the phone path of the app is served at (apps/dashboard's phone.html). */
export const PHONE_PATH = "/phone";

export const DeviceKind = z.enum(["desktop", "phone"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

export const EncodedIdentity = z.object({ x: z.string().min(40).max(50), kem: z.string().min(1500).max(1700) });
export type EncodedIdentity = z.infer<typeof EncodedIdentity>;

export const DeviceName = z.string().trim().min(1).max(60);

export const Device = z.object({
  id: z.string(),
  kind: DeviceKind,
  name: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  /** A phone's desktop. */
  pairedWith: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

/** POST /v1/devices/desktop: this browser registers (or re-registers) as a desktop. */
export const RegisterDesktopInput = z.object({ name: DeviceName, identity: EncodedIdentity });
export const RegisterDesktopResponse = z.object({ deviceId: z.string(), token: z.string() });
export type RegisterDesktopResponse = z.infer<typeof RegisterDesktopResponse>;

/** POST /v1/devices/pairings (desktop's device token). */
export const StartPairingResponse = z.object({ pairingId: z.string(), pairToken: z.string(), expiresAt: z.string() });
export type StartPairingResponse = z.infer<typeof StartPairingResponse>;

/** GET /v1/devices/pairings/:id (the pairing token as Bearer): what the phone checks against the QR code. */
export const PairingInfo = z.object({ desktopName: z.string(), identity: EncodedIdentity, expiresAt: z.string() });
export type PairingInfo = z.infer<typeof PairingInfo>;

/** POST /v1/devices/pairings/:id/complete (the pairing token as Bearer). */
export const CompletePairingInput = z.object({ name: DeviceName, identity: EncodedIdentity, proof: z.string().min(40).max(80) });
export const CompletePairingResponse = z.object({ deviceId: z.string(), token: z.string(), desktopId: z.string() });
export type CompletePairingResponse = z.infer<typeof CompletePairingResponse>;

/**
 * hello (phone) / welcome (desktop): the handshake. sealed: a message of the session. rekey (desktop): it has no
 * session for this phone (it ended one that went wrong, or never had one): the phone starts a new handshake.
 */
export const HandshakeKind = z.enum(["hello", "welcome", "sealed", "rekey"]);
export type HandshakeKind = z.infer<typeof HandshakeKind>;

/** Device → hub. */
export const ClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("send"), to: z.string().min(1).max(64), kind: HandshakeKind, body: z.string().max(MAX_FRAME_BODY) }),
  z.object({ t: z.literal("ping") }),
  /** The phone's page is in front (or not): a phone that is not gets a push notification for `notify`. */
  z.object({ t: z.literal("visible"), visible: z.boolean() }),
  /**
   * The desktop asks for a push notification on its phone (when its page is not in front). Content-free on purpose:
   * the push service and the hub learn only that something happened, never what.
   */
  z.object({ t: z.literal("notify"), to: z.string().min(1).max(64), kind: z.enum(["needs_you", "done"]) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** A paired phone, as the hub tells its desktop right after pairing (the desktop checks `proof`). */
export const PairedPhone = z.object({ id: z.string(), name: z.string(), identity: EncodedIdentity, proof: z.string() });
export type PairedPhone = z.infer<typeof PairedPhone>;

/** Hub → device. */
export type HubFrame =
  | { t: "recv"; from: string; kind: HandshakeKind; body: string }
  /** On connect: the peers this device may talk to that are online now. */
  | { t: "peers"; online: string[] }
  | { t: "presence"; device: string; online: boolean }
  | { t: "paired"; phone: PairedPhone }
  | { t: "revoked"; device: string }
  | { t: "pong" }
  | { t: "error"; message: string };

const SessionId = z.string().min(1).max(100);

/**
 * The phone shows the extension's own side panel (docs/MOBILE.md, "The phone"), working on this computer: its
 * requests (ui-protocol.ts UiRequest), their answers and the background's pushes (UiPush) go over the link as JSON, in
 * parts of UI_PART_CHARS. ch: req (phone: a request; id names it), res (desktop: the answer to request id), push
 * (desktop: a UiPush), open / close (phone: the panel's push port opens or closes; id names the port).
 */
export const UiPart = z.object({
  type: z.literal("ui"),
  ch: z.enum(["req", "res", "push", "open", "close"]),
  id: z.string().min(1).max(64),
  part: z.number().int().min(0).max(MAX_UI_PARTS - 1),
  parts: z.number().int().min(1).max(MAX_UI_PARTS),
  data: z.string().max(UI_PART_CHARS),
});
export type UiPart = z.infer<typeof UiPart>;

/**
 * A side panel message (JSON) in parts (UiPart), each under UI_PART_CHARS. Characters past ASCII are written as \u
 * escapes first (still the same JSON), so a part's characters are its bytes and it stays under the frame's limit.
 */
export function uiParts(ch: UiPart["ch"], id: string, text: string): UiPart[] {
  const json = text.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const parts = Math.max(1, Math.ceil(json.length / UI_PART_CHARS));
  if (parts > MAX_UI_PARTS) throw new Error("That is too large to send to the phone");
  return Array.from({ length: parts }, (_, part) => ({ type: "ui" as const, ch, id, part, parts, data: json.slice(part * UI_PART_CHARS, (part + 1) * UI_PART_CHARS) }));
}

/**
 * Puts UiParts back together, per channel and id: `add` returns the whole JSON once every part came (parts may come in
 * any order), else null. Messages not finished within `ttlMs` are dropped.
 */
export class UiAssembler {
  private readonly open = new Map<string, { parts: (string | undefined)[]; at: number }>();
  constructor(private readonly ttlMs = 10 * 60_000) {}

  add(p: UiPart, now = Date.now()): string | null {
    if (p.parts === 1) return p.data;
    for (const [k, v] of this.open) if (now - v.at > this.ttlMs) this.open.delete(k);
    const key = `${p.ch}:${p.id}`;
    let m = this.open.get(key);
    if (!m || m.parts.length !== p.parts) {
      m = { parts: new Array<string | undefined>(p.parts).fill(undefined), at: now };
      this.open.set(key, m);
    }
    m.parts[p.part] = p.data;
    m.at = now;
    if (m.parts.some((x) => x === undefined)) return null;
    this.open.delete(key);
    return m.parts.join("");
  }
}

/** Phone → desktop, sealed. */
export const PhoneMessage = z.discriminatedUnion("type", [
  /** First message after a handshake (key confirmation) and on demand: send state. */
  z.object({ type: z.literal("sync") }),
  /**
   * Part `part` (from 0) of `parts` of a photo or file for the next job.start / chat.message; `data` is base64 (not
   * url-safe) of at most ATTACHMENT_PART_BYTES. The desktop puts the parts together.
   */
  z.object({
    type: z.literal("attachment"),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    mime: z.string().max(100),
    part: z.number().int().min(0).max(63),
    parts: z.number().int().min(1).max(Math.ceil(MAX_PHONE_FILE_BYTES / ATTACHMENT_PART_BYTES)),
    data: z.string().max(MAX_FRAME_BODY),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("job.start"), requestId: z.string().max(64), text: z.string().max(8000), attachmentIds: z.array(z.string()).max(10) }),
  z.object({
    type: z.literal("chat.message"),
    requestId: z.string().max(64),
    sessionId: SessionId,
    text: z.string().max(8000),
    attachmentIds: z.array(z.string()).max(10),
  }),
  z.object({ type: z.literal("approval.answer"), sessionId: SessionId, id: z.string().max(100), answer: z.enum(["allow_once", "allow_task", "deny"]) }),
  z.object({ type: z.literal("stop"), sessionId: SessionId }),
  /** The conversation the phone shows (null: none): the desktop sends its history, then its events live. */
  z.object({ type: z.literal("watch"), sessionId: SessionId.nullable() }),
  /**
   * The remote screen (docs/MOBILE.md, section 3): the job's tab, live. width / height: the phone's screen in CSS
   * pixels. takeover: the user drives it (only while the job's turn is not running: the agent waits for the user);
   * the tab is then laid out at the phone's size.
   */
  z.object({
    type: z.literal("screen.start"),
    sessionId: SessionId,
    width: z.number().int().min(240).max(2000),
    height: z.number().int().min(240).max(3000),
    takeover: z.boolean(),
  }),
  z.object({ type: z.literal("screen.stop") }),
  /** The phone drew this frame: the next one may come (one frame in flight keeps a slow network current). */
  z.object({ type: z.literal("screen.ack"), frameId: z.number().int() }),
  /** A tap at the frame's CSS pixel. */
  z.object({ type: z.literal("screen.tap"), x: z.number().min(0).max(10000), y: z.number().min(0).max(10000) }),
  /** Text typed into the focused field. Never stored or logged on either side. */
  z.object({ type: z.literal("screen.text"), text: z.string().max(2000) }),
  z.object({ type: z.literal("screen.key"), key: z.enum(["Enter", "Backspace", "Tab", "Escape"]) }),
  z.object({ type: z.literal("screen.scroll"), dy: z.number().min(-20000).max(20000) }),
  UiPart,
]);
export type PhoneMessage = z.infer<typeof PhoneMessage>;

/** One line of a conversation as the phone shows it: plain steps, never raw page dumps. */
export type PhoneEvent = { ts: string } & (
  | { k: "user"; text: string; files?: number }
  | { k: "text"; text: string }
  | { k: "step"; text: string }
  /** The latest look at the page: a small JPEG (base64), from a tool's screenshot. */
  | { k: "shot"; jpeg: string }
  | { k: "approval"; id: string; action: string; site: string; why: string; text?: string; target?: string; expiresAt: string }
  | { k: "approval_done"; id: string; outcome: string }
  | { k: "end"; outcome: string; summary?: string; url?: string; reason?: string; suggestion?: string }
  | { k: "error"; text: string }
);

export interface ScreenFrame {
  type: "screen.frame";
  frameId: number;
  jpeg: string;
  /** The page's viewport in CSS pixels: what screen.tap's x and y are in. */
  width: number;
  height: number;
  /** The tab's address now (shown above the screen, so the user knows which site they type into). */
  url: string;
}

export interface PhoneJob {
  sessionId: string;
  title: string;
  /** running | needs_you | done | failed | paused | stopped */
  status: string;
  updatedAt: string;
}

/** Desktop → phone, sealed. */
export type DesktopMessage =
  | { type: "state"; desktopName: string; jobs: PhoneJob[] }
  | { type: "started"; requestId: string; sessionId: string }
  | { type: "history"; sessionId: string; title: string; events: PhoneEvent[] }
  | { type: "event"; sessionId: string; event: PhoneEvent }
  | { type: "error"; requestId?: string; message: string }
  | { type: "screen.started"; sessionId: string; interactive: boolean; url: string; title: string }
  | ScreenFrame
  /** What a tap focused: a field that takes text (password: a password field, for the phone's password manager). */
  | { type: "screen.focus"; editable: boolean; password: boolean }
  | { type: "screen.stopped"; reason: string }
  | UiPart;
