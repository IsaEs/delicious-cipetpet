// prepublishOnly guard: the npm package must carry bin/release-digest.json for its own version, written by
// `npm run release:assets -- --digest bin/release-digest.json` (RELEASES.md, section 8). Without it `cipetpet pull`
// has no trust anchor for the release manifest outside the download.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
try {
  const d = JSON.parse(readFileSync(join(root, "bin/release-digest.json"), "utf8"));
  if (d.format !== 1 || d.version !== version || !/^[0-9a-f]{64}$/.test(d.manifestSha256)) throw new Error(`it is for version ${d.version}, the package is ${version}`);
  console.log(`bin/release-digest.json: release ${d.version}, manifest sha256 ${d.manifestSha256}`);
} catch (e) {
  console.error(`check-digest: bin/release-digest.json is missing or wrong (${e.message}).`);
  console.error("Run: npm run release:assets -- --out release --digest bin/release-digest.json   (see RELEASES.md, section 8)");
  process.exit(1);
}
