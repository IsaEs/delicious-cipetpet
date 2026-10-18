// Small helpers shared by the hooks. Nothing here touches window / navigator at import time.

import { useRef } from "react";

export const noop = (): void => {};

export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  // a DOMException from another realm (or an old engine) is error-like without being instanceof Error
  if (typeof e === "object" && e !== null && typeof (e as Error).name === "string" && typeof (e as Error).message === "string") {
    return e as Error;
  }
  return new Error(String(e));
}

export function abortError(message = "The operation was aborted"): Error {
  // DOMException is global in browsers, workers and Node >= 17
  return typeof DOMException === "function"
    ? new DOMException(message, "AbortError")
    : Object.assign(new Error(message), { name: "AbortError" });
}

export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

/** Makes `controller` abort when `source` aborts. Returns a function that removes the link. */
export function linkSignal(source: AbortSignal | undefined, controller: AbortController): () => void {
  if (!source) return noop;
  if (source.aborted) {
    controller.abort(source.reason);
    return noop;
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/** Copies the own enumerable properties whose value is not undefined (so `{speed: undefined}` does not
 * override a default). */
export function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

/** A ref that always holds the value of the latest render (for reading props from stable callbacks). */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** requestAnimationFrame where it exists (browsers), a 16 ms timer elsewhere. Returns a cancel function. */
export function scheduleFrame(cb: () => void): () => void {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number; cancelAnimationFrame?: (id: number) => void };
  if (typeof g.requestAnimationFrame === "function" && typeof g.cancelAnimationFrame === "function") {
    const id = g.requestAnimationFrame(cb);
    return () => g.cancelAnimationFrame!(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}
