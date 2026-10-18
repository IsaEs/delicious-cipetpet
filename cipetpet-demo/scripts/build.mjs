#!/usr/bin/env node
// Bundles the demo with esbuild into dist/:
//
//   dist/index.html
//   dist/assets/app.js, app.css, chunks/*      the app (ORT's builds are split out as lazily loaded chunks)
//   dist/assets/cipetpet-worker.js             the core's model worker, when the core ships one
//
// "cipetpet" and "cipetpet-react" are aliased to the sibling packages' TypeScript SOURCES
// (../cipetpet/src/index.ts, ../cipetpet-react/src/index.ts), so the demo builds before those packages
// publish a dist/. When a source entry is missing, the package's built dist is used instead, if present.
// React is pinned to this package's copy, so cipetpet-react (which has its own node_modules) shares it.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const CORE = resolve(ROOT, "..", "cipetpet");
const REACT_PKG = resolve(ROOT, "..", "cipetpet-react");
export const WORKER_PUBLIC_PATH = "/assets/cipetpet-worker.js";

function pick(name, candidates) {
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `cannot resolve "${name}": none of\n${candidates.map((c) => `  ${c}`).join("\n")}\nexists. Is the sibling package checked out (and, for a dist, built)?`,
    );
  }
  return found;
}

export function resolveAliases() {
  return {
    cipetpet: pick("cipetpet", [join(CORE, "src", "index.ts"), join(CORE, "dist", "esm", "index.js")]),
    "cipetpet-react": pick("cipetpet-react", [join(REACT_PKG, "src", "index.ts"), join(REACT_PKG, "dist", "index.js")]),
    react: join(ROOT, "node_modules", "react"),
    "react-dom": join(ROOT, "node_modules", "react-dom"),
  };
}

/** the core's worker entry (source, else built), or null when the core has none */
export function workerEntry() {
  return [join(CORE, "src", "worker", "worker.ts"), join(CORE, "dist", "esm", "worker", "worker.js")].find((p) => existsSync(p)) ?? null;
}

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/** @param {{ dev?: boolean }} opts */
export function buildConfigs({ dev = false } = {}) {
  const alias = resolveAliases();
  const worker = workerEntry();
  const common = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022", "chrome110", "firefox115", "safari16.4"],
    alias,
    minify: !dev,
    sourcemap: "linked",
    legalComments: dev ? "inline" : "linked",
    logLevel: "warning",
    define: {
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
      __CIPETPET_WORKER_URL__: worker ? JSON.stringify(WORKER_PUBLIC_PATH) : "null",
      __DEMO_VERSION__: JSON.stringify(version),
    },
    // onnxruntime-web references Node modules behind runtime checks; they are never loaded in the browser
    external: ["node:*", "fs", "path", "url", "worker_threads", "module", "crypto"],
  };
  /** @type {import("esbuild").BuildOptions} */
  const app = {
    ...common,
    entryPoints: { app: join(ROOT, "src", "main.tsx") },
    outdir: join(DIST, "assets"),
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    jsx: "automatic",
    loader: { ".svg": "file", ".png": "file", ".woff2": "file" },
    metafile: true,
  };
  /** @type {import("esbuild").BuildOptions | null} */
  const workerBuild = worker
    ? {
        ...common,
        entryPoints: { "cipetpet-worker": worker },
        outdir: join(DIST, "assets"),
        splitting: false,
      }
    : null;
  return { app, worker: workerBuild, alias };
}

export function copyHtml() {
  mkdirSync(DIST, { recursive: true });
  cpSync(join(ROOT, "src", "index.html"), join(DIST, "index.html"));
}

export async function build({ dev = false } = {}) {
  rmSync(DIST, { recursive: true, force: true });
  const { app, worker, alias } = buildConfigs({ dev });
  const started = Date.now();
  const [result] = await Promise.all([esbuild.build(app), worker ? esbuild.build(worker) : Promise.resolve(null)]);
  copyHtml();
  const outputs = Object.entries(result.metafile?.outputs ?? {})
    .filter(([f]) => !f.endsWith(".map"))
    .map(([f, o]) => `  ${f.slice(ROOT.length + 1)}  ${(o.bytes / 1024).toFixed(0)} KB`);
  console.log(`built dist/ in ${Date.now() - started} ms`);
  console.log(`  cipetpet       -> ${alias.cipetpet.slice(resolve(ROOT, "..").length + 1)}`);
  console.log(`  cipetpet-react -> ${alias["cipetpet-react"].slice(resolve(ROOT, "..").length + 1)}`);
  console.log(`  core worker    -> ${worker ? WORKER_PUBLIC_PATH : "(none: the core has no worker entry yet; the 'use worker' setting is disabled)"}`);
  console.log(outputs.join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  build({ dev: process.argv.includes("--dev") }).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
