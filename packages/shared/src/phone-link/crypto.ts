/**
 * End-to-end encryption between a paired phone and desktop (docs/MOBILE.md, section 1a). The relay
 * (apps/api's DeviceHub) only ever sees what this file produces.
 *
 * Every public-key step is a hybrid: X25519 and ML-KEM-768 (FIPS 203) together, so an attacker must
 * break both. The handshake is authenticated by each side's static keys (KEM-based, as in PQNoise /
 * KEMTLS) instead of signatures: only the real desktop can open what was encapsulated to its static
 * keys, only the real phone what was encapsulated to its own. Fresh ephemeral keys on both sides give
 * forward secrecy. Messages are AES-256-GCM with one key per direction and a strict counter, so a
 * changed, dropped, replayed or reordered message fails to open.
 *
 * The phone (initiator) sends `hello`, the desktop (responder) answers `welcome`; both then derive
 * the same session. Key confirmation is the first sealed message each way.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha384 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

const PROTOCOL = "noa-phone-link/1";
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface StaticKeys {
  x: { secretKey: Uint8Array; publicKey: Uint8Array };
  kem: { secretKey: Uint8Array; publicKey: Uint8Array };
}

export interface PublicIdentity {
  x: Uint8Array;
  kem: Uint8Array;
}

export function generateStaticKeys(): StaticKeys {
  return { x: x25519.keygen(), kem: ml_kem768.keygen() };
}

export function publicIdentity(keys: StaticKeys): PublicIdentity {
  return { x: keys.x.publicKey, kem: keys.kem.publicKey };
}

/** SHA-384 over both public keys: what the pairing QR code carries instead of the (large) keys. */
export function fingerprint(id: PublicIdentity): Uint8Array {
  return sha384(concat(enc.encode(`${PROTOCOL}/id`), id.x, id.kem));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Pairing proof: the phone shows it read the QR code (which only someone at the desktop can) by a MAC
 * over its own keys with the code's one-time secret. The desktop accepts the phone's keys only with it.
 */
export function pairingProof(secret: Uint8Array, phone: PublicIdentity, desktopFingerprint: Uint8Array): Uint8Array {
  const key = hkdf(sha384, secret, undefined, enc.encode(`${PROTOCOL}/pair-mac`), 48);
  return hmac(sha384, key, concat(enc.encode("phone"), fingerprint(phone), desktopFingerprint));
}

export function verifyPairingProof(
  secret: Uint8Array,
  phone: PublicIdentity,
  desktopFingerprint: Uint8Array,
  proof: Uint8Array,
): boolean {
  return equalBytes(pairingProof(secret, phone, desktopFingerprint), proof);
}

/** Phone → desktop. */
export interface Hello {
  ex: Uint8Array;
  ekem: Uint8Array;
  ct: Uint8Array;
}

/** Desktop → phone. */
export interface Welcome {
  ex: Uint8Array;
  ctEphemeral: Uint8Array;
  ctStatic: Uint8Array;
}

export interface PendingHello {
  hello: Hello;
  ex: Uint8Array;
  ekem: Uint8Array;
  ss1: Uint8Array;
}

/** Phone: start a handshake with the paired desktop. */
export function startHandshake(desktop: PublicIdentity): PendingHello {
  const e = x25519.keygen();
  const ek = ml_kem768.keygen();
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(desktop.kem);
  return {
    hello: { ex: e.publicKey, ekem: ek.publicKey, ct: cipherText },
    ex: e.secretKey,
    ekem: ek.secretKey,
    ss1: sharedSecret,
  };
}

/** Desktop: answer a phone's hello. Throws on malformed input. */
export function answerHandshake(
  desktop: StaticKeys,
  phone: PublicIdentity,
  hello: Hello,
): { welcome: Welcome; session: Promise<Session> } {
  const ss1 = ml_kem768.decapsulate(hello.ct, desktop.kem.secretKey);
  const e = x25519.keygen();
  const eph = ml_kem768.encapsulate(hello.ekem);
  const stat = ml_kem768.encapsulate(phone.kem);
  const welcome: Welcome = { ex: e.publicKey, ctEphemeral: eph.cipherText, ctStatic: stat.cipherText };
  const dh1 = x25519.getSharedSecret(desktop.x.secretKey, hello.ex);
  const dh2 = x25519.getSharedSecret(e.secretKey, hello.ex);
  const dh3 = x25519.getSharedSecret(e.secretKey, phone.x);
  const ikm = concat(dh1, dh2, dh3, ss1, eph.sharedSecret, stat.sharedSecret);
  const th = transcript(phone, publicIdentity(desktop), hello, welcome);
  return { welcome, session: deriveSession(ikm, th, "desktop") };
}

/** Phone: finish with the desktop's welcome. */
export function finishHandshake(
  phone: StaticKeys,
  desktop: PublicIdentity,
  pending: PendingHello,
  welcome: Welcome,
): Promise<Session> {
  const ss2 = ml_kem768.decapsulate(welcome.ctEphemeral, pending.ekem);
  const ss3 = ml_kem768.decapsulate(welcome.ctStatic, phone.kem.secretKey);
  const dh1 = x25519.getSharedSecret(pending.ex, desktop.x);
  const dh2 = x25519.getSharedSecret(pending.ex, welcome.ex);
  const dh3 = x25519.getSharedSecret(phone.x.secretKey, welcome.ex);
  const ikm = concat(dh1, dh2, dh3, pending.ss1, ss2, ss3);
  const th = transcript(publicIdentity(phone), desktop, pending.hello, welcome);
  return deriveSession(ikm, th, "phone");
}

function transcript(phone: PublicIdentity, desktop: PublicIdentity, hello: Hello, welcome: Welcome): Uint8Array {
  return sha384(
    concat(
      enc.encode(PROTOCOL),
      fingerprint(phone),
      fingerprint(desktop),
      hello.ex,
      hello.ekem,
      hello.ct,
      welcome.ex,
      welcome.ctEphemeral,
      welcome.ctStatic,
    ),
  );
}

async function deriveSession(ikm: Uint8Array, th: Uint8Array, side: "phone" | "desktop"): Promise<Session> {
  const okm = hkdf(sha384, ikm, th, enc.encode(`${PROTOCOL}/keys`), 64);
  const toDesktop = await aesKey(okm.slice(0, 32));
  const toPhone = await aesKey(okm.slice(32, 64));
  okm.fill(0);
  ikm.fill(0);
  return side === "phone" ? new Session(toDesktop, toPhone, th) : new Session(toPhone, toDesktop, th);
}

function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** One direction's counter, as the nonce (big-endian in the last 8 bytes) and in the associated data. */
function nonceFor(counter: number): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter));
  return n;
}

export class LinkCryptoError extends Error {}

/**
 * A live session. `seal` and `open` must each be called in message order: the counters are strict, so
 * the relay delivering a message twice, late or not at all ends the session (start a new handshake).
 */
export class Session {
  private sent = 0;
  private received = 0;
  constructor(
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
    /** Transcript hash: identifies the session; never secret. */
    readonly id: Uint8Array,
  ) {}

  async seal(plaintext: string): Promise<Uint8Array> {
    const counter = this.sent++;
    const ad = concat(this.id, nonceFor(counter));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceFor(counter), additionalData: ad as Uint8Array<ArrayBuffer> },
      this.sendKey,
      enc.encode(plaintext),
    );
    return new Uint8Array(ct);
  }

  async open(ciphertext: Uint8Array): Promise<string> {
    const counter = this.received;
    const ad = concat(this.id, nonceFor(counter));
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceFor(counter), additionalData: ad as Uint8Array<ArrayBuffer> },
        this.receiveKey,
        ciphertext as Uint8Array<ArrayBuffer>,
      );
    } catch {
      throw new LinkCryptoError("message did not open (changed, replayed, out of order or wrong key)");
    }
    this.received++;
    return dec.decode(pt);
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeIdentity(id: PublicIdentity): { x: string; kem: string } {
  return { x: toB64(id.x), kem: toB64(id.kem) };
}

export function decodeIdentity(id: { x: string; kem: string }): PublicIdentity {
  const out = { x: fromB64(id.x), kem: fromB64(id.kem) };
  if (out.x.length !== 32 || out.kem.length !== 1184) throw new LinkCryptoError("malformed public identity");
  return out;
}

export function encodeStaticKeys(k: StaticKeys): string {
  return JSON.stringify({
    xs: toB64(k.x.secretKey),
    xp: toB64(k.x.publicKey),
    ks: toB64(k.kem.secretKey),
    kp: toB64(k.kem.publicKey),
  });
}

export function decodeStaticKeys(text: string): StaticKeys {
  const o = JSON.parse(text) as { xs: string; xp: string; ks: string; kp: string };
  return {
    x: { secretKey: fromB64(o.xs), publicKey: fromB64(o.xp) },
    kem: { secretKey: fromB64(o.ks), publicKey: fromB64(o.kp) },
  };
}

export function encodeHello(h: Hello): { ex: string; ekem: string; ct: string } {
  return { ex: toB64(h.ex), ekem: toB64(h.ekem), ct: toB64(h.ct) };
}

export function decodeHello(h: { ex: string; ekem: string; ct: string }): Hello {
  return { ex: fromB64(h.ex), ekem: fromB64(h.ekem), ct: fromB64(h.ct) };
}

export function encodeWelcome(w: Welcome): { ex: string; ce: string; cs: string } {
  return { ex: toB64(w.ex), ce: toB64(w.ctEphemeral), cs: toB64(w.ctStatic) };
}

export function decodeWelcome(w: { ex: string; ce: string; cs: string }): Welcome {
  return { ex: fromB64(w.ex), ctEphemeral: fromB64(w.ce), ctStatic: fromB64(w.cs) };
}

export function utf8(text: string): Uint8Array {
  return enc.encode(text);
}
