// @vitest-environment node

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OLLAMA_ENDPOINT_AUTH_PROVIDER_ID,
  parseOllamaEndpointAuthCredential,
  serializeOllamaEndpointAuthCredential,
  type GlobalSettings,
  type TaskStore,
} from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as performRequest } from "../../test-request.js";
import { discoverOllamaModels, normalizeOllamaEndpoint } from "../../ollama-probe.js";

function createEndpointAuthStorage(credentials: Record<string, string> = {}) {
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    hasAuth: vi.fn(() => false),
    login: vi.fn(),
    logout: vi.fn(),
    getApiKeyProviders: vi.fn(() => []),
    hasApiKey: vi.fn((provider: string) => Boolean(credentials[provider])),
    getApiKey: vi.fn(async (provider: string) => credentials[provider]),
    setApiKey: vi.fn((provider: string, key: string) => { credentials[provider] = key; }),
    clearApiKey: vi.fn((provider: string) => { delete credentials[provider]; }),
    get: vi.fn((provider: string) => credentials[provider] ? { type: "api_key", key: credentials[provider] } : undefined),
  };
}

function createApp(settings: GlobalSettings, authStorage = createEndpointAuthStorage()) {
  const globalStore = { getSettings: vi.fn(async () => settings), invalidateCache: vi.fn() };
  const store = { getGlobalSettingsStore: vi.fn(() => globalStore), updateGlobalSettings: vi.fn(async (patch: Partial<GlobalSettings>) => { Object.assign(settings, patch); return settings; }), getSettingsFast: vi.fn(async () => ({})), getRootDir: vi.fn(() => "/fake/root"), getFusionDir: vi.fn(() => "/fake/root/.fusion") } as unknown as TaskStore;
  const app = express(); app.use(express.json()); app.use("/api", createApiRoutes(store, { authStorage: authStorage as never })); return { app, store, authStorage };
}
async function request(app: express.Express, method: string, path: string, body?: unknown) {
  const response = await performRequest(app, method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : { "Content-Type": "application/json" });
  return { status: response.status, body: response.body };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("native Ollama discovery contract", () => {
  beforeEach(() => {
    // Status now probes `/api/tags`; keep route tests hermetic rather than contacting localhost.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ models: [] })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes valid HTTP(S) roots and rejects unsafe endpoint syntax", () => {
    expect(normalizeOllamaEndpoint(" http://localhost:11434/ ")).toBe("http://localhost:11434");
    expect(normalizeOllamaEndpoint("https://ollama.example.test/proxy/")).toBe("https://ollama.example.test/proxy");
    expect(() => normalizeOllamaEndpoint("ftp://localhost:11434")).toThrow("http or https");
    expect(() => normalizeOllamaEndpoint("http://user:pass@localhost:11434")).toThrow("credentials");
    expect(() => normalizeOllamaEndpoint("not a url")).toThrow("valid HTTP(S)");
  });

  it("discovers safe tag metadata, deduplicates names, and verifies tools only from successful show responses", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:11434/api/tags") {
        return jsonResponse({
          models: [
            { name: "qwen3:8b", digest: "sha256:one", size: 12, modified_at: "2026-07-15T00:00:00Z" },
            { name: "qwen3:8b", digest: "sha256:duplicate" },
            { name: "llama3:latest", size: 24 },
          ],
        });
      }
      expect(url).toBe("http://localhost:11434/api/show");
      const model = JSON.parse(String(init?.body)).model;
      if (model === "qwen3:8b") return jsonResponse({ capabilities: ["tools", "vision", "tools"] });
      return jsonResponse({ error: "show unavailable" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverOllamaModels("http://localhost:11434/")).resolves.toEqual({
      endpoint: "http://localhost:11434",
      models: [
        {
          id: "qwen3:8b",
          name: "qwen3:8b",
          digest: "sha256:one",
          sizeBytes: 12,
          modifiedAt: "2026-07-15T00:00:00Z",
          capabilities: ["tools", "vision"],
          toolCallingVerified: true,
        },
        {
          id: "llama3:latest",
          name: "llama3:latest",
          sizeBytes: 24,
          capabilities: [],
          toolCallingVerified: false,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports bounded endpoint failures and accepts an empty tags result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ models: [] })));
    await expect(discoverOllamaModels("https://ollama.example.test")).resolves.toEqual({
      endpoint: "https://ollama.example.test",
      models: [],
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("socket details must not reach the operator");
    }));
    await expect(discoverOllamaModels("https://ollama.example.test")).rejects.toThrow("Could not connect to the Ollama endpoint");
  });

  it("reports default localhost availability without a credential or mutation", async () => {
    const settings: GlobalSettings = {
      ollama: {
        endpoint: "http://localhost:11434",
        enabled: false,
        think: false,
        numCtx: 32768,
        executorEnabled: false,
        models: [{ id: "saved", name: "saved", capabilities: [], toolCallingVerified: false }],
      },
    };
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { app, store } = createApp(settings);

    const response = await request(app, "GET", "/api/ollama/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ollama: { endpoint: "http://localhost:11434", enabled: false, models: [{ id: "saved" }] },
      availability: { available: true, reason: "Ollama endpoint is reachable" },
      endpointAuthConfigured: false,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.objectContaining({ method: "GET" }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(store.updateGlobalSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("endpointAuthToken");
  });

  it("returns a bounded redacted unavailable status without failing the settings request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("socket internals must stay private"); }));
    const { app } = createApp({});

    const response = await request(app, "GET", "/api/ollama/status");

    expect(response.status).toBe(200);
    expect(response.body.availability).toEqual({ available: false, reason: "Could not reach the Ollama endpoint" });
    expect(JSON.stringify(response.body)).not.toContain("socket internals");
  });

  it("uses an exact endpoint-bound token for a protected status probe without serializing it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { app } = createApp({}, createEndpointAuthStorage({
      [OLLAMA_ENDPOINT_AUTH_PROVIDER_ID]: serializeOllamaEndpointAuthCredential({ endpoint: "https://protected-ollama.test", token: "protected-token" }),
    }));

    const mismatched = await request(app, "GET", "/api/ollama/status");
    expect(mismatched.body.endpointAuthConfigured).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");

    const configured = await request(app, "PUT", "/api/ollama/config", { endpoint: "https://protected-ollama.test" });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({ endpointAuthConfigured: true, availability: { available: true } });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer protected-token" });
    expect(JSON.stringify(configured.body)).not.toContain("protected-token");
  });

  it("persists native status/configuration without accepting client capability metadata", async () => {
    const settings: GlobalSettings = {};
    const { app } = createApp(settings);
    const initial = await request(app, "GET", "/api/ollama/status");
    expect(initial.status).toBe(200); expect(initial.body.ollama.endpoint).toBe("http://localhost:11434");
    const saved = await request(app, "PUT", "/api/ollama/config", { enabled: true, endpoint: "http://ollama.test:11434", executorEnabled: true, models: [{ id: "forged" }] });
    expect(saved.status).toBe(200); expect(saved.body.ollama).toMatchObject({ enabled: true, endpoint: "http://ollama.test:11434", executorEnabled: true, models: [] });
    expect(settings.customProviders).toBeUndefined();
  });

  it("uses no authorization header for a local no-key connect and redacts endpoint-auth status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { app, authStorage } = createApp({});

    const connected = await request(app, "POST", "/api/ollama/connect", { enabled: true, endpoint: "http://localhost:11434" });

    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ endpointAuthConfigured: false, ollama: { enabled: true, endpoint: "http://localhost:11434" } });
    expect(JSON.stringify(connected.body)).not.toContain("endpointAuthToken");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(authStorage.setApiKey).not.toHaveBeenCalled();
  });

  it("stores an optional endpoint token outside settings, sends it only to probes, and clears it", async () => {
    const credentials: Record<string, string> = {};
    const authStorage = createEndpointAuthStorage(credentials);
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { app } = createApp({}, authStorage);

    const saved = await request(app, "PUT", "/api/ollama/config", { endpointAuthToken: "protected-token" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ endpointAuthConfigured: true });
    expect(JSON.stringify(saved.body)).not.toContain("protected-token");
    expect(authStorage.setApiKey).toHaveBeenCalledWith(
      OLLAMA_ENDPOINT_AUTH_PROVIDER_ID,
      serializeOllamaEndpointAuthCredential({ endpoint: "http://localhost:11434", token: "protected-token" }),
    );

    const refreshed = await request(app, "POST", "/api/ollama/refresh");
    expect(refreshed.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer protected-token" });

    const cleared = await request(app, "PUT", "/api/ollama/config", { clearEndpointAuth: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ endpointAuthConfigured: false });
    expect(authStorage.clearApiKey).toHaveBeenCalledWith(OLLAMA_ENDPOINT_AUTH_PROVIDER_ID);
    expect(credentials[OLLAMA_ENDPOINT_AUTH_PROVIDER_ID]).toBeUndefined();
  });

  it("returns a redacted error when a protected endpoint rejects its optional token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const { app } = createApp({}, createEndpointAuthStorage({
      [OLLAMA_ENDPOINT_AUTH_PROVIDER_ID]: serializeOllamaEndpointAuthCredential({ endpoint: "http://localhost:11434", token: "protected-token" }),
    }));

    const response = await request(app, "POST", "/api/ollama/refresh");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(String(response.body.error)).toContain("HTTP 401");
    expect(JSON.stringify(response.body)).not.toContain("protected-token");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer protected-token" });
  });

  it("keeps an active endpoint token bound when a protected endpoint change fails", async () => {
    const activeEndpoint = "http://active-ollama.test";
    const protectedEndpoint = "https://protected-ollama.test";
    const credentials = {
      [OLLAMA_ENDPOINT_AUTH_PROVIDER_ID]: serializeOllamaEndpointAuthCredential({ endpoint: activeEndpoint, token: "active-token" }),
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(protectedEndpoint)) return jsonResponse({ error: "unauthorized" }, 401);
      expect(url).toBe(`${activeEndpoint}/api/tags`);
      return jsonResponse({ models: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings: GlobalSettings = { ollama: { endpoint: activeEndpoint, enabled: true, think: false, numCtx: 32768, models: [], executorEnabled: false } };
    const { app } = createApp(settings, createEndpointAuthStorage(credentials));

    const failed = await request(app, "POST", "/api/ollama/connect", {
      endpoint: protectedEndpoint,
      endpointAuthToken: "protected-token",
    });

    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(settings.ollama?.endpoint).toBe(activeEndpoint);
    expect(parseOllamaEndpointAuthCredential(credentials[OLLAMA_ENDPOINT_AUTH_PROVIDER_ID])).toEqual({ endpoint: activeEndpoint, token: "active-token" });

    const refreshed = await request(app, "POST", "/api/ollama/refresh");
    expect(refreshed.status).toBe(200);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer active-token" });
    expect(JSON.stringify(failed.body)).not.toContain("protected-token");
  });

  it("does not verify tool calling when a show payload is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "model" }] });
      return jsonResponse({ capabilities: "tools" });
    }));

    const result = await discoverOllamaModels("http://localhost:11434");
    expect(result.models).toEqual([{ id: "model", name: "model", capabilities: [], toolCallingVerified: false }]);
  });
});
