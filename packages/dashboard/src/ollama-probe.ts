import type { OllamaModelMetadata } from "@fusion/core";

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERED_MODELS = 100;
const MAX_CAPABILITIES = 20;

export interface OllamaDiscoveryResult {
  endpoint: string;
  models: OllamaModelMetadata[];
}

type OllamaTag = {
  name?: unknown;
  model?: unknown;
  digest?: unknown;
  size?: unknown;
  modified_at?: unknown;
};

type OllamaShowResponse = { capabilities?: unknown };

/**
 * Returns a root/proxy endpoint suitable for native Ollama `/api/*` calls.
 * Browser clients never submit credentials, query strings, or hash fragments.
 */
export function normalizeOllamaEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Ollama endpoint must be a non-empty HTTP(S) URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Ollama endpoint must be a valid HTTP(S) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama endpoint must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Ollama endpoint cannot include credentials, a query, or a fragment");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function nativeApiUrl(endpoint: string, path: string): string {
  return new URL(path.replace(/^\//, ""), `${endpoint}/`).toString();
}

function safeString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function safePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const capability = safeString(entry, 64)?.toLowerCase();
    if (!capability || seen.has(capability)) continue;
    seen.add(capability);
    result.push(capability);
    if (result.length >= MAX_CAPABILITIES) break;
  }
  return result;
}

function toTagMetadata(tag: OllamaTag): Omit<OllamaModelMetadata, "capabilities" | "toolCallingVerified"> | null {
  const id = safeString(tag.name) ?? safeString(tag.model);
  if (!id) return null;
  return {
    id,
    name: id,
    ...(safeString(tag.digest) ? { digest: safeString(tag.digest) } : {}),
    ...(safePositiveNumber(tag.size) !== undefined ? { sizeBytes: safePositiveNumber(tag.size) } : {}),
    ...(safeString(tag.modified_at) ? { modifiedAt: safeString(tag.modified_at) } : {}),
  };
}

async function fetchNativeJson(endpoint: string, path: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(nativeApiUrl(endpoint, path), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error("Ollama discovery timed out");
    }
    throw new Error("Could not connect to the Ollama endpoint");
  }

  if (!response.ok) {
    throw new Error(`Ollama endpoint returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Ollama endpoint returned invalid JSON");
  }
}

async function fetchModelCapabilities(endpoint: string, model: string, signal: AbortSignal): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(nativeApiUrl(endpoint, "api/show"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model }),
      signal,
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  try {
    const payload = await response.json() as OllamaShowResponse;
    return normalizeCapabilities(payload.capabilities);
  } catch {
    return [];
  }
}

/**
 * FNXC:OllamaProvider 2026-07-15-00:00:
 * FUSI-099 discovers only safe native `/api/tags` + `/api/show` fields. A
 * failed show request never guesses tool support, and this never reads or
 * transforms existing Custom Provider records.
 */
export async function discoverOllamaModels(inputEndpoint: unknown): Promise<OllamaDiscoveryResult> {
  const endpoint = normalizeOllamaEndpoint(inputEndpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const tagsPayload = await fetchNativeJson(endpoint, "api/tags", controller.signal) as { models?: unknown };
    if (!Array.isArray(tagsPayload.models)) {
      throw new Error("Ollama endpoint returned an invalid tags response");
    }

    const tags: Array<Omit<OllamaModelMetadata, "capabilities" | "toolCallingVerified">> = [];
    const seen = new Set<string>();
    for (const rawTag of tagsPayload.models) {
      if (!rawTag || typeof rawTag !== "object") continue;
      const tag = toTagMetadata(rawTag as OllamaTag);
      if (!tag || seen.has(tag.id)) continue;
      seen.add(tag.id);
      tags.push(tag);
      if (tags.length >= MAX_DISCOVERED_MODELS) break;
    }

    const models = await Promise.all(tags.map(async (tag) => {
      const capabilities = await fetchModelCapabilities(endpoint, tag.id, controller.signal);
      return {
        ...tag,
        capabilities,
        toolCallingVerified: capabilities.includes("tools"),
      } satisfies OllamaModelMetadata;
    }));

    return { endpoint, models };
  } finally {
    clearTimeout(timeout);
  }
}
