import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { CliProviderContribution, CustomProvider } from "@fusion/core";
import { customProviderRegistryKey } from "@fusion/core";
import type { PluginRunner } from "../plugin-runner.js";
import { registerExtensionProviders } from "../pi.js";

/*
FNXC:SessionRouting 2026-07-13-00:00:
FUSI-090 root-cause repro + fix verification.

Root cause (see task doc "root-cause" for full analysis): pi-ai's underlying
api-provider dispatch table (`apiProviderRegistry` in
@earendil-works/pi-ai/dist/compat.js) is a SINGLE PROCESS-GLOBAL `Map` keyed
ONLY by the `api` type string (e.g. "openai-completions") -- NOT scoped by
provider name and NOT scoped by ModelRegistry instance/task. Before the fix,
`registerPluginCliProvider` (FUSI-069) registered its inert always-throwing
`streamSimple` placeholder under the SAME shared `api: "openai-completions"`
key used by every real openai-compatible provider (built-in OpenAI/OpenRouter
and any custom provider such as Ollama/LM Studio/vLLM). Because
`ModelRegistry.applyProviderConfig` calls the SDK's `registerApiProvider(...)`
(a plain `Map.set(api, ...)`, last writer wins, process-wide) whenever a
provider config declares `streamSimple`, the cursor-cli placeholder silently
overwrote the SHARED "openai-completions" dispatch slot for the remainder of
the process. Any other model using that api type -- including a same-session
Ollama custom-provider model, no concurrency required -- then resolved through
the poisoned slot and hit the cursor-cli "must be dispatched to the plugin
runtime" placeholder error instead of its own real HTTP path.

The fix gives each plugin cliProvider (cursor-cli, and any future CLI-only
plugin provider) a DEDICATED, per-provider-unique `api` identifier
(`fusion-plugin-cli:<providerId>`) instead of reusing "openai-completions".
Since pi-ai's `Api` type is an open string type (`KnownApi | (string & {})`),
this is a fully supported registration and gives the placeholder its own
isolated slot in the global dispatch map that no other provider's models ever
share -- structurally preventing the cross-wire in both directions, with zero
per-task/session pooling changes required.
*/

function createSseResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        "data: {\"id\":\"chatcmpl-ollama\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello from ollama\"},\"finish_reason\":null}]}\n\n",
      ));
      controller.enqueue(new TextEncoder().encode(
        "data: {\"id\":\"chatcmpl-ollama\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
      ));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeCursorContribution(): CliProviderContribution {
  return {
    providerId: "cursor-cli",
    displayName: "Cursor CLI",
    binaryName: "cursor-agent",
    providerType: "cli",
    statusRoute: "/providers/cursor-cli/status",
    authRoute: "/auth/cursor-cli",
    discoverModels: vi.fn().mockResolvedValue({
      models: [{ id: "composer-2.5", label: "composer-2.5", reasoning: true, contextWindow: 200000 }],
      source: "cli",
      fallbackUsed: false,
    }),
    runtime: { runtimeId: "cursor" },
  };
}

function makePluginRunner(): PluginRunner {
  return {
    getCliProviderContributions: vi.fn().mockReturnValue([
      { pluginId: "fusion-plugin-cursor-runtime", contribution: makeCursorContribution() },
    ]),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: "fusion-plugin-cursor-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
  } as unknown as PluginRunner;
}

const OLLAMA_PROVIDER: CustomProvider = {
  id: "ollama-local-0001",
  name: "Ollama",
  apiType: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: undefined,
  models: [{ id: "qwen3.6:35b-a3b", name: "qwen3.6:35b-a3b" }],
};

/**
 * Mirrors `createFnAgent`'s custom-provider registration loop (pi.ts
 * ~2364-2388) and `custom-provider-registry.ts`'s `toProviderConfig` closely
 * enough to reproduce the real registration shape without pulling in the
 * entire `createFnAgent` session-construction seam.
 */
function registerOllamaCustomProvider(modelRegistry: ModelRegistry): string {
  const providers = [OLLAMA_PROVIDER];
  const registryKey = customProviderRegistryKey(OLLAMA_PROVIDER, providers);
  modelRegistry.registerProvider(registryKey, {
    baseUrl: OLLAMA_PROVIDER.baseUrl,
    api: "openai-completions",
    apiKey: "unused-local-key",
    models: (OLLAMA_PROVIDER.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    })),
  });
  return registryKey;
}

describe("FUSI-090: cursor-cli plugin placeholder must never back a non-cursor session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("an Ollama-resolved model streams via its real HTTP path and never invokes the cursor-cli placeholder streamSimple", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    // Order matches createFnAgent: registerExtensionProviders (bridges
    // cursor-cli) runs BEFORE the custom-provider registration loop.
    await registerExtensionProviders(process.cwd(), modelRegistry, makePluginRunner());
    const registryKey = registerOllamaCustomProvider(modelRegistry);

    const ollamaModel = modelRegistry.find(registryKey, "qwen3.6:35b-a3b");
    expect(ollamaModel).toBeDefined();
    expect(ollamaModel?.api).toBe("openai-completions");

    vi.stubGlobal("fetch", vi.fn(async () => createSseResponse()));

    // Symptom Verification: before the fix, this call throws
    // 'Provider "cursor-cli" is a plugin cliProvider with no HTTP endpoint;
    // it must be dispatched to the "cursor" plugin runtime instead of pi's
    // direct stream path.' because the cursor-cli placeholder clobbered the
    // shared "openai-completions" dispatch slot. After the fix, the Ollama
    // model streams through its own real HTTP handler and completes normally
    // (an explicit apiKey option is passed since this test calls compat.js's
    // completeSimple directly, bypassing the ModelRegistry-level auth
    // resolution session/executor code normally performs).
    const response = await completeSimple(
      ollamaModel!,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { apiKey: "unused-local-key" },
    );
    expect(response.role).toBe("assistant");
    expect(response.stopReason).toBe("stop");
    expect(response.errorMessage ?? "").not.toContain("is a plugin cliProvider with no HTTP endpoint");
  });

  it("a cursor-cli-resolved model still throws the placeholder error and routes to the cursor plugin runtime (FUSI-069 must remain intact)", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    await registerExtensionProviders(process.cwd(), modelRegistry, makePluginRunner());

    const cursorModel = modelRegistry.find("cursor-cli", "composer-2.5");
    expect(cursorModel).toBeDefined();

    await expect(completeSimple(cursorModel!, {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    })).rejects.toThrow(/is a plugin cliProvider with no HTTP endpoint/);
  });

  it("concurrency: an Ollama session and a cursor-cli session resolved/streamed at the same time stay isolated", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    await registerExtensionProviders(process.cwd(), modelRegistry, makePluginRunner());
    const registryKey = registerOllamaCustomProvider(modelRegistry);

    const ollamaModel = modelRegistry.find(registryKey, "qwen3.6:35b-a3b")!;
    const cursorModel = modelRegistry.find("cursor-cli", "composer-2.5")!;

    vi.stubGlobal("fetch", vi.fn(async () => createSseResponse()));

    const [ollamaResult, cursorResult] = await Promise.allSettled([
      completeSimple(ollamaModel, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: "unused-local-key" }),
      completeSimple(cursorModel, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
    ]);

    expect(ollamaResult.status).toBe("fulfilled");
    if (ollamaResult.status === "fulfilled") {
      expect(ollamaResult.value.role).toBe("assistant");
      expect(ollamaResult.value.stopReason).toBe("stop");
    }

    expect(cursorResult.status).toBe("rejected");
    if (cursorResult.status === "rejected") {
      expect(String(cursorResult.reason)).toMatch(/is a plugin cliProvider with no HTTP endpoint/);
    }
  });

  it("a sequential Ollama session started right after a cursor-cli session ends stays unaffected by any residual global registration", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    await registerExtensionProviders(process.cwd(), modelRegistry, makePluginRunner());

    // Simulate the cursor-cli task's session running (and throwing, as
    // expected) BEFORE the Ollama task's session streams.
    const cursorModel = modelRegistry.find("cursor-cli", "composer-2.5")!;
    await expect(completeSimple(cursorModel, {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    })).rejects.toThrow(/is a plugin cliProvider with no HTTP endpoint/);

    const registryKey = registerOllamaCustomProvider(modelRegistry);
    const ollamaModel = modelRegistry.find(registryKey, "qwen3.6:35b-a3b")!;

    vi.stubGlobal("fetch", vi.fn(async () => createSseResponse()));
    const response = await completeSimple(
      ollamaModel,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { apiKey: "unused-local-key" },
    );
    expect(response.role).toBe("assistant");
    expect(response.stopReason).toBe("stop");
  });

  /*
   * Registration-order / key-collision coverage: cursor-cli (via
   * registerExtensionProviders) is registered BEFORE the Ollama custom
   * provider (matching createFnAgent's real ordering). Assert the two
   * providers land under distinct registry keys AND distinct `api` ids, so
   * neither's dispatch slot can ever collide with or overwrite the other's,
   * in either registration order.
   */
  it("cursor-cli and the Ollama custom provider register under distinct registry keys and distinct api ids in either order", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    // Order A: cursor-cli first (matches createFnAgent's real ordering).
    await registerExtensionProviders(process.cwd(), modelRegistry, makePluginRunner());
    const registryKey = registerOllamaCustomProvider(modelRegistry);

    const cursorModel = modelRegistry.find("cursor-cli", "composer-2.5")!;
    const ollamaModel = modelRegistry.find(registryKey, "qwen3.6:35b-a3b")!;

    expect(registryKey).not.toBe("cursor-cli");
    expect(cursorModel.api).not.toBe(ollamaModel.api);
    expect(ollamaModel.api).toBe("openai-completions");
    expect(cursorModel.api).toBe("fusion-plugin-cli:cursor-cli");

    // Order B: Ollama registered first, cursor-cli bridged in afterwards on a
    // fresh registry -- the isolation must not depend on registration order.
    const modelRegistry2 = ModelRegistry.inMemory(AuthStorage.inMemory());
    const registryKey2 = registerOllamaCustomProvider(modelRegistry2);
    await registerExtensionProviders(process.cwd(), modelRegistry2, makePluginRunner());

    const cursorModel2 = modelRegistry2.find("cursor-cli", "composer-2.5")!;
    const ollamaModel2 = modelRegistry2.find(registryKey2, "qwen3.6:35b-a3b")!;
    expect(cursorModel2.api).not.toBe(ollamaModel2.api);
    expect(ollamaModel2.api).toBe("openai-completions");

    // describeModel truthfulness: a model's own provider/id must agree with
    // which dispatch slot (`api`) it actually resolves through -- an
    // Ollama-described model can never carry the cursor-cli placeholder's
    // dedicated api id, and vice versa.
    const describe = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
    expect(describe(ollamaModel)).toBe(`${registryKey}/qwen3.6:35b-a3b`);
    expect(describe(cursorModel)).toBe("cursor-cli/composer-2.5");
  });

  it("resolveConfiguredModel-style resolution (exact find + on-the-fly template) never yields a cursor-cli-backed model for a non-cursor provider", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    await registerExtensionProviders(process.cwd(), modelRegistry, makePluginRunner());
    const registryKey = registerOllamaCustomProvider(modelRegistry);

    // Exact find hit.
    const exactHit = modelRegistry.find(registryKey, "qwen3.6:35b-a3b");
    expect(exactHit).toBeDefined();
    expect(exactHit?.api).not.toContain("cursor-cli");

    // On-the-fly template fallback (pi.ts's resolveConfiguredModel: provider
    // known, exact modelId absent -> clone the provider's first registered
    // model as a template). Mirrors resolveConfiguredModel's own
    // `getAll().filter((m) => m.provider === provider)[0]` logic.
    const providerModels = modelRegistry.getAll().filter((m) => m.provider === registryKey);
    expect(providerModels.length).toBeGreaterThan(0);
    const templated = { ...providerModels[0]!, id: "some-other-ollama-tag", name: "some-other-ollama-tag" };
    expect(templated.provider).toBe(registryKey);
    expect(templated.api).not.toContain("cursor-cli");

    // True not-found: an unknown provider has zero registered models, so the
    // template path also degrades to nothing resolvable -- never falls back
    // to an unrelated provider's (e.g. cursor-cli's) base model.
    const unknownProviderModels = modelRegistry.getAll().filter((m) => m.provider === "totally-unregistered-provider");
    expect(unknownProviderModels.length).toBe(0);
  });
});
