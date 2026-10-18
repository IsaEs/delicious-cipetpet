// Attention beam search with CTC rescoring (port of BeamSearch in duyu_small/decode.py, rule for rule):
//
//   * step 0 forces the language token (or, lang = null, lets the decoder pick among the language ids),
//     step 1 forces the <cased> style token, content steps never emit pad / BOS / control tokens;
//   * finished beams absorb </s> at zero cost; the search is bounded by the CTC greedy length;
//   * final ranking: length-normalised (1 - w)·attention + w·CTC score (an unalignable hypothesis is
//     vetoed), then the silence veto and the runaway veto (next clean beam, else the CTC text).
//
// Top-K selection. decode.py picks the K best candidates with
//     top = np.argpartition(-cand, K - 1)[:K];  top = top[np.argsort(-cand[top])]
// and neither call is stable. Exact ties are real here: the masked candidates are all NEG-ish, and at
// step 0 (only beam 0 alive) and step 1 the K - 1 (or K - 3 with lang auto) other beams are filled from
// thousands of candidates that tie at exactly -1e30. Which of them survive decides the token rows of
// those dead beams. To get the same rows as numpy, numpyTopK below is a transcription of numpy's own
// algorithms for this case: introselect (median-of-3 quickselect with a median-of-medians fallback and
// the O(n·kth) "dumb select" for kth < 3, numpy/_core/src/npysort/selection.cpp) followed by numpy's
// argsort quicksort (insertion sort up to 16 elements, heapsort fallback, quicksort.cpp). Those are the
// generic paths numpy runs on non-x86 machines and on x86 without AVX-512/AVX2 dispatch (the reference
// was produced on arm64); test/duyu-parity.test.ts checks the port against numpy on tie-heavy inputs.
// (The dead beams always drop out at step 2, when beam 0's ~2000 finite candidates outrank them, so the
// tie order cannot change a transcript as long as K is far below the vocabulary; matching it anyway keeps
// every intermediate state identical to the reference.)

import { ctcGreedyIds, ctcNll, isRunaway, logSoftmax, NEG, NEG32, runawayBound } from "./ctc.js";

/** special token ids (engine.json) */
export interface Special {
  pad: number;
  bos: number;
  eos: number;
  unk: number;
  /** language name -> id */
  lang: Record<string, number>;
  /** style name -> id */
  style: Record<string, number>;
}

/** language and style ids, sorted and unique (decode.py Special.control) */
export function controlIds(sp: Special): number[] {
  return [...new Set([...Object.values(sp.lang), ...Object.values(sp.style)])].sort((a, b) => a - b);
}

/**
 * Runs the decoder on token rows `tokens` ([K, L] int64, row-major) and returns the logits of the LAST
 * position only, [K, V] float32.
 */
export type RunDecoder = (tokens: BigInt64Array, K: number, L: number) => Promise<Float32Array>;

export interface BeamOptions {
  beam?: number;
  /** language name, or null to detect */
  lang?: string | null;
  style?: string;
  ctcWeight?: number;
  /** length-normalisation exponent */
  alpha?: number;
}

export interface BeamResult {
  /** content token ids (no prefix, no </s>) */
  ids: number[];
  /** language id of the returned hypothesis (the best beam's when a veto applied) */
  lang: number;
}

export class BeamSearch {
  readonly #run: RunDecoder;
  readonly #sp: Special;
  readonly #maxPositions: number;
  readonly #V: number;
  readonly #control: number[];

  constructor(runDecoder: RunDecoder, sp: Special, maxPositions: number, vocabSize: number) {
    this.#run = runDecoder;
    this.#sp = sp;
    this.#maxPositions = maxPositions;
    this.#V = vocabSize;
    this.#control = controlIds(sp);
  }

  /** One utterance: ctcLogp [T, V] float32. */
  async search(ctcLogp: Float32Array, T: number, opts: BeamOptions = {}): Promise<BeamResult> {
    const sp = this.#sp;
    const V = this.#V;
    const K = opts.beam ?? 5;
    const lang = opts.lang === undefined ? "mix" : opts.lang;
    const style = opts.style ?? "cased";
    const ctcWeight = opts.ctcWeight ?? 0.3;
    const alpha = opts.alpha ?? 1.0;
    if (!Number.isInteger(K) || K < 1 || K > V) throw new RangeError(`cipetpet: beam must be an integer in [1, ${V}], got ${K}`);
    if (lang !== null && !(lang in sp.lang)) throw new RangeError(`cipetpet: unknown language "${lang}"`);
    if (!(style in sp.style)) throw new RangeError(`cipetpet: unknown style "${style}"`);

    const ctcSeq = ctcGreedyIds(ctcLogp, T, V, sp.pad);
    let maxLen = Math.min(this.#maxPositions - 4, 8 + Math.floor(T / 3));
    if (ctcWeight > 0) maxLen = Math.min(maxLen, runawayBound(ctcSeq.length));
    const nPrefix = 3;

    // step-0 mask: 0 for the allowed language ids, NEG elsewhere (a float64 array in decode.py)
    const keep = new Float64Array(V).fill(NEG);
    if (lang === null) for (const id of Object.values(sp.lang)) keep[id] = 0;
    else keep[sp.lang[lang]] = 0;
    const styleId = sp.style[style];

    let tokens: number[][] = Array.from({ length: K }, () => [sp.bos]);
    let scores = new Float64Array(K).fill(NEG);
    scores[0] = 0;
    let finished: boolean[] = new Array<boolean>(K).fill(false);

    const lsRow = new Float32Array(V);
    const scratch = new Float32Array(V);
    const lp = new Float64Array(K * V);
    const cand = new Float64Array(K * V);
    for (let t = 0; t < maxLen + nPrefix - 1; t++) {
      const L = t + 1;
      const flat = new BigInt64Array(K * L);
      for (let k = 0; k < K; k++) for (let j = 0; j < L; j++) flat[k * L + j] = BigInt(tokens[k][j]);
      const logits = await this.#run(flat, K, L);
      if (logits.length !== K * V) throw new Error(`cipetpet: decoder returned ${logits.length} logits, expected ${K}x${V}`);

      for (let k = 0; k < K; k++) {
        const row = k * V;
        logSoftmax(logits, row, V, lsRow, 0, scratch);
        if (t === 0) {
          // float32 logp + float64 mask: the result is float64, masked entries keep NEG + logp
          for (let v = 0; v < V; v++) lp[row + v] = lsRow[v] + keep[v];
        } else if (t === 1) {
          // np.full_like(logp, NEG): a float32 array
          lp.fill(NEG32, row, row + V);
          lp[row + styleId] = 0;
        } else {
          for (let v = 0; v < V; v++) lp[row + v] = lsRow[v];
          lp[row + sp.pad] = NEG32;
          lp[row + sp.bos] = NEG32;
          for (const c of this.#control) lp[row + c] = NEG32;
        }
        if (finished[k]) {
          lp.fill(t === 0 ? NEG : NEG32, row, row + V);
          lp[row + sp.eos] = 0;
        }
        const s = scores[k];
        for (let v = 0; v < V; v++) cand[row + v] = s + lp[row + v];
      }

      const top = numpyTopK(cand, K);
      const nextTokens: number[][] = [];
      const nextFinished: boolean[] = [];
      const nextScores = new Float64Array(K);
      for (let i = 0; i < K; i++) {
        const b = Math.floor(top[i] / V);
        const tok = top[i] % V;
        nextTokens.push([...tokens[b], tok]);
        nextFinished.push(finished[b] || tok === sp.eos);
        nextScores[i] = cand[top[i]];
      }
      tokens = nextTokens;
      finished = nextFinished;
      scores = nextScores;
      if (t >= nPrefix && finished.every(Boolean)) break;
    }
    return this.#finalize(tokens, scores, ctcLogp, T, ctcSeq, ctcWeight, alpha, nPrefix);
  }

  #finalize(
    tokens: number[][],
    scores: Float64Array,
    ctcLogp: Float32Array,
    T: number,
    ctcSeq: number[],
    ctcWeight: number,
    alpha: number,
    nPrefix: number,
  ): BeamResult {
    const sp = this.#sp;
    const K = tokens.length;
    const hyps: number[][] = [];
    const lens = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      let seq = tokens[k].slice(nPrefix);
      const e = seq.indexOf(sp.eos);
      if (e >= 0) seq = seq.slice(0, e);
      hyps.push(seq);
      lens[k] = seq.length + 1;
    }
    const total = Float64Array.from(scores);
    if (ctcWeight > 0) {
      for (let k = 0; k < K; k++) {
        const nll = ctcNll(ctcLogp, T, this.#V, hyps[k], sp.pad);
        total[k] = (1 - ctcWeight) * total[k] - ctcWeight * nll;
      }
    }
    for (let k = 0; k < K; k++) total[k] = Number.isFinite(total[k]) ? total[k] / Math.max(lens[k], 1) ** alpha : -Infinity;
    const neg = total.map((v) => -v);
    const order = numpyArgsort(neg);
    const langUsed = tokens[0][1];
    if (ctcWeight > 0) {
      if (ctcSeq.length <= 1 && hyps[order[0]].length > ctcSeq.length + 1) return { ids: [], lang: langUsed }; // silence veto
      for (const j of order) {
        if (Number.isFinite(total[j]) && !isRunaway(hyps[j], ctcSeq.length)) return { ids: hyps[j], lang: tokens[j][1] };
      }
      return { ids: ctcSeq, lang: langUsed }; // every beam loops: the CTC text
    }
    return { ids: hyps[order[0]], lang: tokens[order[0]][1] };
  }
}

// ------------------------------------------------------------------------------ numpy selection / sorting

/** numpy's Tag::less for floats: NaNs sort last */
const less = (a: number, b: number): boolean => a < b || (b !== b && a === a);

function swap(a: Int32Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** floor(log2(n)) for n >= 1, numpy's npy_get_msb */
function msb(n: number): number {
  let d = 0;
  while ((n = Math.floor(n / 2)) > 0) d++;
  return d;
}

/**
 * `np.argpartition(-cand, k - 1)[:k]` reordered by `np.argsort(-cand[top])`, with numpy's exact tie
 * behaviour (see the header comment). Returns flat indices into `cand`.
 */
export function numpyTopK(cand: Float64Array, k: number): Int32Array {
  const n = cand.length;
  if (!(k >= 1 && k <= n)) throw new RangeError(`cipetpet: top-k with k = ${k} of ${n}`);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = -cand[i];
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  introselect(v, idx, 0, n, k - 1);
  const top = idx.slice(0, k);
  const sub = new Float64Array(k);
  for (let i = 0; i < k; i++) sub[i] = -cand[top[i]];
  const order = numpyArgsort(sub);
  const out = new Int32Array(k);
  for (let i = 0; i < k; i++) out[i] = top[order[i]];
  return out;
}

/** `np.argsort(v)` (default kind "quicksort") with numpy's exact order for ties. */
export function numpyArgsort(v: ArrayLike<number>): Int32Array {
  const n = v.length;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  if (n > 1) aquicksort(v, idx, n);
  return idx;
}

// selection.cpp, arg variant: `v` is indexed through `ts`; `off` is where the (sub)array starts in `ts`.

function dumbSelect(v: ArrayLike<number>, ts: Int32Array, off: number, num: number, kth: number): void {
  for (let i = 0; i <= kth; i++) {
    let minidx = i;
    let minval = v[ts[off + i]];
    for (let k = i + 1; k < num; k++) {
      if (less(v[ts[off + k]], minval)) {
        minidx = k;
        minval = v[ts[off + k]];
      }
    }
    swap(ts, off + i, off + minidx);
  }
}

function median3Swap(v: ArrayLike<number>, ts: Int32Array, off: number, low: number, mid: number, high: number): void {
  if (less(v[ts[off + high]], v[ts[off + mid]])) swap(ts, off + high, off + mid);
  if (less(v[ts[off + high]], v[ts[off + low]])) swap(ts, off + high, off + low);
  // move pivot to low
  if (less(v[ts[off + low]], v[ts[off + mid]])) swap(ts, off + low, off + mid);
  // move 3-lowest element to low + 1
  swap(ts, off + mid, off + low + 1);
}

/** index (0..4) of the median of the five elements at ts[off..off+5) */
function median5(v: ArrayLike<number>, ts: Int32Array, off: number): number {
  const at = (i: number) => v[ts[off + i]];
  if (less(at(1), at(0))) swap(ts, off + 1, off);
  if (less(at(4), at(3))) swap(ts, off + 4, off + 3);
  if (less(at(3), at(0))) swap(ts, off + 3, off);
  if (less(at(4), at(1))) swap(ts, off + 4, off + 1);
  if (less(at(2), at(1))) swap(ts, off + 2, off + 1);
  if (less(at(3), at(2))) return less(at(3), at(1)) ? 1 : 3;
  return 2;
}

function medianOfMedian5(v: ArrayLike<number>, ts: Int32Array, off: number, num: number): number {
  const nmed = Math.floor(num / 5);
  for (let i = 0, subleft = 0; i < nmed; i++, subleft += 5) {
    const m = median5(v, ts, off + subleft);
    swap(ts, off + subleft + m, off + i);
  }
  if (nmed > 2) introselect(v, ts, off, nmed, Math.floor(nmed / 2));
  return Math.floor(nmed / 2);
}

function introselect(v: ArrayLike<number>, ts: Int32Array, off: number, num: number, kth: number): void {
  let low = 0;
  let high = num - 1;
  // faster O(n·kth) algorithm for very small kth
  if (kth - low < 3) {
    dumbSelect(v, ts, off + low, high - low + 1, kth - low);
    return;
  }
  if (kth === num - 1) {
    // numpy's shortcut for floating types (finds the max; NaN-aware)
    let maxidx = low;
    let maxval = v[ts[off + low]];
    for (let k = low + 1; k < num; k++) {
      if (!less(v[ts[off + k]], maxval)) {
        maxidx = k;
        maxval = v[ts[off + k]];
      }
    }
    swap(ts, off + kth, off + maxidx);
    return;
  }

  let depthLimit = msb(num) * 2;
  // guarantee three elements
  while (low + 1 < high) {
    let ll = low + 1;
    let hh = high;
    // median of 3 while making progress, else median of medians for a linear worst case
    if (depthLimit > 0 || hh - ll < 5) {
      const mid = low + Math.floor((high - low) / 2);
      median3Swap(v, ts, off, low, mid, high);
    } else {
      const mid = ll + medianOfMedian5(v, ts, off + ll, hh - ll);
      swap(ts, off + mid, off + low);
      // adapt for the larger partition than med3 pivot
      ll--;
      hh++;
    }
    depthLimit--;

    // unguarded partition around the pivot in `low`
    const pivot = v[ts[off + low]];
    for (;;) {
      do ll++;
      while (less(v[ts[off + ll]], pivot));
      do hh--;
      while (less(pivot, v[ts[off + hh]]));
      if (hh < ll) break;
      swap(ts, off + ll, off + hh);
    }
    swap(ts, off + low, off + hh);

    if (hh >= kth) high = hh - 1;
    if (hh <= kth) low = ll;
  }
  // two elements
  if (low + 1 === high && less(v[ts[off + high]], v[ts[off + low]])) swap(ts, off + high, off + low);
}

// quicksort.cpp, aquicksort_ (generic path)

const SMALL_QUICKSORT = 15;

function aquicksort(v: ArrayLike<number>, ts: Int32Array, num: number): void {
  let pl = 0;
  let pr = num - 1;
  const stack: number[] = [];
  const depths: number[] = [];
  let cdepth = msb(num) * 2;
  for (;;) {
    if (cdepth < 0) {
      aheapsort(v, ts, pl, pr - pl + 1);
    } else {
      while (pr - pl > SMALL_QUICKSORT) {
        // quicksort partition, median of 3
        const pm = pl + ((pr - pl) >> 1);
        if (less(v[ts[pm]], v[ts[pl]])) swap(ts, pm, pl);
        if (less(v[ts[pr]], v[ts[pm]])) swap(ts, pr, pm);
        if (less(v[ts[pm]], v[ts[pl]])) swap(ts, pm, pl);
        const vp = v[ts[pm]];
        let pi = pl;
        let pj = pr - 1;
        swap(ts, pm, pj);
        for (;;) {
          do ++pi;
          while (less(v[ts[pi]], vp));
          do --pj;
          while (less(vp, v[ts[pj]]));
          if (pi >= pj) break;
          swap(ts, pi, pj);
        }
        const pk = pr - 1;
        swap(ts, pi, pk);
        // push the larger partition on the stack
        if (pi - pl < pr - pi) {
          stack.push(pi + 1, pr);
          pr = pi - 1;
        } else {
          stack.push(pl, pi - 1);
          pl = pi + 1;
        }
        depths.push(--cdepth);
      }
      // insertion sort (stable)
      for (let pi = pl + 1; pi <= pr; ++pi) {
        const vi = ts[pi];
        const vv = v[vi];
        let pj = pi;
        let pk = pi - 1;
        while (pj > pl && less(vv, v[ts[pk]])) ts[pj--] = ts[pk--];
        ts[pj] = vi;
      }
    }
    if (stack.length === 0) break;
    pr = stack.pop()!;
    pl = stack.pop()!;
    cdepth = depths.pop()!;
  }
}

/** numpy's aheapsort_ on ts[start .. start+n) */
function aheapsort(v: ArrayLike<number>, ts: Int32Array, start: number, n: number): void {
  // 1-based heap indexing: a[i] = ts[start + i - 1]
  const a = (i: number) => ts[start + i - 1];
  const set = (i: number, x: number) => void (ts[start + i - 1] = x);
  let i: number, j: number, tmp: number;
  for (let l = n >> 1; l > 0; --l) {
    tmp = a(l);
    for (i = l, j = l << 1; j <= n; ) {
      if (j < n && less(v[a(j)], v[a(j + 1)])) j += 1;
      if (less(v[tmp], v[a(j)])) {
        set(i, a(j));
        i = j;
        j += j;
      } else break;
    }
    set(i, tmp);
  }
  for (; n > 1; ) {
    tmp = a(n);
    set(n, a(1));
    n -= 1;
    for (i = 1, j = 2; j <= n; ) {
      if (j < n && less(v[a(j)], v[a(j + 1)])) j++;
      if (less(v[tmp], v[a(j)])) {
        set(i, a(j));
        i = j;
        j += j;
      } else break;
    }
    set(i, tmp);
  }
}
