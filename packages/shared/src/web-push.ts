/**
 * Web Push from a server with only WebCrypto (the API Worker): the message encryption of RFC 8291 (aes128gcm, RFC
 * 8188) and the VAPID authorization of RFC 8292 (an ES256 JWT). Used for the phone link's notifications
 * (apps/api/src/devices/push.ts), whose payloads say only that something happened.
 */

const enc = new TextEncoder();

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's P-256 public key (uncompressed, 65 bytes), base64url. */
  p256dh: string;
  /** The 16-byte auth secret, base64url. */
  auth: string;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** The request body of one push message: RFC 8291's aes128gcm, a single record. */
export async function encryptPushPayload(sub: PushSubscriptionKeys, payload: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("malformed push subscription keys");
  const asKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // `public` is the parameter's name in WebCrypto (Cloudflare's typings spell it $public; the runtime wants public).
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, asKeys.privateKey, 256));
  // RFC 8291 3.4: IKM from the ECDH secret and the auth secret, bound to both public keys.
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the last-record delimiter 0x02.
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/** A VAPID key pair as stored (JWK of the private key; it holds the public point too). */
export async function generateVapidKey(): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
}

/** The public key browsers subscribe with (applicationServerKey): the uncompressed point, base64url. */
export function vapidPublicKey(jwk: JsonWebKey): string {
  if (!jwk.x || !jwk.y) throw new Error("malformed VAPID key");
  return b64url(concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y)));
}

/** The Authorization header for a push to `endpoint` (RFC 8292): `vapid t=<ES256 JWT>, k=<public key>`. */
export async function vapidAuthorization(jwk: JsonWebKey, endpoint: string, subject: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })));
  // WebCrypto's ECDSA signature is r || s (IEEE P1363), which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${vapidPublicKey(jwk)}`;
}

/** The request to send one push message. TTL: how long the push service keeps it for an offline device. */
export async function pushRequest(jwk: JsonWebKey, subject: string, sub: PushSubscriptionKeys, payload: string, ttlSeconds = 3600): Promise<Request> {
  return new Request(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(jwk, sub.endpoint, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "high",
    },
    body: await encryptPushPayload(sub, payload),
  });
}
