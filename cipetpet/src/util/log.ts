const warned = new Set<string>();

/** console.warn a message the first time `key` is seen in this realm; later calls with the same key are silent. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`cipetpet: ${message}`);
}
