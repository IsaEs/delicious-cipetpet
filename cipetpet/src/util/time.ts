/** Milliseconds from a monotonic clock (performance.now exists in pages, workers and Node >= 16). */
export const now = (): number => performance.now();
