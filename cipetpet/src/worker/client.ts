import type { LoadOptions, ModelInfo, SpeechChunk, SynthesisOptions, SynthesisResult, TranscribeOptions, TranscriptionResult } from "../types.js";
import type { PackSource } from "../pack/types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

export interface WorkerOptions extends LoadOptions {
  /**
   * The worker to run the model in: a ready Worker, or the URL of the worker script. Default: the
   * `worker.js` that sits next to this module (dist/browser/worker.js for the CDN bundle).
   *
   * A browser refuses `new Worker(url)` for a script on another origin (a SecurityError). When the
   * resolved URL is cross-origin to the page, e.g. the bundle comes from jsDelivr, the worker is started
   * from a Blob URL whose module does `import "<that URL>"`; the script must then be served with CORS
   * headers (jsDelivr and unpkg do). Bundlers (Vite, webpack, ...) rewrite neither the default URL nor a
   * string: build the Worker with the bundler's own worker syntax and pass it here, give the URL of a
   * copy of `cipetpet/browser/worker.js` on your own origin, or load the CDN bundle instead.
   */
  worker?: Worker | URL | string;
}

export type WorkerSource = Exclude<PackSource, import("../pack/reader.js").Pack>;
type RequestWithoutId = Exclude<WorkerRequest, { type: "cancel" }> extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
}

export interface AntaliaWorker {
  readonly info: ModelInfo;
  readonly defaults: Readonly<{ steps: number; cfg: number; speed: number; temperature: number }>;
  normalize(text: string): Promise<string>;
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  stream(text: string, opts?: SynthesisOptions): AsyncGenerator<SpeechChunk, void, undefined>;
  dispose(): Promise<void>;
}

export interface DuyuWorker {
  readonly info: ModelInfo;
  transcribe(audio: Float32Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  dispose(): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (p: import("../pack/types.js").PackProgress) => void;
  onChunk?: (chunk: SpeechChunk) => void;
  cleanup?: () => void;
}

function errorFromMessage(msg: Extract<WorkerResponse, { type: "error" }>): Error {
  const error = new Error(msg.message);
  error.name = msg.name;
  if (msg.stack) error.stack = msg.stack;
  return error;
}

/** A started worker, and what to do when the client is done with it. */
export interface WorkerHandle {
  worker: Worker;
  /** revokes the Blob URL of a cross-origin shim (nothing to do otherwise) */
  release(): void;
  /** the cross-origin script behind a Blob shim, for error messages */
  shimmedFor?: string;
}

/** The absolute http(s) URL of a worker script when it is cross-origin to this page or worker, else undefined. */
function crossOriginScript(source: URL | string): string | undefined {
  const here = (globalThis as { location?: { href?: string; origin?: string } }).location;
  if (here?.origin === undefined) return undefined; // no page origin to compare with (Deno, Node ...): as before
  let url: URL;
  try {
    url = new URL(String(source), here.href);
  } catch {
    try {
      url = new URL(String(source)); // an opaque page (sandboxed frame, ...) may have no usable base URL
    } catch {
      return undefined; // not resolvable here: let `new Worker` report it
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined; // blob:, data:, file: ... as given
  return url.origin === here.origin ? undefined : url.href;
}

export function makeWorker(provided?: Worker | URL | string): WorkerHandle {
  if (typeof Worker === "undefined") throw new Error("cipetpet: Web Workers are not available in this environment");
  if (typeof provided === "object" && provided !== null && "postMessage" in provided) {
    return { worker: provided as Worker, release() {} };
  }
  const source = provided ?? new URL("./worker.js", import.meta.url);
  const remote = crossOriginScript(source);
  if (remote === undefined) return { worker: new Worker(source, { type: "module" }), release() {} };

  // `new Worker(crossOriginUrl)` throws a SecurityError. A same-origin Blob module that imports the real
  // script is allowed; the import itself is an ordinary CORS module fetch.
  const blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(remote)};\n`], { type: "text/javascript" }));
  const release = () => URL.revokeObjectURL(blobUrl);
  try {
    return { worker: new Worker(blobUrl, { type: "module" }), release, shimmedFor: remote };
  } catch (error) {
    release();
    throw error;
  }
}

class Client {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    readonly worker: Worker,
    private readonly release: () => void = () => {},
    private readonly shimmedFor?: string,
  ) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    worker.addEventListener("messageerror", this.onMessageError);
  }

  request<T>(
    request: RequestWithoutId,
    signal?: AbortSignal,
    onProgress?: (p: import("../pack/types.js").PackProgress) => void,
    transfer: Transferable[] = [],
    onChunk?: (chunk: SpeechChunk) => void,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("cipetpet: worker has been disposed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress,
        onChunk,
      };
      const abort = () => {
        this.worker.postMessage({ type: "cancel", id } satisfies WorkerRequest);
        this.pending.delete(id);
        pending.cleanup?.();
        reject(abortError(signal));
      };
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      try {
        this.worker.postMessage({ ...request, id } as WorkerRequest, transfer);
      } catch (error) {
        this.pending.delete(id);
        pending.cleanup?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
    this.worker.terminate();
    this.release();
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(new Error("cipetpet: worker was terminated"));
    }
    this.pending.clear();
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.(message.progress);
      return;
    }
    if (message.type === "chunk") {
      pending.onChunk?.(message.chunk);
      return;
    }
    this.pending.delete(message.id);
    pending.cleanup?.();
    if (message.type === "error") pending.reject(errorFromMessage(message));
    else if (message.type === "loaded") pending.resolve({ info: message.info, defaults: message.defaults });
    else pending.resolve(message.value);
  };

  private onError = (event: ErrorEvent): void => {
    const hint = this.shimmedFor ? ` (started through a Blob URL that imports ${this.shimmedFor}: that script must be reachable and served with CORS headers)` : "";
    this.failAll(new Error((event.message || "cipetpet: worker failed") + hint));
  };

  private onMessageError = (): void => {
    this.failAll(new Error("cipetpet: could not deserialize a worker message"));
  };

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class StreamQueue {
  private items: SpeechChunk[] = [];
  private waiters: { resolve(value: IteratorResult<SpeechChunk>): void; reject(error: Error): void }[] = [];
  private ended = false;
  private failure: Error | null = null;
  get isEnded(): boolean {
    return this.ended;
  }

  push(chunk: SpeechChunk): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: chunk });
    else this.items.push(chunk);
  }
  finish(error?: Error): void {
    this.ended = true;
    this.failure = error ?? null;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  }
  next(): Promise<IteratorResult<SpeechChunk>> {
    const value = this.items.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator](): AsyncIterator<SpeechChunk> {
    return this;
  }
}

/** `value` as an absolute URL against the page: a worker would resolve a relative one against its own script
 * (or against a blob: URL), and a URL object cannot be posted to it at all. */
function absoluteUrl(value: string | URL): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return new URL(String(value), base).href;
  } catch {
    return String(value);
  }
}

/** What goes to the worker in the "load" message: structured-cloneable, with URLs resolved on the page side. */
function prepareLoad(source: WorkerSource, loadOptions: Record<string, unknown>): { source: WorkerSource; options: Record<string, unknown> } {
  for (const name of ["fetch", "ort"]) {
    if (loadOptions[name] !== undefined) {
      throw new TypeError(`cipetpet: the "${name}" option cannot be used with a worker (functions and modules cannot be posted to it); load on the main thread, or drop the option`);
    }
  }
  const options = { ...loadOptions };
  if (typeof options.wasmPaths === "string") options.wasmPaths = absoluteUrl(options.wasmPaths);
  if (options.requestInit && typeof options.requestInit === "object") {
    const { signal: _signal, ...init } = options.requestInit as RequestInit; // an AbortSignal cannot be cloned; `signal` is handled on this side
    options.requestInit = init;
  }
  return { source: typeof source === "string" || source instanceof URL ? absoluteUrl(source) : source, options };
}

async function createClient(
  kind: "tts" | "stt",
  source: WorkerSource,
  options: WorkerOptions = {},
): Promise<{ client: Client; info: ModelInfo; defaults?: AntaliaWorker["defaults"] }> {
  const { worker: _worker, signal, onProgress, ...rest } = options;
  const load = prepareLoad(source, rest);
  const { worker, release, shimmedFor } = makeWorker(options.worker);
  const client = new Client(worker, release, shimmedFor);
  try {
    const loaded = await client.request<{ info: ModelInfo; defaults?: AntaliaWorker["defaults"] }>(
      { type: "load", kind, source: load.source, options: load.options },
      signal,
      onProgress,
    );
    return { client, ...loaded };
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function createAntaliaWorker(source: WorkerSource, opts: WorkerOptions = {}): Promise<AntaliaWorker> {
  const { client, info, defaults } = await createClient("tts", source, opts);
  let disposed: Promise<void> | undefined;
  return {
    info,
    defaults: defaults!,
    normalize: (text) => client.request<string>({ type: "call", method: "normalize", args: [text] }),
    synthesize: (text, options) =>
      client.request<SynthesisResult>(
        { type: "call", method: "synthesize", args: [text, { ...options, signal: undefined }] },
        options?.signal,
      ),
    async *stream(text, options) {
      const queue = new StreamQueue();
      const controller = new AbortController();
      const unlink = options?.signal
        ? (() => {
            const signal = options.signal;
            const abort = () => controller.abort(signal.reason);
            if (options.signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            return () => signal.removeEventListener("abort", abort);
          })()
        : () => {};
      const promise = client.request<void>(
        { type: "call", method: "stream", args: [text, { ...options, signal: undefined }] },
        controller.signal,
        undefined,
        [],
        (chunk) => queue.push(chunk),
      ).then(() => queue.finish(), (error: unknown) => queue.finish(error instanceof Error ? error : new Error(String(error))));
      try {
        while (true) {
          const next = await queue.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        if (!queue.isEnded) controller.abort();
        unlink();
        await promise.catch(() => {});
      }
    },
    dispose() {
      disposed ??= client.request<void>({ type: "dispose" }).finally(() => client.close());
      return disposed;
    },
  };
}

export async function createDuyuWorker(source: WorkerSource, opts: WorkerOptions = {}): Promise<DuyuWorker> {
  const { client, info } = await createClient("stt", source, opts);
  let disposed: Promise<void> | undefined;
  return {
    info,
    transcribe: (audio, options) => {
      // Posting a typed array copies (or, transferred, detaches) its WHOLE buffer. An array that is a view on
      // a larger buffer (a recorder's ring buffer, a slice of a 48 kHz capture) is therefore copied first, so
      // the caller's other views survive; only an array that spans its buffer is transferred, and detached.
      const own = audio instanceof Float32Array && audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength;
      const sent = audio instanceof Float32Array && !own ? audio.slice() : audio;
      return client.request<TranscriptionResult>(
        { type: "call", method: "transcribe", args: [sent, { ...options, signal: undefined }] },
        options?.signal,
        undefined,
        sent instanceof Float32Array && sent.buffer instanceof ArrayBuffer ? [sent.buffer] : [],
      );
    },
    dispose() {
      disposed ??= client.request<void>({ type: "dispose" }).finally(() => client.close());
      return disposed;
    },
  };
}
