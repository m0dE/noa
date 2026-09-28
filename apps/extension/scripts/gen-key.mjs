// Generates (once) the RSA key that pins the extension ID.
// - key.pem (private, gitignored) is created only when missing, or with --force.
// - static/manifest.json "key" gets the base64 SPKI public key.
// - extension-id.txt gets the derived extension ID.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pemPath = join(root, "key.pem");
const manifestPath = join(root, "static", "manifest.json");
const idPath = join(root, "extension-id.txt");
const force = process.argv.includes("--force");

let privateKey;
if (existsSync(pemPath) && !force) {
  privateKey = createPrivateKey(readFileSync(pemPath, "utf8"));
} else {
  ({ privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }));
  writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }));
}

const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const id = extensionIdFromDer(der);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.key = der.toString("base64");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(idPath, id + "\n");
console.log(`extension id: ${id}`);

/** Chrome's ID: first 32 hex chars of sha256(SPKI DER), 0-f mapped to a-p. */
export function extensionIdFromDer(buf) {
  const hex = createHash("sha256").update(buf).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
