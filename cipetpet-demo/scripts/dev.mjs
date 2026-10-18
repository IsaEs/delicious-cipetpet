#!/usr/bin/env node
// npm run dev: builds dist/ (unminified), rebuilds on every change, and serves it with server/server.mjs.
// Reload the page after a rebuild (no hot module replacement: the models would reload anyway).

import { rmSync, watch } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildConfigs, copyHtml } from "./build.mjs";
import { main as serve } from "../server/server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(join(ROOT, "dist"), { recursive: true, force: true });
const { app, worker } = buildConfigs({ dev: true });

/** logs each rebuild */
const reporter = (name) => ({
  name: `report-${name}`,
  setup(b) {
    let t = 0;
    b.onStart(() => {
      t = Date.now();
    });
    b.onEnd((r) => {
      const errors = r.errors.length;
      console.log(errors ? `[dev] ${name}: ${errors} error(s)` : `[dev] ${name} rebuilt in ${Date.now() - t} ms`);
    });
  },
});

const contexts = await Promise.all(
  [
    ["app", app],
    ["worker", worker],
  ]
    .filter(([, cfg]) => cfg)
    .map(([name, cfg]) => esbuild.context({ ...cfg, metafile: false, plugins: [reporter(name)] })),
);
copyHtml();
await Promise.all(contexts.map((c) => c.watch()));
const htmlWatcher = watch(join(ROOT, "src", "index.html"), () => copyHtml());

const server = await serve();

const stop = async () => {
  htmlWatcher.close();
  await Promise.all(contexts.map((c) => c.dispose()));
  await server.close();
  process.exit(0);
};
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
