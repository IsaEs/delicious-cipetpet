// Shared test helpers.

export const enc = new TextEncoder();

/** a ReadableStream that hands out exactly these chunks */
export function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** splits bytes at the given offsets */
export function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const o of [...offsets, bytes.length]) {
    out.push(bytes.slice(prev, o));
    prev = o;
  }
  return out;
}

export function sseResponse(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  return new Response(streamOf(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** waits until `cond` holds (polling), or fails after `timeout` ms */
export async function until(cond: () => boolean, timeout = 3000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** a clearly fake key for tests: never a real credential */
export const FAKE_KEY = "sk-or-v1-TEST-ONLY-0000000000000000000000000000000000000000000000000000";
