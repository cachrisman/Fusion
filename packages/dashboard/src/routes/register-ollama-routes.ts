import { resolveOllamaSettings, type OllamaSettings } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import { discoverOllamaModels, normalizeOllamaEndpoint } from "../ollama-probe.js";
import type { ApiRouteRegistrar } from "./types.js";

type OllamaRouteStore = {
  getGlobalSettingsStore: () => { getSettings: () => Promise<{ ollama?: OllamaSettings }> };
  updateGlobalSettings: (patch: { ollama: OllamaSettings }) => Promise<unknown>;
};

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

async function readOllama(store: OllamaRouteStore): Promise<OllamaSettings> {
  return resolveOllamaSettings((await store.getGlobalSettingsStore().getSettings()).ollama);
}

async function saveOllama(store: OllamaRouteStore, settings: OllamaSettings): Promise<OllamaSettings> {
  await store.updateGlobalSettings({ ollama: settings });
  invalidateAllGlobalSettingsCaches();
  return settings;
}

/**
 * FNXC:OllamaProvider 2026-07-15-00:00:
 * The named Ollama settings API is first-class native `/api/*` configuration,
 * not Custom Provider CRUD. Endpoint/model changes invalidate picker settings
 * caches because native discovered identities may have changed.
 */
export const registerOllamaRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;
  const requireStore = (): OllamaRouteStore => {
    if (!store) throw new ApiError(500, "Settings store unavailable");
    return store as unknown as OllamaRouteStore;
  };

  router.get("/ollama/status", async (_req, res) => {
    try {
      const ollama = await readOllama(requireStore());
      res.json({ ollama, ready: ollama.enabled && ollama.models.length > 0 });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.put("/ollama/config", async (req, res) => {
    try {
      const target = requireStore();
      const settings = await saveOllama(target, parseConfig(req.body, await readOllama(target)));
      res.json({ ollama: settings, ready: settings.enabled && settings.models.length > 0 });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message.startsWith("Ollama endpoint")) throw badRequest(error.message);
      rethrowAsApiError(error);
    }
  });

  const refresh = async (req: { body?: unknown }, res: { json: (body: unknown) => void }, connect: boolean) => {
    const target = requireStore();
    const current = await readOllama(target);
    const configured = connect ? parseConfig(req.body, current) : current;
    const discovered = await discoverOllamaModels(configured.endpoint);
    const latest = await readOllama(target);
    if (!connect && latest.endpoint !== configured.endpoint) {
      throw new ApiError(409, "Ollama endpoint changed during model refresh; retry refresh to use the latest endpoint");
    }
    const next = { ...(connect ? configured : latest), endpoint: discovered.endpoint, models: discovered.models };
    const settings = await saveOllama(target, next);
    res.json({ ollama: settings, ready: settings.enabled && settings.models.length > 0 });
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
