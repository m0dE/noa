/// <reference types="node" />
// The Web Push encryption and VAPID header checked against independent implementations: http_ece (the library the
// web-push package uses) decrypts what encryptPushPayload made, and Node's crypto verifies the VAPID JWT.
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
// @ts-expect-error http_ece has no types
import ece from "http_ece";
import { describe, expect, it } from "vitest";
import { b64url, encryptPushPayload, fromB64url, generateVapidKey, vapidAuthorization, vapidPublicKey } from "../src/web-push.js";

describe("web push", () => {
  it("a payload encryptPushPayload made is opened by http_ece as the browser would (RFC 8291 aes128gcm)", async () => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const auth = randomBytes(16);
    const body = await encryptPushPayload({ endpoint: "https://push.example/x", p256dh: b64url(browser.getPublicKey()), auth: b64url(auth) }, '{"kind":"needs_you"}');
    const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: browser, authSecret: auth });
    expect(plain.toString()).toBe('{"kind":"needs_you"}');
  });

  it("the VAPID header is an ES256 JWT for the endpoint's origin, signed by the key it names", async () => {
    const jwk = await generateVapidKey();
    const header = await vapidAuthorization(jwk, "https://fcm.googleapis.com/fcm/send/abc", "mailto:support@noa.bot", 1_800_000_000);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(vapidPublicKey(jwk));
    expect(fromB64url(k!)).toHaveLength(65);
    const [h, p, s] = jwt!.split(".");
    expect(JSON.parse(Buffer.from(fromB64url(p!)).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 12 * 3600, sub: "mailto:support@noa.bot" });
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64url(s!)))).toBe(true);
  });
});
