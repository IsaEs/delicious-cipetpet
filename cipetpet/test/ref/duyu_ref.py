"""Reference dumps for test/duyu-parity.test.ts, produced by the PYTHON Duyu-small engine.

    PYTHONPATH=../Duyu-small $REFVENV/bin/python test/ref/duyu_ref.py [--model-dir .upstream/duyu-small] [--out test/fixtures/duyu]

Writes into --out:
  reference.json   transcripts (token ids per chunk, chunk bounds, language, text) for every input x quant
                   x mode, plus tokenizer / top-k / argsort / log_softmax / ctc_nll / fbank checks
  *.f32            float32 little-endian arrays referenced from reference.json (fbank features, CTC log-probs)

Inputs: test/fixtures/audio/clip01..08.wav, "long" (clips 1..8 twice with 1 s of silence between them,
~66 s: three chunks) and "silence" (0.5 s of zeros). Modes: beam 5 lang mix, beam 5 lang auto, beam 1
lang tr, ctc. The engine runs single-threaded on the CPU provider. Each transcript is rebuilt from the
engine's own pieces (chunks, encode, search, decode_ids) to get the token ids, and checked against
DuyuSmall.transcribe() on the same input.

    ... duyu_ref.py --replay DIR

writes the Python engine's own numbers instead (large, so test/duyu-parity.test.ts generates them into a
temporary directory when the venv is available): per quant and input, the CTC log-probs of every chunk
and, per beam mode, every decoder call (the token rows and the last-position logits it returned) plus the
result. The TS beam search replays them to show that, given the same numbers, it takes the same steps.
It also writes encoder_post's output for one fixed input at ORT CPU optimisation levels BASIC and ALL
(the int8 graphs differ there: level EXTENDED+ fuses DynamicQuantizeLinear + MatMulInteger).
"""

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime
import sentencepiece

from duyu_small import DuyuSmall
from duyu_small.audio import SAMPLE_RATE, chunks, load_audio
from duyu_small.decode import NEG, ctc_greedy_ids, ctc_nll, log_softmax
from duyu_small.features import Fbank
from duyu_small.model import TAIL_PAD_S

ROOT = Path(__file__).resolve().parents[2]
AUDIO = ROOT / "test/fixtures/audio"
CLIPS = [f"clip{i:02d}" for i in range(1, 9)]
MODES = [  # name, mode, beam, lang (None = auto)
    ("beam5-mix", "auto", 5, "mix"),
    ("beam5-auto", "auto", 5, None),
    ("beam1-tr", "auto", 1, "tr"),
    ("ctc", "ctc", 5, "mix"),
]


def lcg(seed):
    """32-bit LCG shared with the TS test (Numerical Recipes constants)."""
    s = seed & 0xFFFFFFFF
    while True:
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        yield s


def inputs():
    clips = {c: load_audio(AUDIO / f"{c}.wav") for c in CLIPS}
    gap = np.zeros(SAMPLE_RATE, np.float32)
    parts = []
    for c in CLIPS + CLIPS:
        if parts:
            parts.append(gap)
        parts.append(clips[c])
    out = dict(clips)
    out["long"] = np.concatenate(parts)
    out["silence"] = np.zeros(SAMPLE_RATE // 2, np.float32)
    return out


def write_f32(out: Path, name: str, a: np.ndarray) -> dict:
    a = np.ascontiguousarray(a, dtype="<f4")
    (out / name).write_bytes(a.tobytes())
    return {"file": name, "shape": list(a.shape)}


def transcripts(model_dir: Path, wavs: dict) -> list:
    cases = []
    for quant in ("int8", "q4"):
        m = DuyuSmall(model_dir, quant=quant, threads=1)
        for name, wav in wavs.items():
            parts = chunks(wav)
            bounds, s = [], 0
            for p in parts:
                bounds.append([s, s + len(p)])
                s += len(p)
            encoded = []
            for p in parts:
                x = np.concatenate([p, np.zeros(int(TAIL_PAD_S * SAMPLE_RATE), np.float32)])
                encoded.append(m.encode(x))
            for mode_name, mode, beam, lang in MODES:
                segs = []
                for (start, end), (h, logp) in zip(bounds, encoded):
                    if mode == "ctc":
                        ids, lang_id = ctc_greedy_ids(logp, m.sp.pad), None
                    else:
                        ids, lang_id = m.search(h, logp, beam=beam, lang=lang, ctc_weight=m.ctc_weight)
                    segs.append({"start": start, "end": end, "ids": [int(i) for i in ids], "lang": lang_id,
                                 "text": m.decode_ids(ids)})
                text = " ".join(sg["text"] for sg in segs if sg["text"])
                direct = m.transcribe(wav, mode=mode, lang=lang, beam=beam)
                if direct != text:
                    raise SystemExit(f"rebuilt transcript differs from transcribe(): {quant} {name} {mode_name}: {text!r} vs {direct!r}")
                cases.append({"quant": quant, "input": name, "mode": mode_name, "text": text, "segments": segs})
                print(f"{quant:4} {name:8} {mode_name:10} {text}", file=sys.stderr)
    return cases


def tokenizer_cases(model_dir: Path) -> list:
    m = DuyuSmall(model_dir, quant="int8", threads=1)
    sp = sentencepiece.SentencePieceProcessor(model_file=str(model_dir / "spm.model"))
    V = sp.get_piece_size()
    rng = np.random.RandomState(1234)
    seqs = []
    for _ in range(300):                                    # anything in the vocabulary
        seqs.append(rng.randint(0, V, size=rng.randint(1, 25)).tolist())
    for _ in range(300):                                    # byte-heavy: valid and broken UTF-8
        seq = []
        for _ in range(rng.randint(1, 16)):
            r = rng.rand()
            if r < 0.55:
                seq.append(int(rng.randint(9, 265)))
            elif r < 0.7:
                seq.append(int(9 + rng.choice([0xC3, 0xC4, 0xC5, 0xE2, 0xF0])))
            elif r < 0.85:
                seq.append(int(9 + rng.randint(0x80, 0xC0)))
            else:
                seq.append(int(rng.randint(265, V)))
        seqs.append(seq)
    texts = [line.split("\t")[2] for line in (AUDIO / "manifest.tsv").read_text().splitlines() if line.strip()]
    texts += ["Merhaba 😀 dünya", "naïve café — ½ €", "你好, İstanbul!", "ÇĞİÖŞÜ çğıöşü", "  boşluklar  ", "a﻿b"]
    for t in texts:
        ids = sp.encode(t)
        seqs += [ids, [4, 7] + ids, [1] + ids, [9 + 0x41] + ids, ids + [3, 0], [0, 2] + ids, [1928] + ids + [1928]]
    seqs += [[1928], [1928, 266], [266], [266, 266], [9 + 0xE2, 9 + 0x82], [9 + 0xE2, 9 + 0x82, 9 + 0xAC], [9 + 0xEF, 9 + 0xBF, 9 + 0xBD],
             [9 + 0xF0, 9 + 0x9F, 9 + 0x98], [9 + 0xED, 9 + 0xA0, 9 + 0x80], [9 + 0xC0, 9 + 0x80], [9 + 0xF4, 9 + 0x90, 9 + 0x80, 9 + 0x80]]
    out = []
    for ids in seqs:
        ids = [int(i) for i in ids]
        out.append({"ids": ids, "decode": sp.decode(ids), "text": m.decode_ids(ids)})
    return out


def gen_cand(seed: int, K: int, V: int, kind: str) -> np.ndarray:
    g = lcg(seed)
    n = K * V
    if kind in ("step0", "step0auto", "step1"):
        scores = np.full(K, NEG)
        scores[0] = 0.0
        if kind == "step1":
            alive = 3 if K > 3 else 1
            for k in range(alive):
                scores[k] = -float(next(g) >> 8) / 2**24 * 3
        logp = np.array([-float(next(g) >> 8) / 2**24 * 20 for _ in range(n)]).astype(np.float32).reshape(K, V)
        if kind == "step1":
            forced = np.full_like(logp, NEG)
            forced[:, 7] = 0.0
            lp = forced
        else:
            keep = np.full(V, NEG)
            keep[[4, 5, 6] if kind == "step0auto" else [6]] = 0.0
            lp = logp + keep
        return (scores[:, None] + lp).reshape(-1)
    out = np.empty(n)
    for i in range(n):
        s = next(g)
        if kind == "ties":
            out[i] = -float(s % 7)
        elif kind == "few":
            out[i] = -float(s % 3) * 0.5
        elif kind == "neg":
            out[i] = NEG if s % 10 else -float(s % 1000) / 8
        elif kind == "mixed":
            r = s % 4
            out[i] = (NEG, 2 * NEG, -float(s >> 8) / 2**24, -1.0)[r]
        else:
            raise ValueError(kind)
    return out


def topk_cases() -> list:
    out = []
    seed = 1
    for V in (2048, 50, 7):
        for K in (1, 2, 3, 4, 5, 8, 16, 17, 20, 33):
            if V == 7 and K > 20:
                continue
            for kind in ("ties", "few", "neg", "mixed", "step0", "step0auto", "step1"):
                if kind.startswith("step") and V < 8:
                    continue
                cand = gen_cand(seed, K, V, kind)
                top = np.argpartition(-cand, K - 1)[:K]
                top = top[np.argsort(-cand[top])]
                out.append({"seed": seed, "K": K, "V": V, "kind": kind, "top": top.tolist()})
                seed += 1
    return out


def argsort_cases() -> list:
    out = []
    for n in list(range(1, 40)) + [64, 100, 257]:
        for mod in (2, 5, 1000):
            g = lcg(n * 7919 + mod)
            v = np.array([-float(next(g) % mod) for _ in range(n)])
            out.append({"seed": n * 7919 + mod, "n": n, "mod": mod, "order": np.argsort(v).tolist()})
    return out


def logsoftmax_case() -> dict:
    g = lcg(4242)
    logits = np.array([float(next(g) >> 8) / 2**24 * 30 - 15 for _ in range(5 * 2048)]).astype(np.float32).reshape(5, 2048)
    ls = log_softmax(logits)
    assert ls.dtype == np.float32
    return {"seed": 4242, "rows": 5, "cols": 2048, "bits": base64.b64encode(ls.astype("<f4").tobytes()).decode()}


class Blob:
    """float32 / int32 arrays appended to one little-endian binary file; offsets in 4-byte words"""

    def __init__(self):
        self.parts, self.words = [], 0

    def add(self, a: np.ndarray) -> int:
        a = np.ascontiguousarray(a, dtype="<i4" if a.dtype.kind in "iu" else "<f4")
        off = self.words
        self.parts.append(a.tobytes())
        self.words += a.size
        return off

    def write(self, path: Path):
        path.write_bytes(b"".join(self.parts))


def replay(model_dir: Path, wavs: dict, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    for quant in ("int8", "q4"):
        m = DuyuSmall(model_dir, quant=quant, threads=1)
        record = []
        inner = m.search.run_decoder

        def recorder(tokens, h):
            logits = inner(tokens, h)
            record.append((tokens.copy(), logits[:, -1].astype(np.float32)))
            return logits

        m.search.run_decoder = recorder
        for name, wav in wavs.items():
            blob = Blob()
            parts = chunks(wav)
            index = {"chunks": [], "modes": {}}
            encoded, s = [], 0
            for p in parts:
                x = np.concatenate([p, np.zeros(int(TAIL_PAD_S * SAMPLE_RATE), np.float32)])
                h, logp = m.encode(x)
                encoded.append((h, logp))
                index["chunks"].append({"start": s, "end": s + len(p), "T": logp.shape[0], "V": logp.shape[1], "logp": blob.add(logp)})
                s += len(p)
            for mode_name, mode, beam, lang in MODES:
                if mode == "ctc":
                    continue
                segs = []
                for h, logp in encoded:
                    record.clear()
                    ids, lang_id = m.search(h, logp, beam=beam, lang=lang, ctc_weight=m.ctc_weight)
                    steps = [{"K": int(t.shape[0]), "L": int(t.shape[1]), "tokens": blob.add(t), "logits": blob.add(lg)} for t, lg in record]
                    segs.append({"ids": [int(i) for i in ids], "lang": int(lang_id), "text": m.decode_ids(ids), "steps": steps})
                index["modes"][mode_name] = {"beam": beam, "lang": lang, "chunks": segs}
            blob.write(out / f"{quant}-{name}.bin")
            (out / f"{quant}-{name}.json").write_text(json.dumps(index))
            print(f"replay {quant} {name}: {blob.words * 4 / 1e6:.1f} MB", file=sys.stderr)

        # the encoder chain: every graph call (input and output) of encode() on two clips
        class Recorder:
            def __init__(self, sess, graph, calls):
                self.sess, self.graph, self.calls = sess, graph, calls

            def run(self, names, feed):
                out = self.sess.run(names, feed)
                (x,) = feed.values()
                self.calls.append((self.graph, x, out[0]))
                return out

        sessions = (m.pre, m.pas, m.post)
        for name in ("clip01", "clip05"):
            calls = []
            m.pre, m.pas, m.post = (Recorder(sv, g, calls) for sv, g in zip(sessions, ("pre", "pass", "post")))
            h, logp = m.encode(np.concatenate([wavs[name], np.zeros(int(TAIL_PAD_S * SAMPLE_RATE), np.float32)]))
            m.pre, m.pas, m.post = sessions
            blob = Blob()
            index = {"calls": [{"graph": g, "in": blob.add(x), "inShape": list(x.shape), "out": blob.add(y), "outShape": list(y.shape)} for g, x, y in calls],
                     "h": blob.add(h), "hShape": list(h.shape), "logp": blob.add(logp), "logpShape": list(logp.shape)}
            blob.write(out / f"{quant}-encoder-{name}.bin")
            (out / f"{quant}-encoder-{name}.json").write_text(json.dumps(index))

        # encoder_post on one fixed input (the int8 one is where CPU graph fusion changes the numbers)
        h, _ = m.encode(np.concatenate([wavs["clip01"], np.zeros(int(TAIL_PAD_S * SAMPLE_RATE), np.float32)]))
        blob, index = Blob(), {"shape": list(h.shape), "x": 0}
        blob.add(h)
        for lvl in ("BASIC", "ALL"):
            so = onnxruntime.SessionOptions()
            so.intra_op_num_threads = 1
            so.log_severity_level = 3
            so.graph_optimization_level = getattr(onnxruntime.GraphOptimizationLevel, f"ORT_ENABLE_{lvl}")
            sess = onnxruntime.InferenceSession(str(model_dir / quant / "encoder_post.onnx"), so, providers=["CPUExecutionProvider"])
            index[lvl] = blob.add(sess.run(None, {"x": h})[0])
        index["outShape"] = [1, h.shape[1], 2048]
        blob.write(out / f"{quant}-post.bin")
        (out / f"{quant}-post.json").write_text(json.dumps(index))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=str(ROOT / ".upstream/duyu-small"))
    ap.add_argument("--out", default=str(ROOT / "test/fixtures/duyu"))
    ap.add_argument("--skip-transcripts", action="store_true")
    ap.add_argument("--replay", help="write the replay data into this directory instead")
    args = ap.parse_args()
    model_dir, out = Path(args.model_dir), Path(args.out)
    wavs = inputs()
    if args.replay:
        replay(model_dir, wavs, Path(args.replay))
        return
    out.mkdir(parents=True, exist_ok=True)

    ref = {
        "generator": "test/ref/duyu_ref.py",
        "versions": {"numpy": np.__version__, "onnxruntime": onnxruntime.__version__, "sentencepiece": sentencepiece.__version__},
        "threads": 1,
        "modes": [{"name": n, "mode": md, "beam": b, "lang": l} for n, md, b, l in MODES],
        "inputs": {k: len(v) for k, v in wavs.items()},
    }

    fb = Fbank(model_dir / "fbank.npz")
    g = lcg(777)
    noise = np.array([(float(next(g) >> 8) / 2**24 * 2 - 1) * 0.1 for _ in range(700)]).astype(np.float32)
    ref["fbank"] = {}
    for name, wav in (("clip01", wavs["clip01"]), ("clip05", wavs["clip05"]), ("noise700", noise), ("noise300", noise[:300])):
        ref["fbank"][name] = write_f32(out, f"fbank_{name}.f32", fb(wav))
    ref["fbank_noise_seed"] = 777

    m = DuyuSmall(model_dir, quant="int8", threads=1)
    ref["ctc"] = {}
    for name in ("clip01", "clip05"):
        x = np.concatenate([wavs[name], np.zeros(int(TAIL_PAD_S * SAMPLE_RATE), np.float32)])
        _, logp = m.encode(x)
        entry = write_f32(out, f"ctc_int8_{name}.f32", logp)
        greedy = ctc_greedy_ids(logp, m.sp.pad)
        seqs = [greedy, [], greedy[:-1], greedy[1:], greedy + greedy[:3], [greedy[0]] * (logp.shape[0] // 2 + 1), [7] * logp.shape[0]]
        entry["greedy"] = [int(i) for i in greedy]
        # +inf (unalignable) is stored as null: JSON has no infinity
        entry["nll"] = []
        for s in seqs:
            v = ctc_nll(logp, s, m.sp.pad)
            entry["nll"].append({"seq": [int(i) for i in s], "nll": v if np.isfinite(v) else None})
        ref["ctc"][name] = entry
    del m

    ref["tokenizer"] = tokenizer_cases(model_dir)
    ref["topk"] = topk_cases()
    ref["argsort"] = argsort_cases()
    ref["logsoftmax"] = logsoftmax_case()
    if not args.skip_transcripts:
        ref["cases"] = transcripts(model_dir, wavs)
    else:
        old = out / "reference.json"
        ref["cases"] = json.loads(old.read_text())["cases"] if old.exists() else []

    text = json.dumps(ref, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    (out / "reference.json").write_text(text)
    print(f"wrote {out / 'reference.json'} ({len(text)} bytes, {len(ref['cases'])} transcripts)", file=sys.stderr)


if __name__ == "__main__":
    main()
