// Where the next chat request goes: the backend (proxy, direct, echo), the provider inside it and the model.
// One function, so the request, the Settings drawer, the model picker and the export always agree.

import { directProviders, modelKey, type DirectProvider, type ProviderKind } from "../llm/providers.ts";
import type { BackendKind } from "../llm/types.ts";
import type { Settings } from "./settings.ts";
import type { ServerConfig } from "./useServerConfig.ts";

export interface ChatTarget {
  backend: BackendKind;
  /** the provider's id ("" for echo) */
  providerId: string;
  providerName: string;
  kind: ProviderKind | null;
  /** the key of this provider in settings.models ("" for echo) */
  modelKey: string;
  /** the provider's own default ("" when it has none) */
  defaultModel: string;
  /** what the request asks for: the user's choice, else the default ("" = none: the request is refused) */
  model: string;
  /** direct mode: the provider itself */
  direct: DirectProvider | null;
}

export function resolveBackend(choice: Settings["backend"], server: ServerConfig): BackendKind {
  if (choice === "direct" || choice === "echo") return choice;
  // "auto" and "proxy" use the proxy when the server has a provider (or while we do not know yet)
  return server.proxy || !server.loaded ? "proxy" : "echo";
}

export function chatTarget(settings: Settings, server: ServerConfig): ChatTarget {
  const backend = resolveBackend(settings.backend, server);
  if (backend === "echo") {
    return { backend, providerId: "", providerName: "", kind: null, modelKey: "", defaultModel: "", model: "", direct: null };
  }
  if (backend === "proxy") {
    const p =
      server.providers.find((x) => x.id === settings.proxyProvider) ??
      server.providers.find((x) => x.id === server.provider) ??
      server.providers[0];
    // before /api/config has answered: the server picks
    const id = p?.id ?? "";
    const key = modelKey("proxy", id || "default");
    const defaultModel = p ? p.defaultModel : server.defaultModel;
    return { backend, providerId: id, providerName: p?.name ?? "", kind: p?.kind ?? null, modelKey: key, defaultModel, model: settings.models[key] || defaultModel, direct: null };
  }
  const all = directProviders(settings.customProviders);
  const d = all.find((x) => x.id === settings.directProvider) ?? all[0];
  const key = modelKey("direct", d.id);
  return { backend, providerId: d.id, providerName: d.name, kind: d.kind, modelKey: key, defaultModel: d.defaultModel, model: settings.models[key] || d.defaultModel, direct: d };
}
