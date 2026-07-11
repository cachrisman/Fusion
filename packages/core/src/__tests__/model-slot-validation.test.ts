import { describe, expect, it } from "vitest";
import {
  KNOWN_PLUGIN_GATED_MODEL_PROVIDERS,
  validateModelSlotSelection,
  type ModelSlotRegistryEntry,
  type ModelSlotRegistryLike,
} from "../model-slot-validation.js";

/**
 * FNXC:ModelSlotValidation 2026-07-11-00:00:
 * Regression coverage for FUSI-050 Fix #1 — the save-time validation helper
 * consumed by every project/global/workflow settings save route. Mirrors the
 * `resolveConfiguredModel` resolution semantics (packages/engine/src/pi.ts)
 * without importing `@fusion/engine`.
 */
function fakeRegistry(entries: ModelSlotRegistryEntry[]): ModelSlotRegistryLike {
  return {
    find: (provider, modelId) => entries.find((e) => e.provider === provider && e.id === modelId) ?? undefined,
    getAll: () => entries,
  };
}

describe("validateModelSlotSelection", () => {
  it("resolves a built-in provider/model present in the registry as ok", () => {
    const registry = fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
    expect(validateModelSlotSelection(registry, { provider: "anthropic", modelId: "claude-sonnet-4-5" })).toEqual({
      status: "ok",
    });
  });

  it("resolves an unlisted model id for a known provider via the provider-base-model on-the-fly rule", () => {
    // Mirrors resolveConfiguredModel's on-the-fly fallback: any model id is
    // accepted once the provider has at least one registered model.
    const registry = fakeRegistry([{ provider: "openrouter", id: "some/base-model" }]);
    expect(
      validateModelSlotSelection(registry, { provider: "openrouter", modelId: "some/other-model-string" }),
    ).toEqual({ status: "ok" });
  });

  it("rejects a provider/model absent from the registry as unresolvable", () => {
    const registry = fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
    const outcome = validateModelSlotSelection(registry, { provider: "zai", modelId: "glm-5.1" });
    expect(outcome.status).toBe("unresolvable");
    if (outcome.status === "unresolvable") {
      expect(outcome.provider).toBe("zai");
      expect(outcome.modelId).toBe("glm-5.1");
      expect(outcome.message).toContain("zai/glm-5.1");
      expect(outcome.message).toContain("was not found in the live pi execution model registry");
    }
  });

  it("flags a known plugin-gated provider whose plugin is not registered as plugin-gated-not-enabled", () => {
    // Reproduces the 2026-07-11 incident shape: cursor-cli/gpt-5.3-codex-high
    // configured as a fallback, but fusion-plugin-cursor-runtime never
    // registered the provider into the execution registry.
    const registry = fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
    const outcome = validateModelSlotSelection(registry, {
      provider: "cursor-cli",
      modelId: "gpt-5.3-codex-high",
    });
    expect(outcome.status).toBe("plugin-gated-not-enabled");
    if (outcome.status === "plugin-gated-not-enabled") {
      expect(outcome.pluginId).toBe(KNOWN_PLUGIN_GATED_MODEL_PROVIDERS["cursor-cli"]);
      expect(outcome.message).toContain("cursor-cli");
      expect(outcome.message).toContain(KNOWN_PLUGIN_GATED_MODEL_PROVIDERS["cursor-cli"]!);
    }
  });

  it("flags grok-cli as plugin-gated-not-enabled when unresolved (FN-7711 provider class)", () => {
    const registry = fakeRegistry([]);
    const outcome = validateModelSlotSelection(registry, { provider: "grok-cli", modelId: "grok-4.5" });
    expect(outcome.status).toBe("plugin-gated-not-enabled");
  });

  it("treats an empty slot (provider or modelId undefined) as a no-op ok, never a validation error", () => {
    const registry = fakeRegistry([]);
    expect(validateModelSlotSelection(registry, {})).toEqual({ status: "ok" });
    expect(validateModelSlotSelection(registry, { provider: "anthropic" })).toEqual({ status: "ok" });
    expect(validateModelSlotSelection(registry, { modelId: "claude-sonnet-4-5" })).toEqual({ status: "ok" });
    expect(validateModelSlotSelection(registry, { provider: "", modelId: "" })).toEqual({ status: "ok" });
    expect(validateModelSlotSelection(registry, { provider: null, modelId: null })).toEqual({ status: "ok" });
  });

  it("fails open (ok) when no registry is supplied", () => {
    expect(validateModelSlotSelection(undefined, { provider: "zai", modelId: "glm-5.1" })).toEqual({ status: "ok" });
    expect(validateModelSlotSelection(null, { provider: "zai", modelId: "glm-5.1" })).toEqual({ status: "ok" });
  });
});
