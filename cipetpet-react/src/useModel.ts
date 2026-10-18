// The low-level hooks: a component's view of one shared model in the registry.

import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { PackProgress } from "cipetpet";
import { CipetpetContext, configFor } from "./context.js";
import {
  IDLE_SNAPSHOT,
  modelKey,
  modelRegistry,
  type ModelConfig,
  type ModelKind,
  type ModelLease,
  type ModelOf,
  type ModelOptions,
  type ModelSnapshot,
  type ModelStatus,
  type SttModel,
  type TtsModel,
} from "./registry.js";
import { definedOnly, noop, useLatest } from "./util.js";

export interface ModelHookOptions extends ModelOptions {
  /** start loading as soon as the component mounts (default true); with false, call load() */
  autoLoad?: boolean;
  /** ms the model stays loaded after the last user unmounts (default: the provider's, else 1000) */
  disposeDelayMs?: number;
}

export interface ModelHandle<M> {
  status: ModelStatus;
  /** pack download progress ({loaded, total}; total is 0 when unknown), null before the first event */
  progress: PackProgress | null;
  error: Error | null;
  /** the shared model instance, once status is "ready" */
  model: M | null;
  /** starts loading (if not loaded / loading) and resolves with the model */
  load(): Promise<M>;
  /** loads again after an error */
  retry(): Promise<M>;
}

const noopUnsubscribe = () => noop;
const idleSnapshot = () => IDLE_SNAPSHOT;

/** Merges provider defaults with the hook's options (undefined hook fields do not override). */
function mergeOptions(base: ModelOptions | undefined, own: ModelOptions): ModelOptions {
  return { ...(base ? definedOnly(base) : {}), ...definedOnly(own) };
}

export function useModel<K extends ModelKind>(kind: K, options: ModelHookOptions = {}): ModelHandle<ModelOf<K>> {
  const ctx = useContext(CipetpetContext);
  const { autoLoad = true, disposeDelayMs, ...own } = options;
  const config = mergeOptions(configFor(ctx, kind), own);
  // The key is computed on every render but only *changes* when something that shapes the instance does,
  // so inline option objects never cause reloads.
  const key = config.source == null ? null : modelKey(kind, config as ModelConfig);

  const configRef = useLatest(config);
  // Only the hook's own onProgress: a provider-level one is called by the provider's preload.
  const onProgressRef = useLatest(own.onProgress);
  const delayRef = useLatest(disposeDelayMs ?? ctx?.disposeDelayMs);
  const keyRef = useLatest(key);
  const leaseRef = useRef<ModelLease<K> | null>(null);

  // Acquire in an effect (never during render: SSR and aborted concurrent renders must not load anything).
  useEffect(() => {
    if (key === null) return;
    const lease = modelRegistry.acquire(kind, configRef.current as ModelConfig, {
      disposeDelayMs: delayRef.current,
      onProgress: (p) => onProgressRef.current?.(p),
    });
    leaseRef.current = lease;
    return () => {
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release(delayRef.current);
    };
  }, [kind, key, configRef, delayRef, onProgressRef]);

  useEffect(() => {
    if (key !== null && autoLoad) leaseRef.current?.load().catch(noop);
  }, [key, autoLoad]);

  const subscribe = useCallback(
    (onChange: () => void) => (key === null ? noopUnsubscribe() : modelRegistry.subscribe(key, onChange)),
    [key],
  );
  const getSnapshot = useCallback(
    () => (key === null ? IDLE_SNAPSHOT : modelRegistry.getSnapshot<K>(key)),
    [key],
  ) as () => ModelSnapshot<ModelOf<K>>;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, idleSnapshot);

  const load = useCallback((): Promise<ModelOf<K>> => {
    const lease = leaseRef.current;
    if (lease) return lease.load();
    return Promise.reject(
      new Error(
        keyRef.current === null
          ? `cipetpet-react: no ${kind} model source: pass \`source\` or set \`${kind}.source\` on <CipetpetProvider>`
          : "cipetpet-react: the component is not mounted",
      ),
    );
  }, [kind, keyRef]);

  const retry = useCallback((): Promise<ModelOf<K>> => {
    const lease = leaseRef.current;
    return lease ? lease.retry() : load();
  }, [load]);

  return {
    status: snapshot.status,
    progress: snapshot.progress,
    error: snapshot.error,
    model: snapshot.model,
    load,
    retry,
  };
}

/** The text-to-speech model with its loading state: Antalia-2 Mini or EMA Lightning, whichever the pack holds. */
export function useAntalia(options?: ModelHookOptions): ModelHandle<TtsModel> {
  return useModel("tts", options);
}

/** The speech-recognition model (Duyu-small) with its loading state. */
export function useDuyu(options?: ModelHookOptions): ModelHandle<SttModel> {
  return useModel("stt", options);
}
