// Throwaway self-signed certificates for the fake sites served over https (the test browsers run
// with --ignore-certificate-errors). Made once with openssl and kept in the temp directory.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** { key, cert } (PEM) for `hosts` (the first is the subject) and 127.0.0.1. */
export function selfSignedCert(hosts) {
  const dir = join(tmpdir(), `noa-tls-${hosts.join("+")}`);
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    const san = [...hosts.map((h) => `DNS:${h}`), "IP:127.0.0.1"].join(",");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-keyout", key, "-out", cert, "-subj", `/CN=${hosts[0]}`, "-addext", `subjectAltName=${san}`],
      // Git Bash's MSYS would rewrite "/CN=..." as a Windows path.
      { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
    );
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
