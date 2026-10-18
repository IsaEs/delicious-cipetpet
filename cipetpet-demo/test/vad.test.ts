import { describe, expect, it } from "vitest";
import { EnergyVad, vadPreset, type VadEvent, type VadOptions } from "../src/voice/vad.ts";

/** level segments [level, ms] sampled every 50 ms (MicRecorder's rate), with a little deterministic jitter */
function run(segments: [number, number][], opts?: VadOptions, step = 50): (VadEvent & { t: number })[] {
  const vad = new EnergyVad(opts);
  const out: (VadEvent & { t: number })[] = [];
  let t = 0;
  let n = 0;
  for (const [level, ms] of segments) {
    for (let k = 0; k < ms; k += step) {
      const jitter = 1 + 0.15 * Math.sin(n++ * 1.7);
      const ev = vad.process(level * jitter, t);
      if (ev) out.push({ ...ev, t });
      t += step;
    }
  }
  return out;
}

describe("EnergyVad", () => {
  it("detects one utterance in quiet noise: start after ~150 ms, end after ~900 ms of silence", () => {
    const ev = run([
      [0.003, 1000],
      [0.12, 1500],
      [0.003, 1500],
    ]);
    expect(ev.map((e) => e.type)).toEqual(["speech-start", "speech-end"]);
    const [start, end] = ev;
    expect(start.type === "speech-start" && start.at).toBe(1000); // dated from the first loud block
    expect(start.t).toBe(1100); // confirmed after 150 ms of audio (3 blocks)
    expect(end.type === "speech-end" && end.reason).toBe("silence");
    expect(end.type === "speech-end" && end.at).toBe(2450); // last voiced block
    expect(end.t).toBeGreaterThanOrEqual(2450 + 900);
    expect(end.t).toBeLessThan(2450 + 900 + 100);
  });

  it("ignores clicks and short bursts", () => {
    expect(run([[0.003, 1000], [0.6, 50], [0.003, 1000], [0.6, 100], [0.003, 1000]])).toEqual([]);
  });

  it("bridges a one-block dip while speech starts, but not a longer gap", () => {
    // 100 ms loud, one 50 ms dip, 50 ms loud: still counts as 150 ms
    expect(run([[0.003, 500], [0.1, 100], [0.003, 50], [0.1, 50], [0.003, 2000]]).map((e) => e.type)).toEqual(["speech-start", "speech-end"]);
    // 100 ms loud, 150 ms gap, 100 ms loud: two clicks
    expect(run([[0.003, 500], [0.1, 100], [0.003, 150], [0.1, 100], [0.003, 2000]])).toEqual([]);
  });

  it("does not end the utterance on short pauses between words", () => {
    const ev = run([
      [0.003, 500],
      [0.1, 600],
      [0.003, 500], // pause shorter than 900 ms
      [0.1, 600],
      [0.003, 1200],
    ]);
    expect(ev.map((e) => e.type)).toEqual(["speech-start", "speech-end"]);
    expect(ev[1].type === "speech-end" && ev[1].durationMs).toBeGreaterThan(1500);
  });

  it("honours a configurable end-of-utterance silence", () => {
    const ev = run([[0.003, 500], [0.1, 500], [0.003, 2000]], { endSilenceMs: 400 });
    expect(ev[1].t - (ev[1].type === "speech-end" ? ev[1].at : 0)).toBeLessThan(500);
  });

  it("cuts an utterance at maxUtteranceMs (25 s by default); speech that goes on starts a new one", () => {
    const ev = run([
      [0.003, 500],
      [0.1, 27000],
    ]);
    expect(ev.map((e) => e.type)).toEqual(["speech-start", "speech-end", "speech-start"]);
    expect(ev[1].type === "speech-end" && ev[1].reason).toBe("max");
    expect(ev[1].t - ev[0].t).toBeGreaterThanOrEqual(25000 - 150);
    expect(ev[1].t - ev[0].t).toBeLessThan(25200);
  });

  it("adapts to steady background noise (fan, street) and still hears speech over it", () => {
    const ev = run([
      [0.03, 4000], // loud steady noise, above the absolute minimum
      [0.2, 800],
      [0.03, 1500],
    ]);
    expect(ev.map((e) => e.type)).toEqual(["speech-start", "speech-end"]);
    expect(ev[0].type === "speech-start" && ev[0].at).toBe(4000);
  });

  it("does not fire on slowly rising noise", () => {
    const segs: [number, number][] = [];
    for (let i = 0; i < 40; i++) segs.push([0.003 + i * 0.0007, 500]);
    expect(run(segs)).toEqual([]);
  });

  it("is less sensitive with the 'low' preset", () => {
    const quietSpeech: [number, number][] = [
      [0.002, 1000],
      [0.015, 800],
      [0.002, 1500],
    ];
    expect(run(quietSpeech, vadPreset("high")).map((e) => e.type)).toEqual(["speech-start", "speech-end"]);
    expect(run(quietSpeech, vadPreset("low"))).toEqual([]);
  });

  it("tolerates bad readings and resets", () => {
    const vad = new EnergyVad();
    expect(vad.process(Number.NaN, 0)).toBeNull();
    expect(vad.process(-1, 50)).toBeNull();
    for (let t = 100; t <= 300; t += 50) vad.process(0.2, t);
    expect(vad.inSpeech).toBe(true);
    vad.reset();
    expect(vad.inSpeech).toBe(false);
    expect(vad.noiseFloor).toBe(0);
  });
});
