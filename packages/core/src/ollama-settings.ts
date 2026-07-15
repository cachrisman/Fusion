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

/*
FNXC:OllamaEndpointAuth 2026-07-15-00:00:
Native Ollama endpoint credentials live in protected auth storage, not in the
machine-global `ollama` settings object. This internal storage identity is
shared by the dashboard probe and engine stream paths; it is not a model
provider identity and must never become a generic Authentication API-key row.
*/
export const OLLAMA_ENDPOINT_AUTH_PROVIDER_ID = "ollama-endpoint-auth";

/** An opaque auth-storage payload binding a protected endpoint token to one normalized endpoint. */
export interface OllamaEndpointAuthCredential {
  endpoint: string;
  token: string;
}

/*
FNXC:OllamaEndpointAuth 2026-07-15-00:00:
The optional native token must be bound to the endpoint it authorizes. A
failed connection attempt must not replace the token used by the still-active
endpoint, and an active session must never forward a token to a different URL.
This serialized value stays only in protected auth storage, never settings.
*/
export function serializeOllamaEndpointAuthCredential(credential: OllamaEndpointAuthCredential): string {
  return JSON.stringify(credential);
}

/** Returns only valid endpoint-bound credentials; legacy unbound tokens are intentionally unusable. */
export function parseOllamaEndpointAuthCredential(value: unknown): OllamaEndpointAuthCredential | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.endpoint !== "string" || parsed.endpoint.length === 0 || typeof parsed.token !== "string" || parsed.token.length === 0) {
      return undefined;
    }
    return { endpoint: parsed.endpoint, token: parsed.token };
  } catch {
    return undefined;
  }
}

/** Resolves a token only when the request targets precisely its stored endpoint binding. */
export function resolveOllamaEndpointAuthToken(value: unknown, endpoint: string): string | undefined {
  const credential = parseOllamaEndpointAuthCredential(value);
  return credential?.endpoint === endpoint ? credential.token : undefined;
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
