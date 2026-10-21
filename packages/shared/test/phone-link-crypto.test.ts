import { describe, expect, it } from "vitest";
import {
  answerHandshake,
  decodeHello,
  decodeIdentity,
  decodeStaticKeys,
  decodeWelcome,
  encodeHello,
  encodeIdentity,
  encodeStaticKeys,
  encodeWelcome,
  finishHandshake,
  fingerprint,
  generateStaticKeys,
  pairingProof,
  publicIdentity,
  randomBytes,
  startHandshake,
  verifyPairingProof,
  LinkCryptoError,
} from "../src/phone-link/crypto.js";

async function pair() {
  const phone = generateStaticKeys();
  const desktop = generateStaticKeys();
  const pending = startHandshake(publicIdentity(desktop));
  const wire = decodeHello(JSON.parse(JSON.stringify(encodeHello(pending.hello))));
  const answered = answerHandshake(desktop, publicIdentity(phone), wire);
  const welcome = decodeWelcome(JSON.parse(JSON.stringify(encodeWelcome(answered.welcome))));
  const phoneSession = await finishHandshake(phone, publicIdentity(desktop), pending, welcome);
  return { phone, desktop, phoneSession, desktopSession: await answered.session };
}

describe("phone link crypto", () => {
  it("both sides derive the same session and messages open in order, both ways", async () => {
    const { phoneSession, desktopSession } = await pair();
    expect(phoneSession.id).toEqual(desktopSession.id);
    for (const text of ["sell my printer", "", "ünïcødé ✓"]) {
      expect(await desktopSession.open(await phoneSession.seal(text))).toBe(text);
      expect(await phoneSession.open(await desktopSession.seal(text + "!"))).toBe(text + "!");
    }
  });

  it("refuses a changed, replayed or reordered message", async () => {
    const { phoneSession, desktopSession } = await pair();
    const a = await phoneSession.seal("allow");
    const b = await phoneSession.seal("second");
    const changed = a.slice();
    changed[0]! ^= 1;
    await expect(desktopSession.open(changed)).rejects.toBeInstanceOf(LinkCryptoError);
    await expect(desktopSession.open(b)).rejects.toBeInstanceOf(LinkCryptoError);
    expect(await desktopSession.open(a)).toBe("allow");
    await expect(desktopSession.open(a)).rejects.toBeInstanceOf(LinkCryptoError);
    expect(await desktopSession.open(b)).toBe("second");
  });

  it("a desktop impostor without the desktop's static keys derives another key", async () => {
    const phone = generateStaticKeys();
    const desktop = generateStaticKeys();
    const impostor = generateStaticKeys();
    const pending = startHandshake(publicIdentity(desktop));
    // The impostor cannot decapsulate the hello's ciphertext with the desktop's key, so ML-KEM's implicit
    // rejection gives it a different secret, and its keys differ.
    const forged = answerHandshake(impostor, publicIdentity(phone), pending.hello);
    const phoneSession = await finishHandshake(phone, publicIdentity(desktop), pending, forged.welcome);
    const forgedSession = await forged.session;
    await expect(phoneSession.open(await forgedSession.seal("type your password"))).rejects.toBeInstanceOf(LinkCryptoError);
  });

  it("a phone impostor cannot talk to the desktop as the paired phone", async () => {
    const phone = generateStaticKeys();
    const desktop = generateStaticKeys();
    const impostor = generateStaticKeys();
    const pending = startHandshake(publicIdentity(desktop));
    const answered = answerHandshake(desktop, publicIdentity(phone), pending.hello);
    const impostorSession = await finishHandshake(impostor, publicIdentity(desktop), pending, answered.welcome);
    await expect((await answered.session).open(await impostorSession.seal("approve"))).rejects.toBeInstanceOf(LinkCryptoError);
  });

  it("pairing proof binds the QR secret, the phone's keys and the desktop", () => {
    const phone = publicIdentity(generateStaticKeys());
    const other = publicIdentity(generateStaticKeys());
    const fp = fingerprint(publicIdentity(generateStaticKeys()));
    const secret = randomBytes(32);
    const proof = pairingProof(secret, phone, fp);
    expect(verifyPairingProof(secret, phone, fp, proof)).toBe(true);
    expect(verifyPairingProof(randomBytes(32), phone, fp, proof)).toBe(false);
    expect(verifyPairingProof(secret, other, fp, proof)).toBe(false);
  });

  it("keys and identities survive encoding", () => {
    const k = generateStaticKeys();
    const back = decodeStaticKeys(encodeStaticKeys(k));
    expect(back).toEqual(k);
    expect(decodeIdentity(encodeIdentity(publicIdentity(k)))).toEqual(publicIdentity(k));
    expect(() => decodeIdentity({ x: "AA", kem: "AA" })).toThrow(LinkCryptoError);
  });
});
