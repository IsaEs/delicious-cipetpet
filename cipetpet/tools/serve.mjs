import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, sep, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirnameOf(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wav": "audio/wav",
  ".cpet": "application/octet-stream",
};

function dirnameOf(path) {
  const slash = path.lastIndexOf("/");
  return path.slice(0, slash);
}

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  let file = resolve(projectRoot, `.${pathname}`);
  if (file !== projectRoot && !file.startsWith(`${projectRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`cipetpet demo server: http://127.0.0.1:${port}/cipetpet-react/example/`);
  console.log("Cross-origin isolation enabled for threaded WebAssembly.");
});
