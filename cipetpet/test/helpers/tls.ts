// A throw-away self-signed certificate for https://localhost tests (needs the openssl binary; callers skip without it).
// Child processes trust it through NODE_EXTRA_CA_CERTS.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TestCert {
  key: string;
  cert: string;
  /** path of the certificate file, for NODE_EXTRA_CA_CERTS */
  certPath: string;
}

export function makeCert(dir: string): TestCert | undefined {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const r = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return undefined;
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), certPath };
}
