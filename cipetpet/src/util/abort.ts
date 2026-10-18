/** Throws the signal's reason (an "AbortError" DOMException unless the caller gave another) once it is aborted. */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** true for the error an aborted signal throws (whatever reason it was given), or any AbortError */
export function isAbortError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted && err === signal.reason) return true;
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** One turn of the event loop (a MessageChannel round trip: unlike setTimeout it is not clamped to 4 ms). */
export function nextTask(): Promise<void> {
  if (typeof MessageChannel !== "function") return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

/** Like throwIfAborted, but with a signal the event loop runs once first. ORT's wasm backend runs a graph
 * synchronously inside run() and settles its promises as microtasks, so without this nothing else (a timer, a
 * worker's cancel message, a click) would get a turn during a whole transcription and an abort could never land. */
export async function checkAbort(signal?: AbortSignal | null): Promise<void> {
  if (!signal) return;
  await nextTask();
  throwIfAborted(signal);
}

/** Runs `fn` on `queue`. An abort while the call still waits for its turn rejects at once (with the signal's
 * reason, as throwIfAborted would); the queue slot then does nothing when its turn comes. */
export function runQueued<T>(queue: { run<R>(fn: () => Promise<R>): Promise<R> }, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) return queue.run(fn);
  let started = false;
  const task = queue.run(() => {
    throwIfAborted(signal);
    started = true;
    return fn();
  });
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (started) return; // running: fn observes the signal itself
      try {
        throwIfAborted(signal);
      } catch (e) {
        reject(e);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    task.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
