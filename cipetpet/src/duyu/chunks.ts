// Long-audio chunking (port of duyu_small/audio.py chunks): the model is trained on utterances of at
// most 30 s, so longer input is cut every ~25 s at the lowest-energy 20 ms frame within ±4 s of the
// boundary.
//
// audio.py computes the frame energy for every sample with np.convolve(x², ones(320)/320, "same") and
// takes the first argmin inside the search window. Only the search windows are needed, so the energies
// are computed there, each one as a fresh dot product: a running sum would leave rounding residue in
// all-zero stretches, where numpy gets exactly 0 and the first-occurrence tie-break decides the cut.

export interface ChunkOptions {
  maxS?: number;
  limitS?: number;
  searchS?: number;
  sampleRate?: number;
}

/** [start, end) sample ranges of the chunks; one range for input of at most `limitS` seconds. */
export function chunkBounds(audio: Float32Array, opts: ChunkOptions = {}): [number, number][] {
  const { maxS = 25, limitS = 30, searchS = 4, sampleRate: sr = 16000 } = opts;
  const n = audio.length;
  if (n <= limitS * sr) return [[0, n]];
  const frame = Math.floor(sr / 50);
  const out: [number, number][] = [];
  let start = 0;
  while (n - start > limitS * sr) {
    const target = start + Math.trunc(maxS * sr);
    const lo = Math.max(start + sr, target - Math.trunc(searchS * sr));
    const hi = Math.min(n - sr, target + Math.trunc(searchS * sr));
    const cut = hi > lo ? lo + argminRms(audio, lo, hi, frame) : target;
    out.push([start, cut]);
    start = cut;
  }
  out.push([start, n]);
  return out;
}

/** first index (relative to lo) of the minimum of sqrt(movingMeanSquare + 1e-12) over [lo, hi) */
function argminRms(x: Float32Array, lo: number, hi: number, frame: number): number {
  const w = 1 / frame;
  // np.convolve(a, v, "same") with len(v) = M centres output k on input k - M/2 .. k + M - M/2 - 1
  const left = frame >> 1;
  let best = 0;
  let bv = Infinity;
  for (let k = lo; k < hi; k++) {
    const a = Math.max(0, k - left);
    const b = Math.min(x.length, k - left + frame);
    let s = 0;
    for (let i = a; i < b; i++) {
      const v = x[i];
      s += v * v * w;
    }
    const r = Math.sqrt(s + 1e-12);
    if (r < bv) {
      bv = r;
      best = k - lo;
    }
  }
  return best;
}
