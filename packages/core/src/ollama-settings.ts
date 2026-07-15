/*
FNXC:OllamaProvider 2026-07-15-00:00:
FUSI-099 keeps Ollama as Fusion-owned native `/api/*` configuration. These
machine-global values and safe discovery records are deliberately separate from
CustomProvider so existing OpenAI-compatible records are never migrated or
reinterpreted as named Ollama configuration.
*/
export interface OllamaModelMetadata {
  /** Canonical native Ollama model tag used in `ollama/<id>` selections. */
  id: string;
  /** Operator-facing model name; currently the normalized native tag. */
  name: string;
  /** Safe tag metadata returned by `/api/tags`; never includes an arbitrary response blob. */
  digest?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  /** Safe, normalized capabilities returned only by a successful `/api/show`. */
  capabilities: string[];
  /** True only when a successful native `/api/show` reports the `tools` capability. */
  toolCallingVerified: boolean;
}

export interface OllamaSettings {
  enabled: boolean;
  endpoint: string;
  think: boolean;
  numCtx: number;
  models: OllamaModelMetadata[];
  /** Executor use additionally requires exact-model verified native tools. */
  executorEnabled: boolean;
}

export const DEFAULT_OLLAMA_SETTINGS: OllamaSettings = {
  enabled: false,
  endpoint: "http://localhost:11434",
  think: false,
  numCtx: 32768,
  models: [],
  executorEnabled: false,
};

/** Resolves partial/legacy persisted values without modifying Custom Providers. */
export function resolveOllamaSettings(value: Partial<OllamaSettings> | undefined | null): OllamaSettings {
  return {
    ...DEFAULT_OLLAMA_SETTINGS,
    ...value,
    models: Array.isArray(value?.models) ? value.models : [],
  };
}
