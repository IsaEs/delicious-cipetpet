// Channel mix-down and a deterministic band-limited resampler (pure TypeScript, same output everywhere).
//
// resample() is a windowed-sinc interpolator: every output sample is a dot product of the input with a
// Kaiser-windowed sinc centred on the output instant.
//   * cutoff: 0.95 of the lower rate's Nyquist (-6 dB at 7.6 kHz for 48k -> 16k)
//   * length: 64 samples of the lower rate on each side of the output instant (192 input samples at 48k -> 16k)
//   * window: Kaiser, beta = 8.6 (sidelobes ~ -87 dB); at 48k -> 16k the transition band runs from ~7.25 to
//     ~7.95 kHz, so it ends below the output Nyquist and nothing aliases back into the passband
//   * each phase of the kernel is normalised to unit DC gain
// Measured (1 s tones): gain 1 +- 1e-5 up to 1 kHz and 0.99997 at 7 kHz (48k -> 16k, 44.1k -> 16k, 16k -> 48k);
// 8.5 / 11 kHz tones at 48k -> 16k come out ~ -100 dB, 9 / 20 kHz at 44.1k -> 16k -100 / -118 dB.
// 30 s of 48 kHz audio takes ~ 0.17 s on one core (Apple M-class, Node).
// Samples outside the input count as zeros. Integer rates use a precomputed polyphase table (one phase per
// distinct fractional position, so the kernel is exact); other rates compute the kernel per output sample.

const HALF_WIDTH = 64; // kernel half-width, in samples of the lower rate
const ROLLOFF = 0.95;
const KAISER_BETA = 8.6;
/** largest polyphase table (phases x taps) kept; beyond it the kernel is computed per sample */
const MAX_TABLE = 1 << 20;

/** Averages the channels into one. A single channel is returned as is (not copied). */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) throw new RangeError("cipetpet: toMono needs at least one channel");
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of channels) s += c[i];
    out[i] = s * k;
  }
  return out;
}

/**
 * Resamples `x` from `fromRate` to `toRate` Hz. Output length is round(x.length * toRate / fromRate);
 * equal rates return an exact copy.
 */
export function resample(x: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0 && toRate > 0 && Number.isFinite(fromRate) && Number.isFinite(toRate))) {
    throw new RangeError(`cipetpet: bad resample rates ${fromRate} -> ${toRate}`);
  }
  if (fromRate === toRate) return x.slice();
  const n = x.length;
  const outLen = Math.round((n * toRate) / fromRate);
  const out = new Float32Array(outLen);
  if (n === 0 || outLen === 0) return out;

  const scale = Math.min(1, toRate / fromRate); // lower Nyquist / input Nyquist
  const half = HALF_WIDTH / scale; // kernel half-width, input samples
  const K = Math.ceil(half);
  const T = 2 * K; // taps per output sample: input indices base-K+1 .. base+K

  const plan = integerPlan(fromRate, toRate, scale, half, K, T);
  if (plan) {
    const { phases: L, step: M, table } = plan;
    // Output k sits at input position k*M/L: kept as an integer numerator, so there is no drift
    // (k*M stays far below 2^53 for any real recording).
    for (let k = 0; k < outLen; k++) {
      const p = k * M;
      const base = Math.floor(p / L);
      out[k] = dot(x, base - K + 1, table, (p - base * L) * T, T);
    }
    return out;
  }

  const step = fromRate / toRate;
  const kernel = new Float64Array(T);
  for (let k = 0; k < outLen; k++) {
    const t = k * step;
    const base = Math.floor(t);
    fillKernel(kernel, 0, t - base, scale, half, K, T);
    out[k] = dot(x, base - K + 1, kernel, 0, T);
  }
  return out;
}

function dot(x: Float32Array, start: number, h: Float64Array, off: number, T: number): number {
  let acc = 0;
  if (start >= 0 && start + T <= x.length) {
    for (let i = 0; i < T; i++) acc += x[start + i] * h[off + i];
  } else {
    const lo = Math.max(0, -start);
    const hi = Math.min(T, x.length - start);
    for (let i = lo; i < hi; i++) acc += x[start + i] * h[off + i];
  }
  return acc;
}

/** kernel taps for input indices base-K+1 .. base+K around position base + frac, normalised to sum 1 */
function fillKernel(h: Float64Array, off: number, frac: number, scale: number, half: number, K: number, T: number): void {
  const fc = ROLLOFF * scale; // cutoff in units of the input Nyquist
  let sum = 0;
  for (let i = 0; i < T; i++) {
    const tau = i - K + 1 - frac; // distance from the output instant, input samples
    const u = tau / half;
    let v = 0;
    if (u > -1 && u < 1) {
      const a = Math.PI * fc * tau;
      v = (a === 0 ? 1 : Math.sin(a) / a) * kaiser(u);
    }
    h[off + i] = v;
    sum += v;
  }
  for (let i = 0; i < T; i++) h[off + i] /= sum;
}

const I0_BETA = besselI0(KAISER_BETA);
function kaiser(u: number): number {
  return besselI0(KAISER_BETA * Math.sqrt(1 - u * u)) / I0_BETA;
}

/** modified Bessel function of the first kind, order 0 (power series; converges fast for x <= 9) */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; term > sum * 1e-17; k++) {
    term *= q / (k * k);
    sum += term;
  }
  return sum;
}

interface Plan {
  /** L: distinct output phases (toRate / gcd) */
  phases: number;
  /** M: input samples advanced per L outputs (fromRate / gcd) */
  step: number;
  /** L x T taps, row = phase */
  table: Float64Array;
}

// A few plans are kept: an app resamples between the same couple of rates over and over.
const plans = new Map<string, Plan>();

function integerPlan(from: number, to: number, scale: number, half: number, K: number, T: number): Plan | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  const key = `${from}:${to}`;
  const hit = plans.get(key);
  if (hit) return hit;
  const g = gcd(from, to);
  const L = to / g;
  const M = from / g;
  if (L * T > MAX_TABLE) return null;
  const table = new Float64Array(L * T);
  for (let ph = 0; ph < L; ph++) fillKernel(table, ph * T, ph / L, scale, half, K, T);
  const plan = { phases: L, step: M, table };
  if (plans.size >= 4) plans.delete(plans.keys().next().value!);
  plans.set(key, plan);
  return plan;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
