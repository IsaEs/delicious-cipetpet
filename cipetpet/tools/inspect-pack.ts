// Lists the contents of a .cpet pack, verifies its entries and extracts them.
//
//   npx tsx tools/inspect-pack.ts <file.cpet> [--verify] [--extract DIR]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Pack } from "../src/pack/reader.js";
import { formatSize } from "./build-packs.js";

async function main() {
  const args = process.argv.slice(2);
  let file: string | undefined, verify = false, extract: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--verify") verify = true;
    else if (args[i] === "--extract") extract = args[++i];
    else if (!args[i].startsWith("--") && !file) file = args[i];
    else throw new Error(`unknown argument ${args[i]}`);
  }
  if (!file || (extract !== undefined && !extract)) {
    console.error("usage: tsx tools/inspect-pack.ts <file.cpet> [--verify] [--extract DIR]");
    process.exit(2);
  }

  const bytes = new Uint8Array(readFileSync(file));
  // Reading verifies each entry's hash; without --verify, --extract skips that.
  const pack = await Pack.fromBytes(bytes, { verify });
  const h = pack.header;
  const m = h.model;
  console.log(`${basename(file)}  ${formatSize(pack.byteLength)} (${pack.byteLength} bytes)`);
  console.log(`  format     ${h.format} v${h.version}${h.generator ? `, ${h.generator}` : ""}`);
  console.log(`  model      ${m.id} "${m.name}" ${m.version}, ${m.task}, variant ${m.variant}`);
  if (m.license || m.source) console.log(`  license    ${m.license ?? "-"}  ${m.source ?? ""}`);
  if (m.languages) console.log(`  languages  ${m.languages.join(", ")}`);
  if (h.runtime) console.log(`  runtime    onnxruntime ${h.runtime.onnxruntime ?? "-"}`);
  console.log(`  meta       ${JSON.stringify(h.meta)}`);

  const list = pack.list();
  const w = Math.max(5, ...list.map((e) => e.name.length));
  console.log(`\n  ${"entry".padEnd(w)}  ${"type".padEnd(6)}  ${"enc".padEnd(4)}  ${"size".padStart(10)}  ${"stored".padStart(10)}  sha256            tensor`);
  for (const e of list) {
    const tensor = e.type === "tensor" ? `${e.dtype}[${e.shape!.join(", ")}]` : "";
    console.log(
      `  ${e.name.padEnd(w)}  ${e.type.padEnd(6)}  ${e.encoding.padEnd(4)}  ${String(e.size).padStart(10)}  ${String(e.storedSize).padStart(10)}  ${e.sha256.slice(0, 16)}  ${tensor}`,
    );
  }

  if (verify) {
    for (const e of list) await pack.bytes(e.name); // throws on the first mismatch, naming the entry
    console.log(`\n  verified: all ${list.length} entries match their SHA-256`);
  }
  if (extract !== undefined) {
    const out = resolve(extract);
    for (const e of list) {
      const target = resolve(out, e.name);
      if (!target.startsWith(out + "/")) throw new Error(`entry "${e.name}" would be written outside ${out}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, await pack.bytes(e.name));
    }
    writeFileSync(join(out, "header.json"), JSON.stringify(h, null, 2) + "\n");
    console.log(`\n  extracted ${list.length} entries and header.json to ${out}`);
  }
}

main().catch((e) => {
  console.error(`inspect-pack: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
