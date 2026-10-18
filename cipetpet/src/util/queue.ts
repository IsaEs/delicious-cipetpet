/** Runs async tasks one at a time, in the order they were queued. An ORT session must not run two
 * inferences at once, so each model instance funnels its calls through one of these. A failed task
 * rejects its own promise only; the tasks queued after it still run. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => void this.pending--,
      () => void this.pending--,
    );
    return result;
  }

  /** tasks queued or running */
  get size(): number {
    return this.pending;
  }

  /** resolves once every task queued so far has settled */
  idle(): Promise<void> {
    return this.tail.then(() => {});
  }
}
