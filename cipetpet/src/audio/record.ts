// Microphone capture (browser only): getUserMedia -> AudioWorklet (ScriptProcessorNode where worklets are
// missing) -> mono float32 blocks on the main thread -> resampled to the rate the model wants on stop().

import { resample } from "./resample.js";

export interface MicRecorderOptions {
  /** rate of the audio stop() returns (default 16000, what Duyu-small takes) */
  sampleRate?: number;
  /** a device from navigator.mediaDevices.enumerateDevices() */
  deviceId?: string;
  /** called ~20 times a second with the RMS level (0..1) of the latest block, for a meter */
  onLevel?: (rms: number) => void;
  /** extra audio constraints, applied over the defaults (mono, no echo cancellation / noise
   * suppression / auto gain: the models were trained on unprocessed speech) */
  constraints?: MediaTrackConstraints;
}

/** seconds of audio per block posted from the audio thread (also the onLevel interval) */
const BLOCK_SECONDS = 0.05;

// The worklet, as a module source (loaded through a Blob URL, so the library needs no extra file).
// It averages the input channels, collects ~50 ms blocks and transfers them to the main thread; a "flush"
// message posts whatever is buffered, so stop() loses no tail.
const WORKLET_NAME = "cipetpet-mic-capture";
const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.blockSize;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        const out = this.buf.slice(0, this.n);
        this.n = 0;
        this.port.postMessage({ flushed: true, block: out }, [out.buffer]);
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length, nch = input.length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < nch; c++) s += input[c][i];
      this.buf[this.n++] = s / nch;
      if (this.n === this.size) {
        this.port.postMessage({ block: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, Capture);
`;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextClass(): AudioContextCtor | undefined {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
}

/**
 * Records from the microphone.
 *
 * ```ts
 * const rec = await MicRecorder.start({ onLevel: (l) => meter.value = l });
 * const audio = await rec.stop(); // Float32Array, mono, 16 kHz
 * ```
 */
export class MicRecorder {
  /** rate of the audio stop() returns */
  readonly sampleRate: number;
  /** rate the audio is captured at (the AudioContext's, usually 44.1 or 48 kHz) */
  readonly captureRate: number;

  private chunks: Float32Array[] = [];
  private frames = 0;
  private state: "recording" | "stopping" | "done" = "recording";
  private stopping?: Promise<Float32Array>;
  private flushWorklet?: () => Promise<void>;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly nodes: AudioNode[],
    sampleRate: number,
    private readonly onLevel?: (rms: number) => void,
  ) {
    this.sampleRate = sampleRate;
    this.captureRate = ctx.sampleRate;
  }

  /** Asks for the microphone and starts recording. Call it from a user gesture (a click), so the
   * browser lets the AudioContext run. */
  static async start(opts: MicRecorderOptions = {}): Promise<MicRecorder> {
    const sampleRate = opts.sampleRate ?? 16000;
    if (!(sampleRate > 0)) throw new RangeError(`cipetpet: bad sample rate ${sampleRate}`);
    const media = globalThis.navigator?.mediaDevices;
    const Ctx = audioContextClass();
    if (!media?.getUserMedia || !Ctx) {
      throw new Error(
        "cipetpet: MicRecorder needs a browser with getUserMedia and Web Audio (and a secure context: https or localhost)",
      );
    }

    const stream = await media.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        ...opts.constraints,
      },
    });
    // The context runs at the device's rate: Firefox refuses to connect a microphone to a context at
    // another rate, so we resample ourselves afterwards.
    let ctx: AudioContext | undefined;
    try {
      ctx = new Ctx();
      // Not awaited: outside a user gesture some browsers keep this pending until the next click.
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      return await MicRecorder.connect(ctx, stream, source, sampleRate, opts.onLevel);
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      await ctx?.close().catch(() => {});
      throw e;
    }
  }

  private static async connect(
    ctx: AudioContext,
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    sampleRate: number,
    onLevel?: (rms: number) => void,
  ): Promise<MicRecorder> {
    const blockSize = Math.max(128, Math.round(ctx.sampleRate * BLOCK_SECONDS));

    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      let loaded = false;
      try {
        await ctx.audioWorklet.addModule(url);
        loaded = true;
      } catch {
        // a CSP without blob: in worker-src / script-src: fall through to ScriptProcessorNode
      } finally {
        URL.revokeObjectURL(url);
      }
      if (loaded) {
        const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { blockSize },
        });
        // connected to the destination only so the graph pulls it; its output is silence
        source.connect(node);
        node.connect(ctx.destination);
        const rec = new MicRecorder(ctx, stream, [source, node], sampleRate, onLevel);
        let flushed: (() => void) | undefined;
        node.port.onmessage = (e: MessageEvent<{ block: Float32Array; flushed?: boolean }>) => {
          rec.push(e.data.block);
          if (e.data.flushed) flushed?.();
        };
        rec.flushWorklet = () =>
          new Promise<void>((resolve) => {
            // a closed or stalled audio thread never answers; do not hang stop() on it
            const timer = setTimeout(resolve, 500);
            flushed = () => {
              clearTimeout(timer);
              resolve();
            };
            node.port.postMessage("flush");
          });
        return rec;
      }
    }

    // ScriptProcessorNode: deprecated, but the only option without AudioWorklet (old Safari, http pages).
    const size = 1 << Math.round(Math.log2(Math.min(16384, Math.max(256, blockSize))));
    const proc = ctx.createScriptProcessor(size, 1, 1);
    const rec = new MicRecorder(ctx, stream, [source, proc], sampleRate, onLevel);
    proc.onaudioprocess = (e) => {
      rec.push(e.inputBuffer.getChannelData(0).slice());
      e.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(proc);
    proc.connect(ctx.destination);
    return rec;
  }

  /** seconds recorded so far */
  get duration(): number {
    return this.frames / this.captureRate;
  }

  get recording(): boolean {
    return this.state === "recording";
  }

  private push(block: Float32Array): void {
    if (this.state === "done" || block.length === 0) return;
    this.chunks.push(block);
    this.frames += block.length;
    if (this.onLevel) {
      let s = 0;
      for (let i = 0; i < block.length; i++) s += block[i] * block[i];
      this.onLevel(Math.sqrt(s / block.length));
    }
  }

  /** Stops recording and returns the audio: mono float32 at `sampleRate`. Calling it again returns the same result. */
  stop(): Promise<Float32Array> {
    if (this.stopping) return this.stopping;
    if (this.state === "done") return Promise.reject(new Error("cipetpet: the recording was cancelled"));
    this.state = "stopping";
    this.stopping = (async () => {
      try {
        await this.flushWorklet?.();
      } finally {
        this.release();
      }
      const all = new Float32Array(this.frames);
      let o = 0;
      for (const c of this.chunks) {
        all.set(c, o);
        o += c.length;
      }
      this.chunks = [];
      return this.captureRate === this.sampleRate ? all : resample(all, this.captureRate, this.sampleRate);
    })();
    return this.stopping;
  }

  /** Stops recording and drops the audio. */
  cancel(): void {
    if (this.state === "done") return;
    this.release();
    this.chunks = [];
    this.frames = 0;
  }

  /** stops the tracks (the browser's mic indicator goes off) and closes the context */
  private release(): void {
    this.state = "done";
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    for (const t of this.stream.getTracks()) t.stop();
    this.ctx.close().catch(() => {});
  }
}
