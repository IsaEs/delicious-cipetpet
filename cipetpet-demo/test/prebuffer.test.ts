// The self-tuning start-up buffer: silence before a reply grows after a gap the voice caused, shrinks after clean
// replies, ignores gaps that came from waiting for the language model, and is capped.
import { describe, expect, it } from "vitest";
import { Prebuffer, PREBUFFER_MAX } from "../src/voice/prebuffer.ts";

const LEAD = 0.05;

describe("Prebuffer", () => {
  it("a fast device never adds latency", () => {
    const p = new Prebuffer();
    expect(p.beforeChunk(10, 10, LEAD, true)).toBe(0); // first chunk of a reply
    expect(p.beforeChunk(10.5, 12, LEAD, false)).toBe(0); // still playing: joins the queue
    p.finished();
    expect(p.seconds).toBe(0);
  });

  it("a gap the voice caused raises the delay by what was missing (+ margin), and pauses once there", () => {
    const saved: number[] = [];
    const p = new Prebuffer(0, (s) => saved.push(s));
    p.beforeChunk(0, 0, LEAD, true);
    // the first sentence ended at 0.8 s, the next chunk arrives at 1.3 s: 0.55 s short
    const pad = p.beforeChunk(1.3, 0.8, LEAD, false);
    expect(pad).toBeCloseTo(0.65, 3);
    expect(p.seconds).toBeCloseTo(0.65, 3);
    expect(saved).toEqual([0.65]);
    p.finished(); // ran dry: no decay
    expect(p.seconds).toBeCloseTo(0.65, 3);
    // the next reply starts with that delay
    expect(p.beforeChunk(5, 5, LEAD, true)).toBeCloseTo(0.65, 3);
  });

  it("a gap that came from waiting for the language model teaches nothing", () => {
    const p = new Prebuffer(0.3);
    p.beforeChunk(0, 0, LEAD, true);
    expect(p.beforeChunk(4, 2, LEAD, true)).toBe(0.3);
    expect(p.seconds).toBe(0.3);
  });

  it("clean replies shrink it back to 0; Stop learns nothing; it is capped and sanitised", () => {
    const p = new Prebuffer(0.5);
    for (let i = 0; i < 40; i++) {
      p.beforeChunk(i, i, LEAD, true);
      p.finished();
    }
    expect(p.seconds).toBe(0);

    const q = new Prebuffer(0.4);
    q.beforeChunk(0, 0, LEAD, true);
    q.stopped();
    expect(q.seconds).toBe(0.4);

    const r = new Prebuffer();
    r.beforeChunk(0, 0, LEAD, true);
    r.beforeChunk(9, 1, LEAD, false);
    expect(r.seconds).toBe(PREBUFFER_MAX);
    expect(new Prebuffer(Number.NaN).seconds).toBe(0);
    expect(new Prebuffer(99).seconds).toBe(PREBUFFER_MAX);
  });
});
