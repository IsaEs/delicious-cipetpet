// A self-tuning start-up buffer for streamed speech: how many seconds of silence go before a reply.
//
// Speech is synthesised sentence by sentence while the previous one plays. Even when the voice is several times faster
// than real time overall, a short first sentence ("Merhaba!") can finish playing before the next, longer one is ready,
// and the listener hears a gap. The gap depends on the device (a phone, a page without threads), so instead of a fixed
// delay the buffer learns: a reply that runs dry raises the delay by what was missing, a reply that plays through lowers
// it a little. A fast device keeps 0 (no added latency); a slow one settles where replies play without gaps.
// A gap that comes from waiting for the language model's next sentence is not the voice's fault: it teaches nothing.

/** never delay a reply by more than this (seconds) */
export const PREBUFFER_MAX = 1.5;
/** added on top of a measured shortfall, so the next reply does not end up just short again */
const MARGIN = 0.1;
/** a reply without a gap keeps this share of the delay */
const DECAY = 0.85;

export class Prebuffer {
  private inReply = false;
  private ranDry = false;

  /** `seconds`: the delay learned so far; `save` is called whenever it changes (to keep it across visits) */
  constructor(
    public seconds = 0,
    private readonly save?: (seconds: number) => void,
  ) {
    this.seconds = Number.isFinite(seconds) ? Math.min(PREBUFFER_MAX, Math.max(0, seconds)) : 0;
  }

  /**
   * Seconds of silence to queue before the next chunk.
   * `now`: the audio clock; `endsAt`: when everything queued so far ends; `lead`: how far ahead an idle player starts a
   * chunk; `fresh`: the chunk follows a wait for text (the language model), not for synthesis.
   */
  beforeChunk(now: number, endsAt: number, lead: number, fresh: boolean): number {
    if (!this.inReply) {
      this.inReply = true;
      this.ranDry = false;
      return this.seconds;
    }
    const short = now + lead - endsAt;
    if (short <= 0) return 0; // still playing: the chunk joins the queue
    if (fresh) return this.seconds; // a new start after the language model: pause as a reply would, learn nothing
    this.ranDry = true;
    this.set(this.seconds + short + MARGIN);
    // one longer pause now rather than several short ones in the rest of the reply
    return this.seconds;
  }

  /** the reply played to its end */
  finished(): void {
    if (this.inReply && !this.ranDry && this.seconds > 0) this.set(this.seconds * DECAY < 0.02 ? 0 : this.seconds * DECAY);
    this.inReply = false;
  }

  /** the reply was stopped (Stop, barge-in): what it showed is incomplete, learn nothing */
  stopped(): void {
    this.inReply = false;
  }

  private set(seconds: number): void {
    const next = Math.round(Math.min(PREBUFFER_MAX, Math.max(0, seconds)) * 1000) / 1000;
    if (next === this.seconds) return;
    this.seconds = next;
    this.save?.(next);
  }
}
