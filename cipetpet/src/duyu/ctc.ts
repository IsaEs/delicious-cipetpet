// CTC helpers and decoding guards (port of the CTC half of duyu_small/decode.py).
//
// decode.py does its math in numpy with mixed dtypes, and the final beam ranking is sensitive to exact
// values, so this file reproduces numpy's arithmetic where the dtype is float32:
//   * log_softmax of the float32 decoder logits stays float32 in numpy (subtract, exp, sum, log), and
//     numpy sums a float32 row pairwise (pairwise_sum, 8 accumulators, blocks of 128), so do we;
//   * the CTC forward algorithm mixes float32 emissions into float64 alphas, i.e. float64 math;
//   * -logp[:, blank].sum() (the score of an empty hypothesis) is a float32 pairwise sum.
// Every float32 operation is a float64 operation followed by Math.fround, which is exact for + - * /
// (double has more than 2·24+2 bits). exp/log go through float64 and then round, so they can differ
// from the C library's expf/logf in the last bit in rare cases.

/** the "minus infinity" decode.py masks with (a finite number, so sums stay finite and comparable) */
export const NEG = -1e30;
/** NEG after numpy stored it in a float32 array */
export const NEG32 = Math.fround(NEG);

// runaway / silence guards (train/asr/decode.py constants)
export const MAX_REPEAT_RUN = 6;
export const RUNAWAY_RATIO = 1.5;
export const RUNAWAY_SLACK = 10;
export const RUNAWAY_SLACK_SHORT = 4;
export const RUNAWAY_SHORT = 8;

const f32 = Math.fround;

/** numpy's float32 pairwise summation of a[off], a[off + stride], … (n values). */
export function pairwiseSumF32(a: ArrayLike<number>, off: number, n: number, stride = 1): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res = f32(res + a[off + i * stride]);
    return res;
  }
  if (n <= 128) {
    let r0 = a[off], r1 = a[off + stride], r2 = a[off + 2 * stride], r3 = a[off + 3 * stride];
    let r4 = a[off + 4 * stride], r5 = a[off + 5 * stride], r6 = a[off + 6 * stride], r7 = a[off + 7 * stride];
    let i = 8;
    for (const end = n - (n % 8); i < end; i += 8) {
      const p = off + i * stride;
      r0 = f32(r0 + a[p]);
      r1 = f32(r1 + a[p + stride]);
      r2 = f32(r2 + a[p + 2 * stride]);
      r3 = f32(r3 + a[p + 3 * stride]);
      r4 = f32(r4 + a[p + 4 * stride]);
      r5 = f32(r5 + a[p + 5 * stride]);
      r6 = f32(r6 + a[p + 6 * stride]);
      r7 = f32(r7 + a[p + 7 * stride]);
    }
    let res = f32(f32(f32(r0 + r1) + f32(r2 + r3)) + f32(f32(r4 + r5) + f32(r6 + r7)));
    for (; i < n; i++) res = f32(res + a[off + i * stride]);
    return res;
  }
  let n2 = n >> 1;
  n2 -= n2 % 8;
  return f32(pairwiseSumF32(a, off, n2, stride) + pairwiseSumF32(a, off + n2 * stride, n - n2, stride));
}

/**
 * log_softmax of one float32 row x[off .. off+n) into out[outOff ..], with numpy's float32 arithmetic:
 * m = max, y = x - m, y - log(sum(exp(y))).
 */
export function logSoftmax(x: Float32Array, off: number, n: number, out: Float32Array, outOff = 0, scratch?: Float32Array): void {
  let m = -Infinity;
  for (let i = 0; i < n; i++) if (x[off + i] > m) m = x[off + i];
  const e = scratch && scratch.length >= n ? scratch : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = f32(x[off + i] - m);
    out[outOff + i] = y;
    e[i] = Math.exp(y); // Float32Array store rounds
  }
  const ls = f32(Math.log(pairwiseSumF32(e, 0, n)));
  for (let i = 0; i < n; i++) out[outOff + i] = out[outOff + i] - ls;
}

/** logp [T, V] -> argmax per frame, repeats collapsed, blanks dropped. Ties go to the lowest id, like argmax. */
export function ctcGreedyIds(logp: Float32Array, T: number, V: number, blank: number): number[] {
  const out: number[] = [];
  let prev = -1;
  for (let t = 0; t < T; t++) {
    const row = t * V;
    let best = 0;
    let bv = logp[row];
    for (let v = 1; v < V; v++) {
      if (logp[row + v] > bv) {
        bv = logp[row + v];
        best = v;
      }
    }
    if (best !== prev && best !== blank) out.push(best);
    prev = best;
  }
  return out;
}

export function runawayBound(ctcLen: number): number {
  const slack = ctcLen < RUNAWAY_SHORT ? RUNAWAY_SLACK_SHORT : RUNAWAY_SLACK;
  return Math.trunc(RUNAWAY_RATIO * ctcLen + slack);
}

/** A hypothesis far longer than the CTC path, or with an n-gram (n <= 4) repeated MAX_REPEAT_RUN times in a row. */
export function isRunaway(seq: readonly number[], ctcLen: number): boolean {
  if (seq.length > runawayBound(ctcLen)) return true;
  for (let n = 1; n <= 4; n++) {
    let run = 1;
    for (let i = n; i < seq.length - n + 1; i += n) {
      let same = true;
      for (let j = 0; j < n; j++) {
        if (seq[i + j] !== seq[i - n + j]) {
          same = false;
          break;
        }
      }
      if (same) {
        run += 1;
        if (run >= MAX_REPEAT_RUN) return true;
      } else {
        run = 1;
      }
    }
  }
  return false;
}

/** numpy.logaddexp */
function logaddexp(x: number, y: number): number {
  if (x === y) return x + Math.LN2;
  const tmp = x - y;
  if (tmp > 0) return x + Math.log1p(Math.exp(-tmp));
  if (tmp <= 0) return y + Math.log1p(Math.exp(tmp));
  return tmp; // NaN
}

/**
 * -log p_CTC(seq | logp) by the forward algorithm in the log domain, logp [T, V]. +Infinity when the
 * sequence cannot be aligned to the frames.
 */
export function ctcNll(logp: Float32Array, T: number, V: number, seq: readonly number[], blank: number): number {
  if (seq.length === 0) return -pairwiseSumF32(logp, blank, T, V);
  const S = 2 * seq.length + 1;
  const ext = new Int32Array(S).fill(blank);
  for (let i = 0; i < seq.length; i++) ext[2 * i + 1] = seq[i];
  if (T < (S + 1) >> 1) return Infinity;
  // positions that may skip the blank between two different labels
  const skip = new Uint8Array(S);
  for (let s = 2; s < S; s++) skip[s] = ext[s] !== blank && ext[s] !== ext[s - 2] ? 1 : 0;
  let alpha = new Float64Array(S).fill(NEG);
  let next = new Float64Array(S);
  alpha[0] = logp[blank];
  if (S > 1) alpha[1] = logp[ext[1]];
  for (let t = 1; t < T; t++) {
    const row = t * V;
    for (let s = 0; s < S; s++) {
      const a0 = alpha[s];
      const a1 = s >= 1 ? alpha[s - 1] : NEG;
      const a2 = skip[s] ? alpha[s - 2] : NEG;
      const m = Math.max(a0, Math.max(a1, a2));
      next[s] = m + Math.log(Math.exp(a0 - m) + Math.exp(a1 - m) + Math.exp(a2 - m)) + logp[row + ext[s]];
    }
    const tmp = alpha;
    alpha = next;
    next = tmp;
  }
  const tail = S === 1 ? alpha[S - 1] : logaddexp(alpha[S - 1], alpha[S - 2]);
  return tail > NEG / 2 ? -tail : Infinity;
}
