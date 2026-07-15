import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_OLLAMA_SETTINGS, OLLAMA_ENDPOINT_AUTH_PROVIDER_ID, serializeOllamaEndpointAuthCredential } from "@fusion/core";

const authStorage = vi.hoisted(() => ({ getApiKey: vi.fn() }));
vi.mock("../auth-storage.js", () => ({
  createFusionAuthStorage: () => authStorage,
}));

import { OLLAMA_NATIVE_API_ID, assertNativeOllamaExecutorAllowed, nativeOllamaRequestHeaders, registerNativeOllamaProvider, streamNativeOllama } from "../ollama-provider.js";

describe("native Ollama registry", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it("registers enabled discovered models under the canonical provider and dedicated API", () => {
    const registerProvider = vi.fn();
    registerNativeOllamaProvider({ registerProvider }, { ...DEFAULT_OLLAMA_SETTINGS, enabled: true, models: [{ id: "qwen", name: "qwen", capabilities: ["tools"], toolCallingVerified: true }] });
    expect(registerProvider).toHaveBeenCalledWith("ollama", expect.objectContaining({ api: OLLAMA_NATIVE_API_ID, models: [expect.objectContaining({ id: "qwen" })] }));
  });
  it("keeps the SDK placeholder only in the real registry, not as an endpoint credential", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registerNativeOllamaProvider(registry, {
      ...DEFAULT_OLLAMA_SETTINGS,
      enabled: true,
      models: [{ id: "qwen", name: "qwen", capabilities: [], toolCallingVerified: false }],
    });

    expect(registry.getAll()).toContainEqual(expect.objectContaining({ provider: "ollama", api: OLLAMA_NATIVE_API_ID }));
    expect(authStorage.getApiKey).not.toHaveBeenCalledWith("ollama-native");
  });

  it("omits registry placeholder authorization for a local stream and adds only an explicit endpoint token", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":{"content":"ok"},"done":true}\n'));
    vi.stubGlobal("fetch", fetchMock);
    const model = { id: "qwen", provider: "ollama", api: OLLAMA_NATIVE_API_ID, baseUrl: "http://localhost:11434" } as any;
    const context = { systemPrompt: "", messages: [], tools: [] } as any;

    authStorage.getApiKey.mockResolvedValueOnce(undefined);
    streamNativeOllama(model, context, { headers: { Authorization: "Bearer ollama-native", "x-pi-safe": "preserve" } } as any);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "content-type": "application/json", "x-pi-safe": "preserve" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");

    authStorage.getApiKey.mockResolvedValueOnce(
      serializeOllamaEndpointAuthCredential({ endpoint: "http://localhost:11434", token: "protected-token" }),
    );
    streamNativeOllama(model, context);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer protected-token" });
    expect(authStorage.getApiKey).toHaveBeenLastCalledWith(OLLAMA_ENDPOINT_AUTH_PROVIDER_ID);
  });

  it("does not send a token bound to a newer endpoint through an active session's older model URL", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":{"content":"ok"},"done":true}\n'));
    vi.stubGlobal("fetch", fetchMock);
    authStorage.getApiKey.mockResolvedValueOnce(
      serializeOllamaEndpointAuthCredential({ endpoint: "https://new-ollama.test", token: "new-endpoint-token" }),
    );

    streamNativeOllama(
      { id: "qwen", provider: "ollama", api: OLLAMA_NATIVE_API_ID, baseUrl: "http://localhost:11434" } as any,
      { systemPrompt: "", messages: [], tools: [] } as any,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("preserves safe pi headers while allowing only a dedicated endpoint token to authorize native chat", () => {
    expect(nativeOllamaRequestHeaders({ "X-Pi-Safe": "yes", Authorization: "Bearer ollama-native" }, undefined)).toEqual({ "content-type": "application/json", "x-pi-safe": "yes" });
    expect(nativeOllamaRequestHeaders(undefined, "protected-token")).toMatchObject({ authorization: "Bearer protected-token", "content-type": "application/json" });
  });

  it("does not register disabled or empty configurations", () => {
    const registerProvider = vi.fn(); registerNativeOllamaProvider({ registerProvider }, DEFAULT_OLLAMA_SETTINGS);
    expect(registerProvider).not.toHaveBeenCalled();
  });
  it("requires both opt-in and exact verified tools for executor selections", () => {
    const settings = { ollama: { ...DEFAULT_OLLAMA_SETTINGS, enabled: true, executorEnabled: true, models: [{ id: "safe", name: "safe", capabilities: ["tools"], toolCallingVerified: true }] } };
    expect(() => assertNativeOllamaExecutorAllowed("ollama", "safe", settings)).not.toThrow();
    expect(() => assertNativeOllamaExecutorAllowed("ollama", "other", settings)).toThrow("verified native tools");
    expect(() => assertNativeOllamaExecutorAllowed("anthropic", "x", settings)).not.toThrow();
  });
});
