import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OLLAMA_SETTINGS } from "@fusion/core";
import { OLLAMA_NATIVE_API_ID, assertNativeOllamaExecutorAllowed, registerNativeOllamaProvider } from "../ollama-provider.js";

describe("native Ollama registry", () => {
  it("registers enabled discovered models under the canonical provider and dedicated API", () => {
    const registerProvider = vi.fn();
    registerNativeOllamaProvider({ registerProvider }, { ...DEFAULT_OLLAMA_SETTINGS, enabled: true, models: [{ id: "qwen", name: "qwen", capabilities: ["tools"], toolCallingVerified: true }] });
    expect(registerProvider).toHaveBeenCalledWith("ollama", expect.objectContaining({ api: OLLAMA_NATIVE_API_ID, models: [expect.objectContaining({ id: "qwen" })] }));
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
