// @vitest-environment node

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as performRequest } from "../../test-request.js";
import { discoverOllamaModels, normalizeOllamaEndpoint } from "../../ollama-probe.js";

function createApp(settings: GlobalSettings) {
  const globalStore = { getSettings: vi.fn(async () => settings), invalidateCache: vi.fn() };
  const store = { getGlobalSettingsStore: vi.fn(() => globalStore), updateGlobalSettings: vi.fn(async (patch: Partial<GlobalSettings>) => { Object.assign(settings, patch); return settings; }), getSettingsFast: vi.fn(async () => ({})), getRootDir: vi.fn(() => "/fake/root"), getFusionDir: vi.fn(() => "/fake/root/.fusion") } as unknown as TaskStore;
  const app = express(); app.use(express.json()); app.use("/api", createApiRoutes(store)); return { app, store };
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

  it("persists native status/configuration without accepting client capability metadata", async () => {
    const settings: GlobalSettings = {};
    const { app } = createApp(settings);
    const initial = await request(app, "GET", "/api/ollama/status");
    expect(initial.status).toBe(200); expect(initial.body.ollama.endpoint).toBe("http://localhost:11434");
    const saved = await request(app, "PUT", "/api/ollama/config", { enabled: true, endpoint: "http://ollama.test:11434", executorEnabled: true, models: [{ id: "forged" }] });
    expect(saved.status).toBe(200); expect(saved.body.ollama).toMatchObject({ enabled: true, endpoint: "http://ollama.test:11434", executorEnabled: true, models: [] });
    expect(settings.customProviders).toBeUndefined();
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
