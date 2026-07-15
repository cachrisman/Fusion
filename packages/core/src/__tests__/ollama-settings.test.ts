import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GlobalSettings } from "../types.js";
import { DEFAULT_OLLAMA_SETTINGS, resolveOllamaSettings } from "../types.js";
import { DEFAULT_GLOBAL_SETTINGS, GLOBAL_SETTINGS_KEYS, isGlobalSettingsKey } from "../settings-schema.js";
import { GlobalSettingsStore } from "../global-settings.js";

describe("native Ollama global settings", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("hydrates the safe machine-global defaults and recognizes the global key", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.ollama).toEqual(DEFAULT_OLLAMA_SETTINGS);
    expect(GLOBAL_SETTINGS_KEYS).toContain("ollama");
    expect(isGlobalSettingsKey("ollama")).toBe(true);
    expect(resolveOllamaSettings(undefined)).toEqual(DEFAULT_OLLAMA_SETTINGS);
  });

  it("keeps native Ollama settings typed and independent from Custom Providers", () => {
    const settings: GlobalSettings = {
      ollama: {
        enabled: true,
        endpoint: "https://ollama.example.test",
        think: false,
        numCtx: 32768,
        executorEnabled: false,
        models: [{
          id: "qwen3:8b",
          name: "qwen3:8b",
          capabilities: ["tools"],
          toolCallingVerified: true,
        }],
      },
      customProviders: [{
        id: "legacy-ollama",
        name: "Ollama",
        apiType: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
      }],
    };

    expect(settings.ollama?.models[0]?.toolCallingVerified).toBe(true);
    expect(settings.customProviders).toHaveLength(1);
  });

  it("persists a native Ollama round trip without rewriting existing custom providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-ollama-settings-"));
    createdDirs.push(dir);
    const store = new GlobalSettingsStore(dir);
    await store.init();
    const legacyProviders = [{
      id: "legacy-ollama",
      name: "Ollama Compatibility",
      apiType: "openai-compatible" as const,
      baseUrl: "http://localhost:11434/v1",
    }];

    await store.updateSettings({
      customProviders: legacyProviders,
      ollama: {
        ...DEFAULT_OLLAMA_SETTINGS,
        enabled: true,
        endpoint: "http://ollama.test:11434",
        models: [{
          id: "qwen3:8b",
          name: "qwen3:8b",
          capabilities: ["tools"],
          toolCallingVerified: true,
        }],
      },
    });
    store.invalidateCache();

    await expect(store.getSettings()).resolves.toMatchObject({
      customProviders: legacyProviders,
      ollama: {
        enabled: true,
        endpoint: "http://ollama.test:11434",
        executorEnabled: false,
        models: [{ id: "qwen3:8b", toolCallingVerified: true }],
      },
    });
  });
});
