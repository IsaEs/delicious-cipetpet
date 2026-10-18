// Builds dist/: tsc emits ESM + .d.ts (tsconfig.build.json), then the entry gets its "use client" banner.
// tsc keeps the directive prologue of src/index.ts already; this makes sure of it (a bundler-less
// React Server Components app reads the directive from dist/index.js).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
// The declarations are emitted against the built core's types. Refuse to build (and so to publish) against
// anything else: a stale stand-in could ship types that were never checked against the real core.
if (!existsSync(join(root, "node_modules/cipetpet/dist/types/index.d.ts"))) {
  console.error('cipetpet-react: the core is not built; run "npm run build" in ../cipetpet first (node_modules/cipetpet/dist/types/index.d.ts is missing)');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const res = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

const BANNER = '"use client";';
const entry = join(dist, "index.js");
const js = readFileSync(entry, "utf8");
if (!/^\s*["']use client["'];?/.test(js)) writeFileSync(entry, `${BANNER}\n${js}`);
console.log("cipetpet-react: built dist/");
