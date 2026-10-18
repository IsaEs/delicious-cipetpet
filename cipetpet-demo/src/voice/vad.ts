// Energy voice activity detection for hands-free mode, on the microphone's RMS level stream (~20 values a
// second from MicRecorder's onLevel). Pure: feed it (level, time) pairs, it returns events.
//
// * The noise floor adapts: it follows the level down quickly and up slowly, and only while nobody speaks,
//   so a fan or street noise raises it but speech does not.
// * Speech starts after `startMs` (150 ms) of level above max(minLevel, floor x ratio). Short bursts (clicks,
//   a knock, a cough) never reach that and are ignored; a gap of more than `bridgeMs` resets the count.
// * The utterance ends after `endSilenceMs` (900 ms) below the (lower, hysteresis) release threshold, or when
//   it reaches `maxUtteranceMs` (25 s: Duyu-small is made for short utterances).

export interface VadOptions {
  /** ms above the threshold before speech starts (default 150) */
  startMs?: number;
  /** ms of silence that end an utterance (default 900) */
  endSilenceMs?: number;
  /** hard cap on one utterance (default 25000) */
  maxUtteranceMs?: number;
  /** speech = level above noise floor x ratio (default 3) */
  ratio?: number;
  /** ... and above this absolute RMS (default 0.012) */
  minLevel?: number;
  /** release threshold = start threshold x hysteresis (default 0.6) */
  hysteresis?: number;
  /** gaps up to this long (ms) do not reset the start count (default 100) */
  bridgeMs?: number;
  /** noise floor time constants, ms (default 300 down, 5000 up) */
  floorDownMs?: number;
  floorUpMs?: number;
  /** audio covered by one level reading, ms (default 50, MicRecorder's block) */
  blockMs?: number;
  /** initial noise floor (default: the first level seen) */
  initialFloor?: number;
}

export type VadSensitivity = "low" | "medium" | "high";

/** UI presets: "high" reacts to quiet speech (and to more noise) */
export function vadPreset(sensitivity: VadSensitivity): Pick<VadOptions, "ratio" | "minLevel"> {
  switch (sensitivity) {
    case "low":
      return { ratio: 4.5, minLevel: 0.02 };
    case "high":
      return { ratio: 2, minLevel: 0.006 };
    default:
      return { ratio: 3, minLevel: 0.012 };
  }
}

export type VadEvent =
  | { type: "speech-start"; /** when the voiced run began (ms, the caller's clock) */ at: number }
  | { type: "speech-end"; /** last voiced moment */ at: number; durationMs: number; reason: "silence" | "max" };

const FLOOR_MIN = 0.0005;
const FLOOR_MAX = 0.25;

export class EnergyVad {
  private readonly o: Required<Omit<VadOptions, "initialFloor">>;
  private readonly initialFloor: number | undefined;
  private floor: number | undefined;
  private lastT: number | undefined;
  private speaking = false;
  private candidateStart: number | undefined;
  private aboveMs = 0;
  private lastAbove = 0;
  private speechStart = 0;
  private lastVoice = 0;

  constructor(opts: VadOptions = {}) {
    this.o = {
      startMs: opts.startMs ?? 150,
      endSilenceMs: opts.endSilenceMs ?? 900,
      maxUtteranceMs: opts.maxUtteranceMs ?? 25000,
      ratio: opts.ratio ?? 3,
      minLevel: opts.minLevel ?? 0.012,
      hysteresis: opts.hysteresis ?? 0.6,
      bridgeMs: opts.bridgeMs ?? 100,
      floorDownMs: opts.floorDownMs ?? 300,
      floorUpMs: opts.floorUpMs ?? 5000,
      blockMs: opts.blockMs ?? 50,
    };
    this.initialFloor = opts.initialFloor;
    this.floor = opts.initialFloor;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  get noiseFloor(): number {
    return this.floor ?? 0;
  }

  /** the level speech has to exceed right now */
  get threshold(): number {
    return Math.max(this.o.minLevel, (this.floor ?? 0) * this.o.ratio);
  }

  reset(): void {
    this.floor = this.initialFloor;
    this.lastT = undefined;
    this.speaking = false;
    this.candidateStart = undefined;
    this.aboveMs = 0;
  }

  /** feeds one level reading taken at `t` ms; returns an event when speech starts or ends */
  process(level: number, t: number): VadEvent | null {
    const x = Number.isFinite(level) && level > 0 ? level : 0;
    const dt = this.lastT === undefined ? 0 : Math.min(250, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (this.floor === undefined) this.floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, x));

    const start = this.threshold;
    if (this.speaking) {
      const release = start * this.o.hysteresis;
      if (x > release) this.lastVoice = t;
      if (t - this.speechStart >= this.o.maxUtteranceMs) return this.end(t, "max");
      if (t - this.lastVoice >= this.o.endSilenceMs) return this.end(this.lastVoice, "silence");
      return null;
    }

    if (x > start) {
      if (this.candidateStart === undefined || t - this.lastAbove > this.o.bridgeMs) {
        // a reading stands for the block of audio it measured
        this.candidateStart = t;
        this.aboveMs = this.o.blockMs;
      } else {
        this.aboveMs += dt;
      }
      this.lastAbove = t;
      if (this.aboveMs >= this.o.startMs) {
        this.speaking = true;
        this.speechStart = this.candidateStart;
        this.lastVoice = t;
        this.candidateStart = undefined;
        return { type: "speech-start", at: this.speechStart };
      }
      return null;
    }

    if (this.candidateStart !== undefined && t - this.lastAbove > this.o.bridgeMs) {
      this.candidateStart = undefined;
      this.aboveMs = 0;
    }
    // adapt the floor only on non-speech readings
    if (this.candidateStart === undefined && dt > 0) {
      const tau = x < this.floor ? this.o.floorDownMs : this.o.floorUpMs;
      const a = 1 - Math.exp(-dt / tau);
      this.floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, this.floor + (x - this.floor) * a));
    }
    return null;
  }

  private end(at: number, reason: "silence" | "max"): VadEvent {
    this.speaking = false;
    this.candidateStart = undefined;
    this.aboveMs = 0;
    return { type: "speech-end", at, durationMs: at - this.speechStart, reason };
  }
}
