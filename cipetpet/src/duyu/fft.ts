// Float64 FFT for the fbank front end (features.py uses numpy's rfft, which computes in float64).
//
// A real FFT of even length n is done as one complex FFT of length n/2 over the packed sequence
// z[k] = x[2k] + i·x[2k+1], followed by the usual split step. The complex FFT is an iterative radix-2
// decimation-in-time transform with precomputed twiddles and bit-reversal table, so a transform does no
// trigonometry and no allocation. Agreement with pocketfft is at the 1e-16 relative level, far inside
// the 1e-4 budget the fbank has.

export class RealFft {
  /** transform length (a power of two, >= 4) */
  readonly n: number;
  readonly #half: number;
  readonly #rev: Uint32Array;
  /** twiddles of the n/2-point complex FFT: exp(-2πi·k/(n/2)), k < n/4 */
  readonly #cosH: Float64Array;
  readonly #sinH: Float64Array;
  /** split-step twiddles exp(-2πi·k/n), k <= n/2 */
  readonly #cosN: Float64Array;
  readonly #sinN: Float64Array;
  readonly #re: Float64Array;
  readonly #im: Float64Array;

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 4 || (n & (n - 1)) !== 0) throw new RangeError(`cipetpet: FFT length ${n} is not a power of two >= 4`);
    this.n = n;
    const h = n >> 1;
    this.#half = h;
    const bits = Math.log2(h);
    this.#rev = new Uint32Array(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.#rev[i] = r;
    }
    this.#cosH = new Float64Array(h >> 1);
    this.#sinH = new Float64Array(h >> 1);
    for (let k = 0; k < h >> 1; k++) {
      const a = (-2 * Math.PI * k) / h;
      this.#cosH[k] = Math.cos(a);
      this.#sinH[k] = Math.sin(a);
    }
    this.#cosN = new Float64Array(h + 1);
    this.#sinN = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      const a = (-2 * Math.PI * k) / n;
      this.#cosN[k] = Math.cos(a);
      this.#sinN[k] = Math.sin(a);
    }
    this.#re = new Float64Array(h);
    this.#im = new Float64Array(h);
  }

  /**
   * |rfft(x, n)|² into `out` (length n/2 + 1). `x` may be shorter than n (zero-padded, like numpy's
   * `rfft(x, n=n)`), never longer.
   */
  powerSpectrum(x: ArrayLike<number>, out: Float64Array): void {
    const n = this.n;
    const h = this.#half;
    if (x.length > n) throw new RangeError(`cipetpet: FFT input of ${x.length} samples exceeds n = ${n}`);
    const re = this.#re;
    const im = this.#im;
    const rev = this.#rev;
    const len = x.length;
    for (let k = 0; k < h; k++) {
      const j = rev[k];
      const a = 2 * k;
      re[j] = a < len ? x[a] : 0;
      im[j] = a + 1 < len ? x[a + 1] : 0;
    }
    this.#complexInPlace();

    // Split step: X[k] = E[k] + W^k·O[k], with E/O the spectra of the even/odd samples:
    //   E[k] = (Z[k] + conj(Z[h-k])) / 2,  O[k] = (Z[k] - conj(Z[h-k])) / 2i
    const cN = this.#cosN;
    const sN = this.#sinN;
    for (let k = 0; k <= h; k++) {
      const k1 = k === h ? 0 : k;
      const k2 = k === 0 ? 0 : h - k;
      const zr = re[k1], zi = im[k1];
      const wr = re[k2], wi = -im[k2]; // conj(Z[h-k])
      const er = 0.5 * (zr + wr);
      const ei = 0.5 * (zi + wi);
      // (Z - conj)/2i = ((zi - wi) - i(zr - wr)) / 2
      const or = 0.5 * (zi - wi);
      const oi = -0.5 * (zr - wr);
      const c = cN[k], s = sN[k];
      const xr = er + (c * or - s * oi);
      const xi = ei + (c * oi + s * or);
      out[k] = xr * xr + xi * xi;
    }
  }

  #complexInPlace(): void {
    const h = this.#half;
    const re = this.#re;
    const im = this.#im;
    const cH = this.#cosH;
    const sH = this.#sinH;
    for (let size = 2; size <= h; size <<= 1) {
      const half = size >> 1;
      const step = h / size;
      for (let start = 0; start < h; start += size) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const a = start + j;
          const b = a + half;
          const c = cH[t], s = sH[t];
          const br = re[b] * c - im[b] * s;
          const bi = re[b] * s + im[b] * c;
          re[b] = re[a] - br;
          im[b] = im[a] - bi;
          re[a] += br;
          im[a] += bi;
        }
      }
    }
  }
}
