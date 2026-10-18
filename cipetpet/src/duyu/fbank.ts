// Log-mel fbank exactly as Duyu-small was trained on (port of duyu_small/features.py): Kaldi framing
// 25 ms / 10 ms, per-frame DC removal, pre-emphasis 0.97, Povey window, 512-point power spectrum, 80 mel
// bins, log, per-utterance mean / variance normalisation, two frames stacked -> 160-dim vectors at 50 Hz.
// The window and mel filters come from the pack (float32 tables); like features.py, which casts them to
// float64, every step up to the final stack runs in float64.

import { RealFft } from "./fft.js";

export const WIN = 400;
export const HOP = 160;
export const NFFT = 512;
export const MELS = 80;
export const BINS = NFFT / 2 + 1;
export const EPS = 1.192092955078125e-7;
const PREEMPH = 0.97;

export interface Features {
  /** [frames, 160] row-major */
  data: Float32Array;
  frames: number;
}

export class Fbank {
  readonly #window: Float64Array;
  /** [257, 80] row-major */
  readonly #mel: Float64Array;
  readonly #fft = new RealFft(NFFT);

  constructor(window: Float32Array, mel: Float32Array) {
    if (window.length !== WIN) throw new RangeError(`cipetpet: fbank window has ${window.length} values, expected ${WIN}`);
    if (mel.length !== BINS * MELS) throw new RangeError(`cipetpet: mel filter bank has ${mel.length} values, expected ${BINS}x${MELS}`);
    this.#window = Float64Array.from(window);
    this.#mel = Float64Array.from(mel);
  }

  /** 16 kHz waveform in [-1, 1] -> (T', 160) float32, T' = floor(frames / 2). */
  compute(wav: Float32Array): Features {
    const len = Math.max(wav.length, WIN); // shorter input is zero-padded to one frame
    const n = Math.floor((len - WIN) / HOP) + 1;
    const sample = (i: number) => (i < wav.length ? wav[i] * 32768 : 0);

    const frame = new Float64Array(WIN);
    const spec = new Float64Array(BINS);
    const logmel = new Float64Array(n * MELS);
    const win = this.#window;
    const mel = this.#mel;
    const keep = 1 - PREEMPH;
    for (let f = 0; f < n; f++) {
      const off = f * HOP;
      let sum = 0;
      for (let i = 0; i < WIN; i++) {
        const v = sample(off + i);
        frame[i] = v;
        sum += v;
      }
      const mean = sum / WIN;
      for (let i = 0; i < WIN; i++) frame[i] -= mean;
      // pre-emphasis from the end backwards so frame[i-1] is still the DC-removed sample;
      // the first sample keeps (1 - 0.97) of itself, as in Kaldi / features.py
      for (let i = WIN - 1; i > 0; i--) frame[i] = (frame[i] - PREEMPH * frame[i - 1]) * win[i];
      frame[0] = frame[0] * keep * win[0];
      this.#fft.powerSpectrum(frame, spec);

      const row = f * MELS;
      for (let m = 0; m < MELS; m++) logmel[row + m] = 0;
      for (let b = 0; b < BINS; b++) {
        const p = spec[b];
        const mr = b * MELS;
        for (let m = 0; m < MELS; m++) logmel[row + m] += p * mel[mr + m];
      }
      for (let m = 0; m < MELS; m++) logmel[row + m] = Math.log(Math.max(logmel[row + m], EPS));
    }

    // per-utterance mean / unbiased variance per mel bin (variance 1 for a single frame)
    const mean = new Float64Array(MELS);
    const scale = new Float64Array(MELS);
    for (let f = 0; f < n; f++) for (let m = 0; m < MELS; m++) mean[m] += logmel[f * MELS + m];
    for (let m = 0; m < MELS; m++) mean[m] /= n;
    for (let m = 0; m < MELS; m++) {
      let v = 1;
      if (n > 1) {
        let ss = 0;
        for (let f = 0; f < n; f++) {
          const d = logmel[f * MELS + m] - mean[m];
          ss += d * d;
        }
        v = ss / (n - 1);
      }
      scale[m] = Math.sqrt(v + 1e-7);
    }

    // stack frame pairs; an odd last frame is dropped
    const t = n - (n % 2);
    const data = new Float32Array(t * MELS);
    for (let i = 0; i < t * MELS; i++) {
      const m = i % MELS;
      data[i] = (logmel[i] - mean[m]) / scale[m];
    }
    return { data, frames: t / 2 };
  }
}
