import { useEffect, useMemo, type ReactElement, type ReactNode } from "react";
import { CipetpetContext, type CipetpetConfig } from "./context.js";
import { modelKey, modelRegistry, type ModelConfig, type ModelKind, type ModelOptions } from "./registry.js";
import { noop, useLatest } from "./util.js";

export interface CipetpetProviderProps extends CipetpetConfig {
  /** start loading on mount: true = both models that have a source, or a list of kinds. Default false. */
  preload?: boolean | readonly ModelKind[];
  children?: ReactNode;
}

/**
 * Optional defaults for every cipetpet hook and component below it.
 *
 * ```tsx
 * <CipetpetProvider
 *   tts={{ source: "/packs/antalia-mini-int8.cpet" }}
 *   stt={{ source: "/packs/duyu-small-int8.cpet", useWorker: true }}
 *   preload={["stt"]}
 * >
 *   <App />
 * </CipetpetProvider>
 * ```
 */
export function CipetpetProvider({ tts, stt, disposeDelayMs, preload = false, children }: CipetpetProviderProps): ReactElement {
  const value = useMemo<CipetpetConfig>(() => ({ tts, stt, disposeDelayMs }), [tts, stt, disposeDelayMs]);
  const kinds: readonly ModelKind[] = preload === true ? ["tts", "stt"] : preload === false ? [] : preload;
  usePreload("tts", kinds.includes("tts") ? tts : undefined, disposeDelayMs);
  usePreload("stt", kinds.includes("stt") ? stt : undefined, disposeDelayMs);
  return <CipetpetContext.Provider value={value}>{children}</CipetpetContext.Provider>;
}

/** Holds a lease on (and loads) a model while the provider is mounted with that preload config. */
function usePreload(kind: ModelKind, options: ModelOptions | undefined, disposeDelayMs: number | undefined): void {
  const key = options?.source == null ? null : modelKey(kind, options as ModelConfig);
  const optionsRef = useLatest(options);
  const delayRef = useLatest(disposeDelayMs);
  useEffect(() => {
    if (key === null || !optionsRef.current) return;
    const lease = modelRegistry.acquire(kind, optionsRef.current as ModelConfig, {
      disposeDelayMs: delayRef.current,
      onProgress: (p) => optionsRef.current?.onProgress?.(p),
    });
    lease.load().catch(noop); // the error is in the model's state for the hooks to show
    return () => lease.release(delayRef.current);
  }, [kind, key, optionsRef, delayRef]);
}
