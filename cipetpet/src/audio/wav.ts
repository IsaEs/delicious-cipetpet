// RIFF/WAVE encode and decode in plain TypeScript (no Web Audio), so WAV works in workers and Node too.

export interface DecodedWav {
  sampleRate: number;
  /** one array per channel, samples in [-1, 1) */
  channels: Float32Array[];
}

export interface EncodeWavOptions {
  /** 16 = PCM int16 (default), 32 = IEEE float32 */
  bitDepth?: 16 | 32;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Encodes audio as a WAV file. `samples` is mono, or one array per channel (interleaved on write).
 * 16-bit: x is clamped to [-1, 1] and stored as round(x * 32768) clamped to int16, so decodeWav (which
 * divides by 32768) returns every int16-representable value exactly.
 */
export function encodeWav(samples: Float32Array | Float32Array[], sampleRate: number, opts: EncodeWavOptions = {}): Uint8Array {
  const channels = Array.isArray(samples) ? samples : [samples];
  const bitDepth = opts.bitDepth ?? 16;
  if (bitDepth !== 16 && bitDepth !== 32) throw new RangeError(`cipetpet: encodeWav bitDepth must be 16 or 32, got ${bitDepth}`);
  if (channels.length === 0) throw new RangeError("cipetpet: encodeWav needs at least one channel");
  if (!(sampleRate > 0) || !Number.isInteger(sampleRate)) throw new RangeError(`cipetpet: bad sample rate ${sampleRate}`);
  const frames = channels[0].length;
  if (channels.some((c) => c.length !== frames)) throw new RangeError("cipetpet: encodeWav channels differ in length");

  const nch = channels.length;
  const bytesPer = bitDepth / 8;
  const blockAlign = nch * bytesPer;
  const dataBytes = frames * blockAlign;
  // float data gets a "fact" chunk, which the WAVE spec asks for with any non-PCM format
  const factBytes = bitDepth === 32 ? 12 : 0;
  const out = new Uint8Array(44 + factBytes + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };

  tag(0, "RIFF");
  v.setUint32(4, out.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, bitDepth === 32 ? FORMAT_FLOAT : FORMAT_PCM, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitDepth, true);
  let o = 36;
  if (factBytes) {
    tag(o, "fact");
    v.setUint32(o + 4, 4, true);
    v.setUint32(o + 8, frames, true);
    o += 12;
  }
  tag(o, "data");
  v.setUint32(o + 4, dataBytes, true);
  o += 8;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = channels[c][i];
      if (bitDepth === 32) {
        v.setFloat32(o, x, true);
      } else {
        // NaN -> 0; values outside [-1, 1] clip
        const s = Math.round((x > 1 ? 1 : x < -1 ? -1 : x || 0) * 32768);
        v.setInt16(o, s > 32767 ? 32767 : s, true);
      }
      o += bytesPer;
    }
  }
  return out;
}

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/**
 * Decodes a WAV file: PCM 8/16/24/32-bit and IEEE float 32/64, plain or WAVE_FORMAT_EXTENSIBLE, any
 * number of channels. Unknown chunks (LIST, fact, cue, …) are skipped, odd-sized chunks honour their pad
 * byte, and a data chunk whose size overruns the file (streaming writers put a placeholder such as 0xFFFFFFFF there) is cut
 * to the whole frames present. Integer PCM is scaled by 2^-(bits-1) (16-bit: int16 / 32768, as numpy and
 * soundfile do); 8-bit is unsigned with 128 as zero.
 */
export function decodeWav(input: Uint8Array | ArrayBuffer): DecodedWav {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12 || fourcc(b, 0) !== "RIFF" || fourcc(b, 8) !== "WAVE") {
    throw new Error("cipetpet: not a WAV file (no RIFF/WAVE header)");
  }

  let fmt: { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | undefined;
  let dataStart = -1;
  let dataSize = 0;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = fourcc(b, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > b.length) throw new Error("cipetpet: WAV fmt chunk is truncated");
      let format = v.getUint16(body, true);
      const bits = v.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE) {
        // cbSize(2) validBits(2) channelMask(4) then the SubFormat GUID, whose first two bytes are the format code
        if (size < 40 || body + 26 > b.length) throw new Error("cipetpet: WAV extensible fmt chunk is truncated");
        format = v.getUint16(body + 24, true);
      }
      fmt = {
        format,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bits,
      };
    } else if (id === "data") {
      dataStart = body;
      dataSize = Math.min(size, b.length - body);
      break; // anything after the samples (LIST, id3 …) is of no use
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error("cipetpet: WAV file has no fmt chunk");
  if (dataStart < 0) throw new Error("cipetpet: WAV file has no data chunk");

  const { format, channels: nch, sampleRate, bits } = fmt;
  const bytesPer = bits / 8;
  if (nch < 1) throw new Error("cipetpet: WAV file declares 0 channels");
  if (!(sampleRate > 0)) throw new Error("cipetpet: WAV file declares sample rate 0");
  const supported =
    (format === FORMAT_PCM && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) ||
    (format === FORMAT_FLOAT && (bits === 32 || bits === 64));
  if (!supported) {
    throw new Error(`cipetpet: unsupported WAV encoding (format 0x${format.toString(16)}, ${bits}-bit); PCM 8/16/24/32 and float 32/64 are`);
  }
  // blockAlign is redundant with channels * bytesPer; trust the sample layout, not a broken header field
  const blockAlign = nch * bytesPer;
  const frames = Math.floor(dataSize / blockAlign);

  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  const read = sampleReader(v, format, bits);
  for (let c = 0; c < nch; c++) {
    const ch = channels[c];
    let o = dataStart + c * bytesPer;
    for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = read(o);
  }
  return { sampleRate, channels };
}

function sampleReader(v: DataView, format: number, bits: number): (o: number) => number {
  if (format === FORMAT_FLOAT) return bits === 32 ? (o) => v.getFloat32(o, true) : (o) => v.getFloat64(o, true);
  switch (bits) {
    case 8:
      return (o) => (v.getUint8(o) - 128) / 128;
    case 16:
      return (o) => v.getInt16(o, true) / 32768;
    case 24:
      return (o) => ((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) / 2147483648;
    default:
      return (o) => v.getInt32(o, true) / 2147483648;
  }
}
