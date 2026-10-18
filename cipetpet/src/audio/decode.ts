// Any audio file -> mono float32 at the rate a model wants.

import { decodeWav } from "./wav.js";
import { resample, toMono } from "./resample.js";

export interface DecodedAudio {
  /** mono float32 at `sampleRate` */
  audio: Float32Array;
  sampleRate: number;
  /** seconds */
  duration: number;
}

export type AudioInput = Blob | ArrayBuffer | Uint8Array;

/** Rate compressed formats are decoded at before our resampler takes over. decodeAudioData always
 * converts to its context's rate; 48 kHz is what Opus (WebM / Ogg from MediaRecorder) is coded at, and
 * the browser's own resampler is high quality for the 44.1 kHz MP3 / AAC case. */
const WEB_AUDIO_RATE = 48000;

/**
 * Decodes an audio file to mono at `targetRate` (default 16000). WAV is parsed here, so it works in any
 * environment (workers, Node); other formats (MP3, M4A/AAC, Ogg, WebM, FLAC …) go through the browser's
 * decodeAudioData. Channels are averaged and the result is resampled with resample().
 */
export async function decodeAudio(input: AudioInput, targetRate = 16000): Promise<DecodedAudio> {
  if (!(targetRate > 0)) throw new RangeError(`cipetpet: bad target sample rate ${targetRate}`);
  const bytes = await toBytes(input);

  let wavError: unknown;
  if (isWav(bytes)) {
    try {
      const { sampleRate, channels } = decodeWav(bytes);
      return finish(toMono(channels), sampleRate, targetRate);
    } catch (e) {
      // e.g. A-law / ADPCM WAV: the browser may still know it
      wavError = e;
    }
  }

  const Offline = offlineContextClass();
  if (!Offline) {
    if (wavError) throw wavError;
    throw new Error(
      "cipetpet: only WAV can be decoded here (no Web Audio API in this environment); " +
        "decode the file elsewhere or pass a WAV / Float32Array",
    );
  }
  const ctx = new Offline(1, 1, WEB_AUDIO_RATE);
  let buffer: AudioBuffer;
  try {
    // decodeAudioData detaches the buffer it is given, so hand it a copy. The callback form also covers
    // old Safari, whose decodeAudioData returns no promise.
    const copy = bytes.slice().buffer as ArrayBuffer;
    buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = ctx.decodeAudioData(copy, resolve, (e) => reject(e ?? new Error("decodeAudioData failed")));
      if (p && typeof p.catch === "function") p.catch(reject);
    });
  } catch (e) {
    throw new Error(`cipetpet: could not decode the audio (${describe(bytes)}): ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  return finish(toMono(channels), buffer.sampleRate, targetRate);
}

function finish(mono: Float32Array, rate: number, targetRate: number): DecodedAudio {
  const audio = rate === targetRate ? mono : resample(mono, rate, targetRate);
  return { audio, sampleRate: targetRate, duration: audio.length / targetRate };
}

async function toBytes(input: AudioInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  throw new TypeError("cipetpet: decodeAudio expects a Blob, File, ArrayBuffer or Uint8Array");
}

const isWav = (b: Uint8Array) =>
  b.length >= 12 &&
  b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
  b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45; // WAVE

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineContextClass(): OfflineCtor | undefined {
  const g = globalThis as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
}

/** a short label of the container for error messages */
function describe(b: Uint8Array): string {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === "OggS") return "Ogg";
  if (ascii(0, 4) === "fLaC") return "FLAC";
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "MP3";
  if (ascii(4, 4) === "ftyp") return "MP4/M4A";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "WebM/Matroska";
  if (ascii(0, 4) === "RIFF") return "RIFF/WAV";
  return `${b.length} bytes, unknown format`;
}
