// A module-level cache of loaded models, so every component that asks for the same model shares ONE
// instance (a model is 20-60 MB of weights plus ORT sessions).
//
// * Key: kind + pack source + the load options that shape the instance (backend, threads, useWorker …).
//   Strings / URLs are keyed by value; ArrayBuffers, typed arrays, Blobs, Packs, Workers and other objects by
//   identity (a WeakMap id). Functions (onProgress, fetch) and the abort signal are not part of the key.
// * Refcounted: acquire() returns a lease; when the last lease is released the model is disposed after a
//   grace period (default 1000 ms), so React StrictMode's mount -> unmount -> mount and quick remounts reuse
//   the instance instead of reloading it.
// * Observable: subscribe(key) / getSnapshot(key) are shaped for useSyncExternalStore.
// * Errors are not cached: load() / retry() after an error (or a new entry after disposal) loads again.

import { AntaliaMini, DuyuSmall, createAntaliaWorker, createDuyuWorker } from "cipetpet";
import type { LoadOptions, PackProgress, PackSource } from "cipetpet";
import { abortError, noop, now, toError } from "./util.js";

export type ModelKind = "tts" | "stt";

/** The worker client types, derived from the factories (the root entry is only guaranteed to export the
 * functions). */
export type AntaliaWorker = Awaited<ReturnType<typeof createAntaliaWorker>>;
export type DuyuWorker = Awaited<ReturnType<typeof createDuyuWorker>>;
export type WorkerOptions = NonNullable<Parameters<typeof createAntaliaWorker>[1]>;
/** What useWorker accepts as a source (an open Pack cannot cross the worker boundary). */
export type WorkerSource = Parameters<typeof createAntaliaWorker>[0];

/** A text-to-speech model: in-thread or in a Web Worker (same API, except normalize() is async there). */
export type TtsModel = AntaliaMini | AntaliaWorker;
/** A speech-recognition model: in-thread or in a Web Worker. */
export type SttModel = DuyuSmall | DuyuWorker;
export type ModelOf<K extends ModelKind> = K extends "tts" ? TtsModel : SttModel;

export type ModelStatus = "idle" | "loading" | "ready" | "error";

/** How to load one model: the pack plus cipetpet's LoadOptions (minus `signal`, which the registry owns). */
export interface ModelOptions extends Omit<LoadOptions, "signal"> {
  /** the .cpet pack: a URL, its bytes, a Blob / File, or an open Pack (not with useWorker) */
  source?: PackSource;
  /** run the model in a dedicated Web Worker (createAntaliaWorker / createDuyuWorker); default false */
  useWorker?: boolean;
  /** with useWorker: the worker (or its script URL) to use instead of the core's default worker.js */
  worker?: WorkerOptions["worker"];
}

/** ModelOptions with the source set. */
export interface ModelConfig extends ModelOptions {
  source: PackSource;
}

export interface ModelSnapshot<M = unknown> {
  status: ModelStatus;
  /** pack download progress while loading (and the last value after); null before any progress event */
  progress: PackProgress | null;
  error: Error | null;
  /** the loaded model when status is "ready" */
  model: M | null;
}

export const IDLE_SNAPSHOT: ModelSnapshot<never> = Object.freeze({
  status: "idle",
  progress: null,
  error: null,
  model: null,
}) as ModelSnapshot<never>;

export const DEFAULT_DISPOSE_DELAY_MS = 1000;

/** A claim on a shared model. Release it exactly once (extra calls are ignored). */
export interface ModelLease<K extends ModelKind = ModelKind> {
  readonly key: string;
  readonly kind: K;
  getSnapshot(): ModelSnapshot<ModelOf<K>>;
  /** starts loading if idle or failed; resolves with the model (shared by every lease of this key) */
  load(): Promise<ModelOf<K>>;
  /** load again after an error (same as load(): a failed load is never cached) */
  retry(): Promise<ModelOf<K>>;
  /** gives the claim back; `disposeDelayMs` overrides the delay chosen at acquire() */
  release(disposeDelayMs?: number): void;
}

export interface AcquireOptions {
  /** ms to keep the model after the last release (default: the registry's, 1000). <= 0 disposes at once,
   * Infinity keeps it until clear(). */
  disposeDelayMs?: number;
  /** progress of the pack download, for this lease */
  onProgress?: (p: PackProgress) => void;
}

// ------------------------------------------------------------------------------------------ keys

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function identity(o: object): number {
  let id = identities.get(o);
  if (id === undefined) {
    id = nextIdentity++;
    identities.set(o, id);
  }
  return id;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A JSON-able, order-independent description of a value; undefined for parts that are left out. */
function keyPart(v: unknown): unknown {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v !== "object") return typeof v === "bigint" ? `${v}n` : v;
  if (typeof URL !== "undefined" && v instanceof URL) return { url: v.href };
  if (Array.isArray(v)) return v.map((x) => keyPart(x) ?? null);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const p = keyPart((v as Record<string, unknown>)[k]);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  // bytes, Blob / File, Pack, Worker, an ort module, Headers …: by identity
  return { ref: identity(v) };
}

/** The registry key of a model: kind + source + the options that affect the instance. */
export function modelKey(kind: ModelKind, config: ModelConfig): string {
  // onProgress / fetch are functions (dropped by keyPart); signal is owned by the registry
  const { source, signal: _signal, onProgress: _onProgress, ...rest } = config as ModelConfig & { signal?: unknown };
  const src = typeof source === "string" ? source : keyPart(source);
  return `${kind}|${JSON.stringify(src)}|${JSON.stringify(keyPart(rest))}`;
}

// ------------------------------------------------------------------------------------------ loading

function isWorkerSource(s: PackSource): s is WorkerSource {
  return (
    typeof s === "string" ||
    (typeof URL !== "undefined" && s instanceof URL) ||
    s instanceof ArrayBuffer ||
    s instanceof Uint8Array ||
    (typeof Blob !== "undefined" && s instanceof Blob)
  );
}

/** Worker instances already handed to a model, with the error of a load that failed on them (that load
 * terminated the worker, so a retry cannot reuse it and should still say what went wrong first). */
const usedWorkers = new WeakMap<object, { failure?: unknown }>();

function isWorkerInstance(worker: WorkerOptions["worker"]): worker is Worker {
  return (
    typeof worker === "object" &&
    worker !== null &&
    "postMessage" in worker &&
    typeof Reflect.get(worker, "postMessage") === "function" &&
    "terminate" in worker &&
    typeof Reflect.get(worker, "terminate") === "function"
  );
}

function loadModel<K extends ModelKind>(
  kind: K,
  config: ModelConfig,
  signal: AbortSignal,
  onProgress: (p: PackProgress) => void,
): Promise<ModelOf<K>> {
  const { source, useWorker, worker, onProgress: _own, ...rest } = config;
  const opts: LoadOptions = { ...rest, signal, onProgress };
  if (useWorker) {
    if (!isWorkerSource(source)) {
      return Promise.reject(
        new TypeError("cipetpet-react: useWorker needs a URL, string, ArrayBuffer, Uint8Array or Blob source (not an open Pack)"),
      );
    }
    if (isWorkerInstance(worker)) {
      const used = usedWorkers.get(worker);
      if (used) {
        const why = used.failure === undefined ? "" : ` (the load before it failed: ${used.failure instanceof Error ? used.failure.message : String(used.failure)})`;
        return Promise.reject(
          new TypeError(`cipetpet-react: a Worker instance can only be used once; pass a worker URL/string instead${why}`, { cause: used.failure }),
        );
      }
      usedWorkers.set(worker, {});
    }
    const wopts: WorkerOptions = worker === undefined ? opts : { ...opts, worker };
    const loading = (kind === "tts" ? createAntaliaWorker(source, wopts) : createDuyuWorker(source, wopts)) as Promise<ModelOf<K>>;
    if (isWorkerInstance(worker)) {
      loading.catch((failure: unknown) => {
        const used = usedWorkers.get(worker);
        if (used) used.failure = failure;
      });
    }
    return loading;
  }
  return (kind === "tts" ? AntaliaMini.load(source, opts) : DuyuSmall.load(source, opts)) as Promise<ModelOf<K>>;
}

function disposeQuietly(model: { dispose(): Promise<void> }): void {
  try {
    model.dispose().catch(noop);
  } catch {
    // a dispose that throws synchronously: nothing more to do
  }
}

/** progress events can arrive per network chunk; publish at most one per PROGRESS_INTERVAL_MS (plus the last) */
const PROGRESS_INTERVAL_MS = 50;

// ------------------------------------------------------------------------------------------ entries

class Entry<K extends ModelKind> {
  refs = 0;
  disposed = false;
  snapshot: ModelSnapshot<ModelOf<K>> = IDLE_SNAPSHOT;
  disposeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly progressListeners = new Set<(p: PackProgress) => void>();
  private pending: Promise<ModelOf<K>> | null = null;
  private controller: AbortController | null = null;
  /** bumps on every load and on dispose, so a superseded load cannot publish its result */
  private generation = 0;

  constructor(
    private readonly registry: ModelRegistry,
    readonly kind: K,
    readonly key: string,
    readonly config: ModelConfig,
  ) {}

  private set(next: Partial<ModelSnapshot<ModelOf<K>>>): void {
    this.snapshot = { ...this.snapshot, ...next };
    this.registry.emit(this.key);
  }

  load(): Promise<ModelOf<K>> {
    if (this.disposed) return Promise.reject(new Error("cipetpet-react: this model was released"));
    const { status, model } = this.snapshot;
    if (status === "ready" && model) return Promise.resolve(model);
    if (this.pending) return this.pending;

    const gen = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ status: "loading", progress: null, error: null, model: null });

    let lastEmit = -Infinity;
    let latest: PackProgress | null = null;
    const onProgress = (p: PackProgress) => {
      if (gen !== this.generation) return;
      latest = { loaded: p.loaded, total: p.total };
      for (const l of this.progressListeners) {
        try {
          l(latest);
        } catch {
          // a listener's bug must not break the load
        }
      }
      const t = now();
      const done = p.total > 0 && p.loaded >= p.total;
      if (done || t - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = t;
        this.set({ progress: latest });
      }
    };

    const promise = loadModel(this.kind, this.config, controller.signal, onProgress).then(
      (loaded) => {
        if (gen !== this.generation || this.disposed) {
          // released (or superseded) while loading, and the loader ignored the abort: free it
          disposeQuietly(loaded);
          throw abortError("cipetpet-react: the model was released while loading");
        }
        this.pending = null;
        this.controller = null;
        this.set({ status: "ready", model: loaded, error: null, progress: latest ?? this.snapshot.progress });
        return loaded;
      },
      (e: unknown) => {
        if (gen === this.generation && !this.disposed) {
          this.pending = null;
          this.controller = null;
          this.set({ status: "error", error: toError(e), model: null });
        }
        throw e;
      },
    );
    this.pending = promise;
    return promise;
  }

  /** frees the model (or aborts its load); the entry is dead afterwards */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearTimeout(this.disposeTimer);
    this.controller?.abort(abortError("cipetpet-react: the model was released while loading"));
    this.controller = null;
    this.pending = null;
    const model = this.snapshot.model;
    this.snapshot = IDLE_SNAPSHOT;
    this.progressListeners.clear();
    if (model) disposeQuietly(model);
  }
}

// ------------------------------------------------------------------------------------------ registry

export class ModelRegistry {
  /** ms a model is kept after its last release, when acquire() does not say otherwise */
  defaultDisposeDelayMs = DEFAULT_DISPOSE_DELAY_MS;
  private readonly entries = new Map<string, Entry<ModelKind>>();
  private readonly listeners = new Map<string, Set<() => void>>();

  key(kind: ModelKind, config: ModelConfig): string {
    return modelKey(kind, config);
  }

  /** for useSyncExternalStore; listeners may subscribe before (and outlive) the entry */
  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(key);
    };
  }

  getSnapshot<K extends ModelKind>(key: string): ModelSnapshot<ModelOf<K>> {
    return (this.entries.get(key)?.snapshot ?? IDLE_SNAPSHOT) as ModelSnapshot<ModelOf<K>>;
  }

  /** @internal called by entries when their snapshot changes */
  emit(key: string): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const l of [...set]) l();
  }

  /** Claims the model for `config` (creating the entry, without loading it). */
  acquire<K extends ModelKind>(kind: K, config: ModelConfig, opts: AcquireOptions = {}): ModelLease<K> {
    if (config.source == null) throw new TypeError("cipetpet-react: a model needs a `source` (the .cpet pack)");
    const key = modelKey(kind, config);
    const frozen: ModelConfig = { ...config };
    const onProgress = opts.onProgress;

    const claim = (): Entry<K> => {
      let entry = this.entries.get(key) as Entry<K> | undefined;
      if (!entry) {
        entry = new Entry(this, kind, key, frozen);
        this.entries.set(key, entry as unknown as Entry<ModelKind>);
      }
      entry.refs++;
      clearTimeout(entry.disposeTimer);
      entry.disposeTimer = undefined;
      if (onProgress) entry.progressListeners.add(onProgress);
      return entry;
    };

    let e = claim();
    let released = false;
    // After clear() the claimed entry is dead; a lease that is still held then claims a fresh one on its
    // next load, so mounted components keep working (they reload on demand).
    const live = (): Entry<K> => {
      if (e.disposed) e = claim();
      return e;
    };
    const load = (): Promise<ModelOf<K>> =>
      released ? Promise.reject(new Error("cipetpet-react: this lease was released")) : live().load();

    return {
      key,
      kind,
      getSnapshot: () => (e.disposed ? IDLE_SNAPSHOT : e.snapshot),
      load,
      retry: load,
      release: (delay?: number) => {
        if (released) return;
        released = true;
        if (onProgress) e.progressListeners.delete(onProgress);
        if (e.disposed) return;
        e.refs--;
        if (e.refs > 0) return;
        const entry = e;
        const ms = delay ?? opts.disposeDelayMs ?? this.defaultDisposeDelayMs;
        if (ms === Infinity) return; // kept until clear()
        if (!(ms > 0)) {
          this.drop(entry);
          return;
        }
        entry.disposeTimer = setTimeout(() => {
          entry.disposeTimer = undefined;
          if (entry.refs === 0) this.drop(entry);
        }, ms);
      },
    };
  }

  /** Disposes every model now. Leases still held load a fresh instance on their next load(). */
  clear(): void {
    for (const e of [...this.entries.values()]) this.drop(e);
  }

  /** number of live entries (for tests and debugging) */
  get size(): number {
    return this.entries.size;
  }

  private drop(e: Entry<ModelKind>): void {
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    const wasIdle = e.snapshot === IDLE_SNAPSHOT;
    e.dispose();
    if (!wasIdle) this.emit(e.key);
  }
}

/** The shared registry every hook and the provider use. */
export const modelRegistry = new ModelRegistry();

/** Disposes every cached model right away (e.g. to free memory, or between tests). */
export function clearModelCache(): void {
  modelRegistry.clear();
}
