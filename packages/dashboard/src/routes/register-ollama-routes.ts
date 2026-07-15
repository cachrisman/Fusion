import {
  OLLAMA_ENDPOINT_AUTH_PROVIDER_ID,
  resolveOllamaEndpointAuthToken,
  resolveOllamaSettings,
  serializeOllamaEndpointAuthCredential,
  type OllamaSettings,
} from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import { discoverOllamaModels, normalizeOllamaEndpoint } from "../ollama-probe.js";
import type { AuthStorageLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";

type OllamaRouteStore = {
  getGlobalSettingsStore: () => { getSettings: () => Promise<{ ollama?: OllamaSettings }> };
  updateGlobalSettings: (patch: { ollama: OllamaSettings }) => Promise<unknown>;
};

type EndpointAuthUpdate =
  | { action: "save"; token: string }
  | { action: "clear" }
  | undefined;

function parseConfig(body: unknown, current: OllamaSettings): OllamaSettings {
  if (!body || typeof body !== "object") throw badRequest("request body must be an object");
  const input = body as Record<string, unknown>;
  const next: OllamaSettings = { ...current };
  if (input.endpoint !== undefined) next.endpoint = normalizeOllamaEndpoint(input.endpoint);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw badRequest("enabled must be a boolean");
    next.enabled = input.enabled;
  }
  if (input.think !== undefined) {
    if (typeof input.think !== "boolean") throw badRequest("think must be a boolean");
    next.think = input.think;
  }
  if (input.executorEnabled !== undefined) {
    if (typeof input.executorEnabled !== "boolean") throw badRequest("executorEnabled must be a boolean");
    next.executorEnabled = input.executorEnabled;
  }
  if (input.numCtx !== undefined) {
    if (!Number.isInteger(input.numCtx) || (input.numCtx as number) < 1024 || (input.numCtx as number) > 1_048_576) {
      throw badRequest("numCtx must be an integer between 1024 and 1048576");
    }
    next.numCtx = input.numCtx as number;
  }
  return next;
}

function parseEndpointAuthUpdate(body: unknown): EndpointAuthUpdate {
  if (!body || typeof body !== "object") return undefined;
  const input = body as Record<string, unknown>;
  const hasToken = input.endpointAuthToken !== undefined;
  const hasClear = input.clearEndpointAuth !== undefined;
  if (hasToken && hasClear) throw badRequest("endpoint auth save and clear cannot be combined");
  if (hasToken) {
    if (typeof input.endpointAuthToken !== "string" || input.endpointAuthToken.trim().length === 0) {
      throw badRequest("endpoint auth token must be a non-empty string");
    }
    return { action: "save", token: input.endpointAuthToken.trim() };
  }
  if (hasClear) {
    if (input.clearEndpointAuth !== true) throw badRequest("clearEndpointAuth must be true");
    return { action: "clear" };
  }
  return undefined;
}

async function readOllama(store: OllamaRouteStore): Promise<OllamaSettings> {
  return resolveOllamaSettings((await store.getGlobalSettingsStore().getSettings()).ollama);
}

async function saveOllama(store: OllamaRouteStore, settings: OllamaSettings): Promise<OllamaSettings> {
  await store.updateGlobalSettings({ ollama: settings });
  invalidateAllGlobalSettingsCaches();
  return settings;
}

async function readEndpointAuthToken(authStorage: AuthStorageLike | undefined, endpoint: string): Promise<string | undefined> {
  const stored = await authStorage?.getApiKey?.(OLLAMA_ENDPOINT_AUTH_PROVIDER_ID);
  return resolveOllamaEndpointAuthToken(stored, endpoint);
}

async function resolveProbeEndpointAuthToken(
  authStorage: AuthStorageLike | undefined,
  endpoint: string,
  update: EndpointAuthUpdate,
): Promise<string | undefined> {
  if (update?.action === "save") return update.token;
  if (update?.action === "clear") return undefined;
  return readEndpointAuthToken(authStorage, endpoint);
}

function applyEndpointAuthUpdate(authStorage: AuthStorageLike | undefined, endpoint: string, update: EndpointAuthUpdate): void {
  if (!update) return;
  if (update.action === "save") {
    if (!authStorage?.setApiKey) throw new ApiError(500, "Ollama endpoint credential storage is unavailable");
    authStorage.setApiKey(OLLAMA_ENDPOINT_AUTH_PROVIDER_ID, serializeOllamaEndpointAuthCredential({ endpoint, token: update.token }));
  } else {
    if (!authStorage?.clearApiKey) throw new ApiError(500, "Ollama endpoint credential storage is unavailable");
    authStorage.clearApiKey(OLLAMA_ENDPOINT_AUTH_PROVIDER_ID);
  }
}

async function statusResponse(ollama: OllamaSettings, authStorage: AuthStorageLike | undefined) {
  return {
    ollama,
    endpointAuthConfigured: Boolean(await readEndpointAuthToken(authStorage, ollama.endpoint)),
    ready: ollama.enabled && ollama.models.length > 0,
  };
}

/**
 * FNXC:OllamaEndpointAuth 2026-07-15-00:00:
 * A local native endpoint is valid with no credential. The SDK's
 * `ollama-native` registry placeholder is never read here: an operator token
 * has its own protected auth-storage ID, is redacted to configured/not-configured
 * in responses, and is passed server-to-server only for native probes. Its
 * serialized secret is endpoint-bound, so a failed endpoint change cannot
 * redirect credentials from the active endpoint.
 */
export const registerOllamaRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, options, rethrowAsApiError } = ctx;
  const authStorage = options?.authStorage;
  const requireStore = (): OllamaRouteStore => {
    if (!store) throw new ApiError(500, "Settings store unavailable");
    return store as unknown as OllamaRouteStore;
  };

  router.get("/ollama/status", async (_req, res) => {
    try {
      res.json(await statusResponse(await readOllama(requireStore()), authStorage));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.put("/ollama/config", async (req, res) => {
    try {
      const target = requireStore();
      const endpointAuthUpdate = parseEndpointAuthUpdate(req.body);
      const settings = parseConfig(req.body, await readOllama(target));
      const saved = await saveOllama(target, settings);
      applyEndpointAuthUpdate(authStorage, saved.endpoint, endpointAuthUpdate);
      res.json(await statusResponse(saved, authStorage));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message.startsWith("Ollama endpoint")) throw badRequest(error.message);
      rethrowAsApiError(error);
    }
  });

  const refresh = async (req: { body?: unknown }, res: { json: (body: unknown) => void }, connect: boolean) => {
    const target = requireStore();
    const current = await readOllama(target);
    const endpointAuthUpdate = connect ? parseEndpointAuthUpdate(req.body) : undefined;
    const configured = connect ? parseConfig(req.body, current) : current;
    // Stage credential changes for discovery. Do not replace the active endpoint binding until discovery and settings persistence succeed.
    const endpointAuthToken = await resolveProbeEndpointAuthToken(authStorage, configured.endpoint, endpointAuthUpdate);
    const discovered = await discoverOllamaModels(configured.endpoint, endpointAuthToken);
    const latest = await readOllama(target);
    if (!connect && latest.endpoint !== configured.endpoint) {
      throw new ApiError(409, "Ollama endpoint changed during model refresh; retry refresh to use the latest endpoint");
    }
    const next = { ...(connect ? configured : latest), endpoint: discovered.endpoint, models: discovered.models };
    const settings = await saveOllama(target, next);
    if (connect) applyEndpointAuthUpdate(authStorage, settings.endpoint, endpointAuthUpdate);
    res.json(await statusResponse(settings, authStorage));
  };

  router.post("/ollama/connect", async (req, res) => {
    try { await refresh(req, res, true); } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message.startsWith("Ollama endpoint")) throw badRequest(error.message);
      rethrowAsApiError(error);
    }
  });
  router.post("/ollama/refresh", async (req, res) => {
    try { await refresh(req, res, false); } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });
};
