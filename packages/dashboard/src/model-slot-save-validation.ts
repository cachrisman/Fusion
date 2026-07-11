/**
 * Save-time model-slot validation shared by every settings save route
 * (project `PUT /settings`, global `PUT /settings/global`, and workflow
 * `PATCH /workflows/:id/setting-values`).
 *
 * FNXC:ModelSlotValidation 2026-07-11-00:00:
 * FUSI-050 Fix #1: a model slot (default/fallback/per-lane) could previously
 * be persisted pointing at a provider/model absent from the LIVE pi execution
 * `ModelRegistry` — e.g. a plugin-gated provider (`cursor-cli`, `grok-cli`)
 * whose runtime plugin/extension is disabled or not loaded. Because a
 * FALLBACK slot only fires under rate-limit/overload, that misconfig stayed
 * invisible until a real incident (2026-07-11: a 5-hour Claude subscription
 * rate limit forced a fallback to `cursor-cli/gpt-5.3-codex-high`, which
 * hard-failed several tasks at once). This module runs
 * `@fusion/core`'s `validateModelSlotSelection` against the SAME execution
 * registry `createFnAgent` resolves models against (built via
 * `@fusion/engine`'s `buildExecutionModelRegistry`), NOT the `/api/models`
 * picker list — that mismatch was the root cause of the FN-7711/incident
 * confusion this task corrects.
 *
 * Policy: an `unresolvable` slot is REJECTED (400) so a silently-broken slot
 * can never be persisted. A `plugin-gated-not-enabled` slot is allowed
 * through with a surfaced warning (the plugin may simply not be loaded in
 * THIS process yet, e.g. dashboard vs. daemon, or the operator intends to
 * enable it before the slot is exercised) — but it is never silent either;
 * every warning is logged and returned to the caller.
 */
import { validateModelSlotSelection, type ModelSlotRegistryLike } from "@fusion/core";
import { buildExecutionModelRegistry } from "@fusion/engine";
import { badRequest } from "./api-error.js";

/** One provider/modelId field-pair to check in a settings payload. Supports one level
 *  of dot-path nesting (e.g. "evalSettings.evaluatorProvider") for nested setting objects. */
export interface ModelSlotFieldPair {
  providerField: string;
  modelField: string;
}

/** Model-slot field pairs persisted via `PUT /settings` (project scope). */
export const PROJECT_MODEL_SLOT_FIELD_PAIRS: readonly ModelSlotFieldPair[] = Object.freeze([
  { providerField: "defaultProviderOverride", modelField: "defaultModelIdOverride" },
  { providerField: "titleSummarizerProvider", modelField: "titleSummarizerModelId" },
  { providerField: "titleSummarizerFallbackProvider", modelField: "titleSummarizerFallbackModelId" },
  { providerField: "taskEvaluationProvider", modelField: "taskEvaluationModelId" },
  { providerField: "evalSettings.evaluatorProvider", modelField: "evalSettings.evaluatorModelId" },
  { providerField: "researchSettings.synthesisProvider", modelField: "researchSettings.synthesisModelId" },
]);

/** Model-slot field pairs persisted via `PUT /settings/global` (global scope). */
export const GLOBAL_MODEL_SLOT_FIELD_PAIRS: readonly ModelSlotFieldPair[] = Object.freeze([
  { providerField: "defaultProvider", modelField: "defaultModelId" },
  { providerField: "modelRouterCheapProvider", modelField: "modelRouterCheapModelId" },
  { providerField: "fallbackProvider", modelField: "fallbackModelId" },
  { providerField: "executionGlobalProvider", modelField: "executionGlobalModelId" },
  { providerField: "planningGlobalProvider", modelField: "planningGlobalModelId" },
  { providerField: "validatorGlobalProvider", modelField: "validatorGlobalModelId" },
  { providerField: "titleSummarizerGlobalProvider", modelField: "titleSummarizerGlobalModelId" },
]);

function readDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Whether `path` (possibly dotted) is present as an own key anywhere along the payload's nested structure. */
function hasDotPath(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    if (i < parts.length - 1) {
      current = current[part] as Record<string, unknown>;
    }
  }
  return true;
}

/**
 * Derive provider/modelId field pairs from a workflow's declared setting ids by
 * naming convention: a declaration id ending in "Provider" pairs with the
 * declaration whose id is the same string with "Provider" replaced by "ModelId"
 * (e.g. `executionProvider` ↔ `executionModelId`, `planningFallbackProvider` ↔
 * `planningFallbackModelId`). Both halves must be present among the workflow's
 * declared setting ids for the pair to be considered — this mirrors the
 * `BUILTIN_WORKFLOW_SETTINGS` model-lane declarations
 * (`packages/core/src/builtin-workflow-settings.ts`), which is the ONLY
 * remaining save path for these lanes since U4 moved them out of project
 * settings (see `packages/core/src/moved-settings.ts`).
 */
export function deriveWorkflowModelSlotFieldPairs(
  declarations: readonly { id: string }[] | undefined,
): ModelSlotFieldPair[] {
  if (!declarations || declarations.length === 0) return [];
  const ids = new Set(declarations.map((d) => d.id));
  const pairs: ModelSlotFieldPair[] = [];
  for (const id of ids) {
    if (!id.endsWith("Provider")) continue;
    const modelField = `${id.slice(0, -"Provider".length)}ModelId`;
    if (ids.has(modelField)) {
      pairs.push({ providerField: id, modelField });
    }
  }
  return pairs;
}

export interface ModelSlotSaveValidationResult {
  /** Human-readable warnings for plugin-gated-not-enabled slots (never blocking). */
  warnings: string[];
}

/**
 * Validate every declared model-slot field pair PRESENT in `payload` against
 * the live execution model registry rooted at `cwd`. Throws `badRequest(...)`
 * naming the failing `provider/model` for an `unresolvable` slot. Returns
 * warnings (never throws) for `plugin-gated-not-enabled` slots. Slots not
 * present in the payload, or present with only one half of the pair set
 * (validated elsewhere as "must be set together"), are left alone — an empty
 * slot is always a no-op per `validateModelSlotSelection`.
 */
export async function validateModelSlotsInPayload(
  cwd: string | (() => string),
  payload: Record<string, unknown>,
  pairs: readonly ModelSlotFieldPair[],
  log?: (message: string) => void,
): Promise<ModelSlotSaveValidationResult> {
  // Only validate a pair when BOTH halves are present in this payload — every
  // provider/modelId field pair is documented as "must be set together", and a
  // half-set field (e.g. a save that only touches `defaultProvider`) is not a
  // complete slot selection to validate (or reject) yet. This also keeps a
  // payload with no complete model-slot pair a true no-op (never builds the
  // execution registry).
  const relevantPairs = pairs.filter((pair) => hasDotPath(payload, pair.providerField) && hasDotPath(payload, pair.modelField));
  if (relevantPairs.length === 0) {
    return { warnings: [] };
  }

  // Only resolve `cwd` (which, for callers passing `() => store.getRootDir()`,
  // touches the store) once we know there is actually a model-slot field to
  // validate — keeps this a true no-op for payloads with no model-slot fields.
  const resolvedCwd = typeof cwd === "function" ? cwd() : cwd;

  let registry: ModelSlotRegistryLike | undefined;
  try {
    registry = await buildExecutionModelRegistry(resolvedCwd);
  } catch (error) {
    // Fail open: if the execution registry itself cannot be built (e.g.
    // extension discovery error), do not block an otherwise-valid settings
    // save on a validation-infrastructure failure.
    log?.(`model-slot validation: failed to build execution model registry, skipping validation: ${error instanceof Error ? error.message : String(error)}`);
    return { warnings: [] };
  }

  const warnings: string[] = [];
  for (const pair of relevantPairs) {
    const provider = readDotPath(payload, pair.providerField);
    const modelId = readDotPath(payload, pair.modelField);
    const outcome = validateModelSlotSelection(registry, {
      provider: typeof provider === "string" ? provider : undefined,
      modelId: typeof modelId === "string" ? modelId : undefined,
    });
    if (outcome.status === "ok") {
      continue;
    }
    if (outcome.status === "unresolvable") {
      throw badRequest(
        `${pair.providerField}/${pair.modelField}: ${outcome.message}`,
      );
    }
    // plugin-gated-not-enabled — warn, do not block the save.
    const warning = `${pair.providerField}/${pair.modelField}: ${outcome.message}`;
    warnings.push(warning);
    log?.(`model-slot validation warning: ${warning}`);
  }
  return { warnings };
}
