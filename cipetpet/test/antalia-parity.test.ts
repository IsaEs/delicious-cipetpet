// Fidelity of the Antalia port (ARCHITECTURE.md, "Fidelity rules"): the TypeScript frontend must give
// identical model text, and AntaliaMini bit-identical audio, to the original antalia-mini/js modules.
//
// The originals are plain ES modules and run in Node as they are. The original engine gets ORT's node build
// (`import("onnxruntime-web")`) and the graph files from .upstream; AntaliaMini runs from the built packs on
// the library's own onnxruntime-web/wasm import. So the comparison also covers the pack round trip.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AntaliaMini } from "../src/antalia/index.js";
import * as fe from "../src/antalia/frontend.js";
import { splitModelText } from "../src/antalia/engine.js";
import { Pack } from "../src/pack/reader.js";
import type { SynthesisOptions } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REF_JS = join(ROOT, "../antalia-mini/js");
const UPSTREAM = join(ROOT, ".upstream/antalia-mini");
const PACKS = join(ROOT, "packs");
const PRECISIONS = ["mixed", "int8"] as const;
const EXTRA_PRECISIONS = ["fp32", "fp16"] as const;

const missing = [
  [join(REF_JS, "tts.js"), "the original antalia-mini/js"],
  [join(UPSTREAM, "models/manifest.json"), ".upstream/antalia-mini (real model files)"],
  ...[...PRECISIONS, ...EXTRA_PRECISIONS].map((p) => [join(PACKS, `antalia-mini-${p}.cpet`), `packs/antalia-mini-${p}.cpet (npx tsx tools/build-packs.ts)`]),
].filter(([p]) => !existsSync(p)).map(([, what]) => what);
const skip = missing.length ? `missing ${missing.join(", ")}` : false;

// ------------------------------------------------------------------------------- the original modules
interface RefFrontend {
  toModelText(raw: string): string;
  modelText(raw: string): string;
  cleanModelText(t: string): string;
  encode(t: string): number[];
  turkishLower(t: string): string;
  isEnglish(w: string): boolean;
  looksEnglish(w: string): boolean;
  respell(w: string): string | null;
  respellForeign(t: string): string;
}
interface RefFrontendModule {
  decodeAsset(bytes: Uint8Array | ArrayBuffer): Promise<unknown>;
  createFrontend(data: unknown): RefFrontend;
  numberToWords(n: bigint | number): string;
  cleanModelText(t: string): string;
  encode(t: string): number[];
  turkishLower(t: string): string;
  SYMBOLS: string[];
}
interface RefChunk { audio: Float32Array; index: number; count: number }
interface RefTtsModule {
  PRECISIONS: Record<string, Record<string, string>>;
  Engine: { create(ort: unknown, buffers: Record<string, ArrayBuffer>, manifest: unknown): Promise<unknown> };
  speak(engine: unknown, modelText: string, opts?: Record<string, unknown>): AsyncGenerator<RefChunk>;
  splitModelText(t: string): string[];
}

const silenceWarnings = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};

/** a result or the name of the error, so failures can be compared too */
function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).name };
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function assertSameAudio(actual: Float32Array, expected: Float32Array, label: string): void {
  assert.equal(actual.length, expected.length, `${label}: length`);
  let maxDiff = 0, first = -1;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > maxDiff) maxDiff = d;
    if (first < 0 && !Object.is(actual[i], expected[i])) first = i;
  }
  assert.equal(maxDiff, 0, `${label}: max abs diff ${maxDiff}`);
  // same bits, including -0 / NaN
  assert.ok(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), `${label}: bits differ from sample ${first}`);
}

// ------------------------------------------------------------------------------- fuzz corpus
/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "ev", "Ali", "İzmir", "ışık", "Ağrı", "öğrenci", "çiçek", "Şule", "Ünal", "kitap", "masa", "gelecek", "IŞIK", "İSTANBUL",
  "WhatsApp", "PatientDesk", "Google", "iPhone", "YouTube", "Netflix", "Instagram", "ınstagram", "Nike", "McDonald's",
  "the", "computer", "Microsoft", "hello", "SGK", "THY", "NATO", "TBMM", "ABD", "TV", "OK", "SMS", "COVID", "XIV", "II",
  "III", "Selim", "Dünya", "Dr.", "Prof.", "Doç.", "vb.", "örn.", "Cad.", "Sok.", "No:", "Tel:", "Mah.", "Apt.", "Sn.",
  "vitamini", "D", "A", "B", "C", "E", "O", "Q", "X", "kg", "mg", "km", "cm", "ml", "lt", "TL", "USD", "EUR", "gün", "saat",
  "pH", "H2O", "HbA1c", "Rh+", "mmHg", "km/s", "mg/kg", "m2", "m3", "°C", "&", "#etiket", "**", "→", "•", "😀", "🇹🇷",
  "❤️", "©", "½", "٣", "ﬁ", "Ａ", "â", "kâğıt", "rüzgâr", "e-posta", "Wi-Fi", "camelCase", "eBay", "iOS",
];
const PUNCT = ["", "", " ", " ", " ", ", ", ". ", "? ", "! ", "; ", ": ", "-", "–", "/", "'", "’", " - ", "... ", "\"", "(", ")", "\n", "  "];

function fuzzNumber(r: () => number): string {
  const int = () => String(Math.floor(r() ** 3 * 10 ** (1 + Math.floor(r() * 9))));
  const d2 = () => String(Math.floor(r() * 100)).padStart(2, "0");
  const forms = [
    int,
    () => `${int()},${Math.floor(r() * 1000)}`,
    () => `${int()}.${Math.floor(r() * 100)}`,
    () => Number(int()).toLocaleString("de-DE"),
    () => `${Number(int()).toLocaleString("de-DE")},${d2()}`,
    () => `%${int()}`,
    () => `${int()}%`,
    () => `₺${int()}`,
    () => `$${int()}.${d2()}`,
    () => `${int()} TL`,
    () => `${1 + Math.floor(r() * 31)}.${1 + Math.floor(r() * 13)}.${1900 + Math.floor(r() * 200)}`,
    () => `${1900 + Math.floor(r() * 200)}-${String(1 + Math.floor(r() * 13)).padStart(2, "0")}-${d2()}`,
    () => `${Math.floor(r() * 25)}:${d2()}`,
    () => `${Math.floor(r() * 25)}.${d2()}`,
    () => `${Math.floor(r() * 3)}:${d2()}:${d2()}`,
    () => `0${500 + Math.floor(r() * 99)} ${100 + Math.floor(r() * 899)} ${d2()} ${d2()}`,
    () => `+90 5${d2()} ${100 + Math.floor(r() * 899)} ${d2()} ${d2()}`,
    () => `${int()}-${int()}`,
    () => `${int()}/${int()}`,
    () => `${Math.floor(r() * 10)}/${Math.floor(r() * 12)}`,
    () => `${int()}x${int()}`,
    () => `${int()}'${["de", "da", "te", "ta", "inci", "üncü", "e", "a", "i", "ı", "den", "lık"][Math.floor(r() * 12)]}`,
    () => `${int()}.`,
    () => `-${int()}`,
    () => `0${int()}`,
  ];
  return forms[Math.floor(r() * forms.length)]();
}

function fuzzCorpus(n: number, seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const parts = 1 + Math.floor(r() * 9);
    let s = "";
    for (let i = 0; i < parts; i++) {
      const frag = r() < 0.4 ? fuzzNumber(r) : WORDS[Math.floor(r() * WORDS.length)];
      s += (i ? PUNCT[Math.floor(r() * PUNCT.length)] : "") + (r() < 0.08 ? frag.toUpperCase() : frag);
    }
    if (r() < 0.5) s += [".", "?", "!", "", "..."][Math.floor(r() * 5)];
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------- frontend
describe("frontend parity with antalia-mini/js/frontend.js", { skip }, () => {
  let refMod: RefFrontendModule;
  let ref: RefFrontend;
  let ours: fe.Frontend;
  const corpus: string[] = JSON.parse(readFileSync(join(ROOT, "test/fixtures/antalia/frontend-corpus.json"), "utf8"));

  before(async () => {
    refMod = (await import(pathToFileURL(join(REF_JS, "frontend.js")).href)) as RefFrontendModule;
    ref = refMod.createFrontend(await refMod.decodeAsset(readFileSync(join(UPSTREAM, "assets/frontend-data.json.gz"))));
    ours = await fe.frontendFromPack(await Pack.fromBytes(new Uint8Array(readFileSync(join(PACKS, "antalia-mini-mixed.cpet")))));
  });

  test("decodeAsset reads the gzipped asset and the plain JSON alike, equal to the pack's data", async () => {
    const gz = readFileSync(join(UPSTREAM, "assets/frontend-data.json.gz"));
    const fromGz = await fe.decodeAsset(new Uint8Array(gz));
    assert.deepEqual(fromGz, await refMod.decodeAsset(gz));
    const pack = await Pack.fromBytes(new Uint8Array(readFileSync(join(PACKS, "antalia-mini-int8.cpet"))));
    const plain = await pack.bytes("frontend/data.json");
    assert.deepEqual(await fe.decodeAsset(plain.slice().buffer), fromGz);
    assert.deepEqual(await pack.json("frontend/data.json"), fromGz);
  });

  test(`toModelText / modelText on the corpus (${corpus.length} inputs)`, () => {
    assert.ok(corpus.length >= 200);
    const diffs: string[] = [];
    silenceWarnings(() => {
      for (const s of corpus) {
        const a = outcome(() => ours.toModelText(s)), b = outcome(() => ref.toModelText(s));
        if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`toModelText(${JSON.stringify(s)}): ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
        const c = ours.modelText(s), d = ref.modelText(s);
        if (c !== d) diffs.push(`modelText(${JSON.stringify(s)}): ${JSON.stringify(c)} != ${JSON.stringify(d)}`);
      }
    });
    assert.deepEqual(diffs, []);
  });

  test("toModelText / modelText on 4000 generated inputs", () => {
    const inputs = fuzzCorpus(4000, 20261017);
    const diffs: string[] = [];
    let errors = 0;
    silenceWarnings(() => {
      for (const s of inputs) {
        const a = outcome(() => ours.toModelText(s)), b = outcome(() => ref.toModelText(s));
        if ((b as { error?: string }).error) errors++;
        if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`toModelText(${JSON.stringify(s)}): ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
        const c = ours.modelText(s), d = ref.modelText(s);
        if (c !== d) diffs.push(`modelText(${JSON.stringify(s)}): ${JSON.stringify(c)} != ${JSON.stringify(d)}`);
      }
    });
    assert.deepEqual(diffs.slice(0, 20), []);
    // the generator must not be degenerate: most inputs normalise without the fallback
    assert.ok(errors < inputs.length / 10, `${errors} inputs raised`);
  });

  test("the normaliser's failure path matches (a KeyError on a dotless-ı lexicon term)", () => {
    const s = "ınstagram'da paylaştım";
    assert.deepEqual(outcome(() => ours.toModelText(s)), outcome(() => ref.toModelText(s)));
    silenceWarnings(() => assert.equal(ours.modelText(s), ref.modelText(s)));
  });

  test("numberToWords, cleanModelText, encode, turkishLower, foreign-word helpers", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const n = BigInt(Math.floor(r() * 2 ** 53)) * (r() < 0.3 ? BigInt(Math.floor(r() * 1e6)) : 1n) * (r() < 0.1 ? -1n : 1n);
      assert.deepEqual(outcome(() => fe.numberToWords(n)), outcome(() => refMod.numberToWords(n)), String(n));
    }
    for (const n of [0, 1, 9, 10, 99, 100, 1000, 1001, 10 ** 12 - 1, 10 ** 12]) assert.equal(fe.numberToWords(n), refMod.numberToWords(n));
    const alphabet = "aAıIiİçÇşŞğĞöÖüÜâîû .,?!'-:;–—…’‘`´ \t\n0123456789xyzqXWQé€#@";
    for (let i = 0; i < 2000; i++) {
      const s = Array.from({ length: Math.floor(r() * 40) }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
      assert.equal(fe.cleanModelText(s), refMod.cleanModelText(s));
      assert.deepEqual(fe.encode(s), refMod.encode(s));
      assert.equal(fe.turkishLower(s), refMod.turkishLower(s));
      assert.equal(ours.cleanModelText(s), ref.cleanModelText(s));
    }
    assert.deepEqual(fe.SYMBOLS, refMod.SYMBOLS);
    for (const w of [...WORDS, "PlayStation", "LinkedIn", "XMLHttpRequest", "iPad", "AirPods", "hello", "world", "Ankara", "i", "e"]) {
      assert.equal(ours.isEnglish(w), ref.isEnglish(w), `isEnglish ${w}`);
      assert.equal(ours.looksEnglish(w), ref.looksEnglish(w), `looksEnglish ${w}`);
      assert.deepEqual(outcome(() => ours.respell(w)), outcome(() => ref.respell(w)), `respell ${w}`);
      assert.deepEqual(outcome(() => ours.respellForeign(`${w} ve ${w}'de`)), outcome(() => ref.respellForeign(`${w} ve ${w}'de`)));
    }
  });
});

// ------------------------------------------------------------------------------- audio
const SENTENCES = {
  short: "Merhaba.",
  question: "Yarın akşamki toplantıya gelebilecek misiniz?",
  numbers: "15 Ekim'de PatientDesk üzerinden WhatsApp ile 1.250.000 TL ödendi.",
  // starts with "ö" / "ı" in model text, so the release's spoken prefix ("ee, ") is used and cut away
  prefixO: "Ödemeniz 3 iş günü içinde hesabınıza geçecek.",
  prefixI: "Iğdır'dan İstanbul'a giden uçak 2 saat 15 dakika rötar yaptı.",
  twoSentences: "Randevunuz 21 Ekim Salı günü saat 14:30'da, Dr. Ayşe Yılmaz ile. Lütfen 10 dakika önce gelin.",
  long:
    "Yarın İzmir'de hava parçalı bulutlu olacak; sıcaklık 18 ile 24 derece arasında. Öğleden sonra kuzeyden " +
    "esen rüzgâr saatte 40 kilometreye kadar çıkabilir, bu yüzden denize açılacak olanların dikkatli olması " +
    "gerekiyor. Hafta sonu ise sağanak yağış bekleniyor ve sıcaklıklar mevsim normallerinin altına düşecek. " +
    "Uzmanlar, özellikle yaşlıların ve çocukların sabah saatlerinde kalın giyinmesini, gün içinde bol su " +
    "içmesini ve gereksiz yolculuklardan kaçınmasını öneriyor. Ankara, Konya ve Eskişehir'de ise gece " +
    "saatlerinde don olayı görülebilir; sürücülerin buzlanmaya karşı tedbirli olması gerekiyor.",
};
const SEEDS = [0, 7];
const CUSTOM: { label: string; text: string; opts: SynthesisOptions }[] = [
  { label: "steps 3, speed 1.25, temperature 0.8, cfg 1.5, seed 3", text: SENTENCES.question, opts: { steps: 3, speed: 1.25, temperature: 0.8, cfg: 1.5, seed: 3 } },
  { label: "steps 12, speed 0.8, temperature 0.3, cfg 3, seed 123456789", text: SENTENCES.prefixO, opts: { steps: 12, speed: 0.8, temperature: 0.3, cfg: 3, seed: 123456789 } },
  { label: "temperature 0, steps 1", text: SENTENCES.numbers, opts: { temperature: 0, steps: 1 } },
];

describe("audio parity with antalia-mini/js/tts.js", { skip }, () => {
  let tts: RefTtsModule;
  let refFe: RefFrontend;
  const models = new Map<string, AntaliaMini>();
  const engines = new Map<string, unknown>();

  before(async () => {
    tts = (await import(pathToFileURL(join(REF_JS, "tts.js")).href)) as RefTtsModule;
    const refMod = (await import(pathToFileURL(join(REF_JS, "frontend.js")).href)) as RefFrontendModule;
    refFe = refMod.createFrontend(await refMod.decodeAsset(readFileSync(join(UPSTREAM, "assets/frontend-data.json.gz"))));
    const manifest = JSON.parse(readFileSync(join(UPSTREAM, "models/manifest.json"), "utf8"));
    // ORT's node build, single-threaded (the library's own import is configured by AntaliaMini.load)
    const ortNode = (await import("onnxruntime-web")) as { env: { wasm: { numThreads: number } } };
    ortNode.env.wasm.numThreads = 1;
    for (const p of [...PRECISIONS, ...EXTRA_PRECISIONS]) {
      models.set(p, await AntaliaMini.load(new Uint8Array(readFileSync(join(PACKS, `antalia-mini-${p}.cpet`))), { threads: 1 }));
      const buffers: Record<string, ArrayBuffer> = {};
      for (const k of ["text", "cond", "flow", "vocoder"]) {
        const b = readFileSync(join(UPSTREAM, "models", `${k}${tts.PRECISIONS[p][k]}.onnx`));
        buffers[k] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      }
      engines.set(p, await tts.Engine.create(ortNode, buffers, manifest));
    }
  });

  after(async () => {
    for (const m of models.values()) await m.dispose();
  });

  async function reference(p: string, text: string, opts: SynthesisOptions): Promise<{ chunks: RefChunk[]; audio: Float32Array; modelText: string }> {
    const modelText = silenceWarnings(() => refFe.modelText(text));
    const chunks: RefChunk[] = [];
    for await (const c of tts.speak(engines.get(p), modelText, opts as Record<string, unknown>)) chunks.push(c);
    return { chunks, audio: concat(chunks.map((c) => c.audio)), modelText };
  }

  test("splitModelText matches, and the long text is several chunks with an initial 'ö' / 'ı' chunk", () => {
    for (const s of [...Object.values(SENTENCES), "", "   ", "a. b. c.", "x".repeat(700), "bir, ".repeat(120)]) {
      const mt = silenceWarnings(() => refFe.modelText(s));
      assert.deepEqual(splitModelText(mt), tts.splitModelText(mt));
    }
    const long = refFe.modelText(SENTENCES.long);
    assert.ok(long.length > 300 && tts.splitModelText(long).length >= 3, "long text spans 3+ chunks");
    assert.ok(refFe.modelText(SENTENCES.prefixO).startsWith("ö"));
    assert.ok(refFe.modelText(SENTENCES.prefixI).startsWith("ı"));
  });

  for (const p of PRECISIONS) {
    for (const [name, text] of Object.entries(SENTENCES)) {
      test(`${p}: "${name}" seeds ${SEEDS.join(", ")}: synthesize() == speak() bit for bit`, async () => {
        for (const seed of SEEDS) {
          const expected = await reference(p, text, { seed });
          const got = await models.get(p)!.synthesize(text, { seed });
          assert.equal(got.modelText, expected.modelText);
          assert.equal(got.stats.chunks, expected.chunks.length);
          assertSameAudio(got.audio, expected.audio, `${p} ${name} seed ${seed}`);
        }
      });
    }

    test(`${p}: "long" chunk by chunk via stream()`, async () => {
      const expected = await reference(p, SENTENCES.long, { seed: 7 });
      const got = [];
      for await (const c of models.get(p)!.stream(SENTENCES.long, { seed: 7 })) got.push(c);
      assert.equal(got.length, expected.chunks.length);
      got.forEach((c, i) => {
        assert.equal(c.index, expected.chunks[i].index);
        assert.equal(c.count, expected.chunks[i].count);
        assertSameAudio(c.audio, expected.chunks[i].audio, `${p} long chunk ${i}`);
      });
    });

    for (const { label, text, opts } of CUSTOM) {
      test(`${p}: ${label}`, async () => {
        const expected = await reference(p, text, opts);
        const got = await models.get(p)!.synthesize(text, opts);
        assertSameAudio(got.audio, expected.audio, `${p} ${label}`);
      });
    }
  }

  for (const p of EXTRA_PRECISIONS) {
    test(`${p}: "prefixI" seed 0`, async () => {
      const expected = await reference(p, SENTENCES.prefixI, { seed: 0 });
      assertSameAudio((await models.get(p)!.synthesize(SENTENCES.prefixI, { seed: 0 })).audio, expected.audio, p);
    });
  }

  test("raw: model text in, the same audio as the normalised text", async () => {
    const mt = refFe.modelText(SENTENCES.twoSentences);
    const expected = await reference("mixed", SENTENCES.twoSentences, { seed: 0 });
    const got = await models.get("mixed")!.synthesize(mt, { seed: 0, raw: true });
    assert.equal(got.modelText, mt);
    assertSameAudio(got.audio, expected.audio, "raw");
  });
});
