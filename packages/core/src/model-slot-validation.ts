/**
 * Shared model-slot validation against the LIVE pi execution model registry.
 *
 * FNXC:ModelSlotValidation 2026-07-11-00:00:
 * FUSI-050: a model slot (default/fallback/per-lane) could be persisted pointing
 * at a provider/model that does not resolve in the live pi execution model
 * registry — e.g. a plugin-gated provider (`cursor-cli`, `grok-cli`) whose
 * runtime plugin/extension is disabled or not loaded — with nothing rejecting
 * or warning at SAVE time. Because a FALLBACK slot only fires under
 * rate-limit/overload, the misconfig stayed invisible until a real incident
 * (2026-07-11: a 5-hour Claude subscription rate limit forced a fallback to
 * `cursor-cli/gpt-5.3-codex-high`, which hard-failed several tasks at once
 * with "Configured model X (fallback selection) was not found in the pi model
 * registry"). This module is the single source of truth every save-time route
 * (project settings, global settings, workflow settings) consumes to catch
 * that class of misconfiguration before it is persisted.
 *
 * `@fusion/core` cannot import `@fusion/engine`'s `ModelRegistry` type
 * directly (see AGENTS.md "Importing across `@fusion/*` packages" — core uses
 * DI instead of reaching into engine to avoid the circular dependency), so
 * this module accepts a minimal structural interface ({@link ModelSlotRegistryLike})
 * that mirrors the two `ModelRegistry` methods `resolveConfiguredModel`
 * (`packages/engine/src/pi.ts`) actually uses: `find(provider, modelId)` and
 * `getAll()`. Callers construct the real execution registry via
 * `@fusion/engine`'s `buildExecutionModelRegistry` and pass it in here.
 *
 * IMPORTANT: this validates against the execution `ModelRegistry` used at
 * session-creation time — NOT `/api/models` picker visibility. Those two are
 * different data sets (see `register-model-routes.ts`); conflating them was
 * the root cause of the FN-7711/incident confusion this task corrects.
 */

/** Minimal shape of a registered execution model entry. Only `provider` is read.
 *  Deliberately has no index signature so a concrete `ModelRegistry` entry type
 *  (e.g. pi-ai's `Model<Api>`) that carries additional fields remains structurally
 *  assignable. */
export interface ModelSlotRegistryEntry {
  provider?: string;
}

/**
 * Structural subset of `@fusion/engine`'s `ModelRegistry` that model-slot
 * validation needs. Deliberately narrow so `@fusion/core` never imports the
 * engine package.
 */
export interface ModelSlotRegistryLike {
  find(provider: string, modelId: string): ModelSlotRegistryEntry | undefined | null;
  getAll(): ModelSlotRegistryEntry[];
}

/**
 * Providers that resolve only once a plugin/extension registers them into the
 * execution `ModelRegistry` (see `registerExtensionProviders`,
 * `packages/engine/src/pi.ts`). When one of these is unresolvable, the
 * validation outcome is `plugin-gated-not-enabled` (with a hint naming the
 * plugin) rather than a generic `unresolvable`, because the fix is usually
 * "enable the plugin" rather than "this provider/model doesn't exist".
 *
 * FN-7711 fixed the identical "not found in the pi model registry" symptom
 * for `grok-cli`; `cursor-cli` is a plugin-gated provider in the same class
 * (see `fusion-plugin-cursor-runtime`, and `packages/core/src/grok-provider.ts`
 * `registerBuiltInGrokProvider` for the canonical pattern). This list is
 * intentionally small and curated — it is a UX hint, not an allowlist; any
 * other unresolvable provider still gets the generic `unresolvable` outcome.
 */
export const KNOWN_PLUGIN_GATED_MODEL_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  "cursor-cli": "fusion-plugin-cursor-runtime",
  "grok-cli": "grok-cli (registerBuiltInGrokProvider)",
});

export interface ModelSlotSelectionInput {
  provider?: string | null;
  modelId?: string | null;
}

export type ModelSlotValidationOutcome =
  | { status: "ok" }
  | { status: "unresolvable"; provider: string; modelId: string; message: string }
  | { status: "plugin-gated-not-enabled"; provider: string; modelId: string; pluginId: string; message: string };

/**
 * Validate one model slot (provider + modelId pair) against the live
 * execution model registry, using the SAME resolution semantics as
 * `resolveConfiguredModel` (`packages/engine/src/pi.ts`):
 *   1. `registry.find(provider, modelId)` — exact match.
 *   2. The "provider base model" on-the-fly rule: if the provider has ANY
 *      registered model, an unlisted model id for that provider is still
 *      accepted (pi's `buildFallbackModel` behavior — e.g. any OpenRouter
 *      model string).
 *   3. Otherwise unresolvable (or `plugin-gated-not-enabled` when the
 *      provider is a known plugin-gated provider).
 *
 * An undefined/empty provider OR modelId is a no-op `ok` (empty slot) — never
 * a validation error. A slot is only meaningful once both halves are set
 * ("Must be set together" is documented on every provider/modelId field pair
 * in `packages/core/src/types.ts`).
 */
export function validateModelSlotSelection(
  registry: ModelSlotRegistryLike | undefined | null,
  slot: ModelSlotSelectionInput,
): ModelSlotValidationOutcome {
  const provider = typeof slot.provider === "string" ? slot.provider.trim() : "";
  const modelId = typeof slot.modelId === "string" ? slot.modelId.trim() : "";
  if (!provider || !modelId) {
    return { status: "ok" };
  }

  // No registry available to validate against (e.g. registry construction
  // failed) — fail open rather than block an otherwise-valid save. Save-time
  // callers should log this condition separately; it is not itself a
  // validation rejection.
  if (!registry) {
    return { status: "ok" };
  }

  if (registry.find(provider, modelId)) {
    return { status: "ok" };
  }

  const providerHasAnyRegisteredModel = registry.getAll().some((entry) => entry.provider === provider);
  if (providerHasAnyRegisteredModel) {
    return { status: "ok" };
  }

  const pluginId = KNOWN_PLUGIN_GATED_MODEL_PROVIDERS[provider];
  if (pluginId) {
    return {
      status: "plugin-gated-not-enabled",
      provider,
      modelId,
      pluginId,
      message: `Provider "${provider}" is plugin-gated and requires "${pluginId}" to be enabled/loaded — it is not currently registered in the execution model registry, so "${provider}/${modelId}" will not resolve at runtime until the plugin is enabled.`,
    };
  }

  return {
    status: "unresolvable",
    provider,
    modelId,
    message: `Model "${provider}/${modelId}" was not found in the live pi execution model registry. If this model comes from a custom provider, verify Settings → Custom Providers includes this provider/model, or choose an available model from /api/models.`,
  };
}
