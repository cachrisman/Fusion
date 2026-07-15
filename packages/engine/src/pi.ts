/**
 * Shared pi SDK setup for fn engine agents.
 *
 * Uses Fusion auth for writes and legacy pi auth as a read-only fallback.
 * Provides factory functions for creating triage and executor agent sessions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";

const execAsync = promisify(exec);
import {
  createAgentSession,
  createBashTool,
  createCodingTools,
  createEditTool,
  createExtensionRuntime,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  DefaultPackageManager,
  discoverAndLoadExtensions,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  customProviderRegistryKey,
  getEnabledPiExtensionPaths,
  getFusionAgentDir,
  getLegacyPiAgentDir,
  getProjectRootFromWorktree,
  reconcileClaudeCliPaths,
  reconcileDroidCliPaths,
  mergeBuiltInGrokProviderModels,
  mergeBuiltInZaiProviderModels,
  mergeSupplementalAnthropicModels,
  mergeSupplementalOpenAiCodexModels,
  registerBuiltInGrokProvider,
  registerBuiltInZaiProvider,
  resolvePiExtensionProjectRoot,
} from "@fusion/core";
import type {
  AgentPermissionPolicyActionCategory,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
  ResolvedMcpServerDefinition,
  SecretScope,
} from "@fusion/core";
import {
  resolveSessionSkills,
  createSkillsOverrideFromSelection,
  type SkillSelectionContext,
} from "./skill-resolver.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { applyClaudeAcpEnable } from "./claude-acp-enable.js";
import { createFusionAuthStorage, getModelRegistryModelsPath } from "./auth-storage.js";
import { piLog, extensionsLog } from "./logger.js";
import { readCustomProviders } from "./custom-providers.js";
import { buildCustomProviderModels } from "./custom-provider-registry.js";
import { readNativeOllamaSettings, registerNativeOllamaApiProvider, registerNativeOllamaProvider } from "./ollama-provider.js";
import {
  buildGateRejection,
  evaluateAgentActionGate,
  resolveGateOutcome,
  type AgentActionGateContext,
} from "./agent-action-gate.js";
import { resolvePermanentAgentToolDecision } from "./permanent-agent-gating.js";
import type { SystemPromptLayers } from "./prompt-layers.js";
import { READONLY_ALLOWLIST, filterCustomToolsForReadonly, isReadonlyAllowed } from "./workflow-step-tool-policy.js";
import { createStreamingDeltaNormalizer } from "./streaming-delta.js";
import { isModelAuthTierIncompatibilityError, isProviderModelNotFoundError, isUnsupportedMessageRoleError } from "./transient-error-detector.js";
import { isUsageLimitError } from "./usage-limit-detector.js";
import type { PluginRunner } from "./plugin-runner.js";
import type { AgentPromptResult } from "./agent-runtime.js";
import type { CliProviderContribution } from "@fusion/core";
import { logMcpForwardingSkipped, runtimeSupportsMcp } from "./mcp-runtime-support.js";
import { connectMcpSessionTools, McpSessionBootstrapError, type McpClientFactory, type McpSessionToolset } from "./mcp-session-tools.js";
import type { McpOAuthTokenStore } from "./mcp-oauth-provider.js";
import type { McpSettingsAndSecretsStore } from "./mcp-resolution.js";
export { isModelAuthTierIncompatibilityError } from "./transient-error-detector.js";

const RTK_ACCEPTED_REWRITE_EXIT_CODES = new Set([0, 3]);
const RTK_EXPECTED_PASSTHROUGH_EXIT_CODES = new Set([1, 2]);
const RTK_EXPECTED_FAIL_OPEN_ERROR_CODES = new Set(["ABORT_ERR", "ENOENT", "ETIMEDOUT"]);
const RTK_REWRITE_MAX_BUFFER_BYTES = 64 * 1024;

export type RtkRewriteMode = "off" | "rewrite";

export interface RtkRewriteOptions {
  mode?: RtkRewriteMode;
  timeoutMs?: number;
}

function normalizeRtkRewriteOptions(options?: RtkRewriteOptions): Required<RtkRewriteOptions> {
  const modeEnv = process.env.FUSION_RTK_REWRITE?.toLowerCase();
  const envMode: RtkRewriteMode = modeEnv === "1" || modeEnv === "true" || modeEnv === "rewrite" ? "rewrite" : "off";
  const envTimeoutMs = Number.parseInt(process.env.FUSION_RTK_REWRITE_TIMEOUT_MS ?? "2000", 10);
  const requestedTimeoutMs = options?.timeoutMs ?? envTimeoutMs;
  return {
    mode: options?.mode ?? envMode,
    timeoutMs: Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 2000,
  };
}

function resolveRtkRewriteOptions(): Required<RtkRewriteOptions> {
  return normalizeRtkRewriteOptions();
}

function getRtkErrorCode(error: Error | null): number | string | null {
  if (!error) return 0;
  const rawCode = (error as unknown as { code?: unknown }).code;
  if (typeof rawCode === "number" || typeof rawCode === "string") return rawCode;
  return null;
}

function shouldWarnForRtkFailure(code: number | string | null): boolean {
  if (typeof code === "number") return !RTK_EXPECTED_PASSTHROUGH_EXIT_CODES.has(code);
  if (typeof code === "string") return !RTK_EXPECTED_FAIL_OPEN_ERROR_CODES.has(code);
  return true;
}

function rewriteCommandWithRtk(
  command: string,
  options: Required<RtkRewriteOptions>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile(
      "rtk",
      ["rewrite", command],
      {
        timeout: options.timeoutMs,
        maxBuffer: RTK_REWRITE_MAX_BUFFER_BYTES,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = getRtkErrorCode(error);

        if (typeof code !== "number" || !RTK_ACCEPTED_REWRITE_EXIT_CODES.has(code)) {
          if (shouldWarnForRtkFailure(code)) {
            const reason = stderr?.toString().trim() || (error instanceof Error ? error.message : `exit ${String(code)}`);
            piLog.warn(`[pi] rtk rewrite failed open: ${reason}`);
          }
          resolve(null);
          return;
        }

        const rewritten = stdout.toString().trim();
        resolve(rewritten && rewritten !== command ? rewritten : null);
      },
    );
  });
}

export interface AgentResult {
  session: AgentSession;
  /** Path to the persisted session file (undefined for in-memory sessions). */
  sessionFile?: string;
  /*
   * FNXC:ModelFallback 2026-07-11-00:00:
   * Set when a configured fallback provider/model was unresolvable against the
   * execution pi model registry and was degraded to the runtime's built-in
   * fallback instead of hard-failing the task (FUSI-050). Callers that surface
   * the FN-7787 `noModelResolved`/`runtimeBuiltInFallbackModel` warning (e.g.
   * `agent-session-helpers.ts`) should fold this into the same channel.
   */
  fallbackModelDegraded?: { provider: string; modelId: string; reason: string };
}

/**
 * Process-global list of extension paths to inject into every createFnAgent
 * session. Set once at startup by the host (cli's dashboard/daemon/serve)
 * before any sessions are created. The paths are passed to pi's
 * `DefaultResourceLoader` as `additionalExtensionPaths` so the cli's own
 * `@runfusion/fusion` extension (registering `fn_*` tools) is loaded inside
 * every agent session — including chat sessions that pass no `customTools`.
 */
let hostExtensionPaths: string[] = [];

export function setHostExtensionPaths(paths: readonly string[]): void {
  hostExtensionPaths = [...paths];
}

export function getHostExtensionPaths(): readonly string[] {
  return hostExtensionPaths;
}

export interface PromptableSession extends AgentSession {
  promptWithFallback: (prompt: string, options?: unknown) => Promise<void>;
}

interface SessionManagerLike {
  fileEntries?: Array<{ type?: string; message?: Record<string, unknown> }>;
  appendMessage?: (message: Record<string, unknown>) => void;
  _rewriteFile?: () => void;
}

interface ToolHookPayload {
  toolCall: unknown;
  args: unknown;
  result: { content?: unknown; details?: unknown };
  isError: boolean;
}

interface ToolHookResult {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

type AgentToolHookSession = AgentSession & {
  agent?: {
    afterToolCall?: (payload: ToolHookPayload) => Promise<ToolHookResult | undefined>;
    state?: {
      messages?: Array<Record<string, unknown>>;
    };
  };
  __fusionToolResultGuardInstalled?: boolean;
  __fusionMessageContentGuardInstalled?: boolean;
};
const FN_MEMORY_APPEND_TOOL_NAME = "fn_memory_append";
const FUSION_SHUTDOWN_WRAP_FLAG = "__fusionSessionShutdownDisposeWrapped";

type SessionShutdownEventShape = { type: "session_shutdown"; reason: "quit" | "reload" };
type ExtensionRunnerShutdownEmitter = {
  hasHandlers: (event: "session_shutdown") => boolean;
  emit: (event: SessionShutdownEventShape) => Promise<unknown>;
};

async function emitSessionShutdownEvent(
  extensionRunner: ExtensionRunnerShutdownEmitter,
  event: SessionShutdownEventShape,
): Promise<boolean> {
  if (!extensionRunner.hasHandlers("session_shutdown")) {
    return false;
  }
  await extensionRunner.emit(event);
  return true;
}

/**
 * Fusion creates raw pi `AgentSession` objects and many engine call sites
 * invoke `session.dispose()` directly. Wrap dispose so we mirror
 * `AgentSessionRuntime.dispose()` behavior and emit `session_shutdown` first.
 */
function wrapSessionDisposeWithShutdown(session: AgentSession): void {
  const mutableSession = session as AgentSession & Record<string, unknown>;
  if (mutableSession[FUSION_SHUTDOWN_WRAP_FLAG]) {
    return;
  }
  mutableSession[FUSION_SHUTDOWN_WRAP_FLAG] = true;

  const originalDispose =
    typeof session.dispose === "function"
      ? session.dispose.bind(session)
      : () => undefined;
  let disposeStarted = false;
  const wrappedDispose = async (): Promise<void> => {
    if (disposeStarted) {
      return;
    }
    disposeStarted = true;

    const extensionRunner = (session as { extensionRunner?: unknown }).extensionRunner;
    if (
      extensionRunner &&
      typeof (extensionRunner as ExtensionRunnerShutdownEmitter).hasHandlers === "function" &&
      typeof (extensionRunner as ExtensionRunnerShutdownEmitter).emit === "function"
    ) {
      try {
        await emitSessionShutdownEvent(extensionRunner as ExtensionRunnerShutdownEmitter, {
          type: "session_shutdown",
          reason: "quit",
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        piLog.warn(`Failed to emit session_shutdown during dispose: ${message}`);
      }
    }

    try {
      await Promise.resolve(originalDispose());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      piLog.warn(`Session dispose failed after session_shutdown emit: ${message}`);
    }
  };

  (mutableSession as unknown as { dispose: () => void }).dispose = wrappedDispose as unknown as () => void;
}

export function _wrapSessionDisposeForTest(session: AgentSession): void {
  wrapSessionDisposeWithShutdown(session);
}

function getSessionStateError(session: AgentSession): string {
  const state = (session as any).state;
  const error = state?.errorMessage ?? state?.error;
  return typeof error === "string" ? error : "";
}

function clearSessionStateError(session: AgentSession): void {
  const state = (session as any).state;
  if (!state || typeof state !== "object") {
    return;
  }

  // pi-coding-agent 0.70+ exposes `errorMessage` as readonly — writes are
  // silently ignored. Pre-0.70 used mutable `state.error`. Best-effort clear
  // both so transcripts carry forward to the next prompt cleanly.
  for (const key of ["errorMessage", "error"]) {
    if (key in state) {
      try {
        state[key] = undefined;
      } catch {
        // readonly — no-op
      }
    }
  }
}

function isThinkingReasoningConflictError(message: string): boolean {
  return /cannot specify both\s+['"]?thinking['"]?\s+and\s+['"]?reasoning_effort['"]?/i.test(message);
}

function coercePreviewValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `symbol(${value.description})` : "symbol";
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  return Object.prototype.toString.call(value);
}

function safePreviewJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "object" && candidate !== null) {
      if (seen.has(candidate)) {
        return "[Circular]";
      }
      seen.add(candidate);
    }
    return candidate;
  });
}

export async function promptSessionAndCheck(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
  clearSessionStateError(session);
  if (options === undefined) {
    await session.prompt(prompt);
  } else {
    await (session.prompt as any)(prompt, options);
  }

  const stateError = getSessionStateError(session);
  if (stateError) {
    // pi-coding-agent swallows its own exceptions into state.errorMessage
    // without preserving a stack. When the message looks like a generic
    // TypeError (undefined/null property access), dump the session transcript
    // shape so the malformed message can be identified next time.
    if (/Cannot read propert(y|ies) of (undefined|null)/i.test(stateError)) {
      try {
        const messages = (session as any).agent?.state?.messages ?? (session as any).state?.messages;
        if (Array.isArray(messages)) {
          const recent = messages.slice(-6).map((m: Record<string, unknown>, idx: number) => {
            const i = messages.length - 6 + idx;
            const content = m?.content;
            return {
              index: i < 0 ? idx : i,
              role: coercePreviewValue(m?.role),
              contentType: Array.isArray(content) ? `array(len=${content.length})` : typeof content,
              toolName: coercePreviewValue((m as { toolName?: unknown }).toolName),
              stopReason: coercePreviewValue((m as { stopReason?: unknown }).stopReason),
            };
          });
          piLog.error(`pi state error — transcript tail (${messages.length} msgs total): ${safePreviewJson(recent)}`);
        } else {
          piLog.error(`pi state error — state.messages is not an array: ${typeof messages}`);
        }
      } catch (inspectErr) {
        piLog.warn(`pi state error — failed to inspect transcript: ${inspectErr instanceof Error ? inspectErr.message : String(inspectErr)}`);
      }
    }
    // Some OpenAI-compatible providers (notably Moonshot/Kimi) end generation
    // with a non-standard `finish_reason: repeat` when their server-side
    // repetition detector trips. pi-ai surfaces this as a fatal state error,
    // but for our purposes the assistant turn is already complete — treat it
    // as a soft stop so the heartbeat keeps running.
    if (/Provider finish_reason:\s*repeat\b/i.test(stateError)) {
      piLog.warn(`pi state error — treating provider finish_reason=repeat as soft stop: ${stateError}`);
      clearSessionStateError(session);
      return;
    }
    // pi-ai's openai-codex-responses provider (Codex via ChatGPT-plan WebSocket)
    // surfaces transport drops as bare "WebSocket error" / "WebSocket closed".
    // The underlying ErrorEvent's `event.error` (cause/code) is dropped by
    // pi-ai's `extractWebSocketError` (it only inspects `event.message`), so
    // by the time we see the string the cause is gone. Tag the message with
    // the model identity so retry/transient classification can at least tell
    // which transport is unstable, and emit a structured warn for triage.
    if (/^WebSocket (error|closed)\b/i.test(stateError) || /WebSocket stream closed before response\.completed/i.test(stateError)) {
      const modelDesc = describeModel(session);
      piLog.warn(`pi state error — Codex WebSocket transport drop (model=${modelDesc}): ${stateError}`);
      throw new Error(`${stateError} (model=${modelDesc})`);
    }
    if (isModelAuthTierIncompatibilityError(stateError)) {
      const modelDesc = describeModel(session);
      const hint =
        "Operator action required: this agent's configured model is not supported by the current authentication tier. "
        + "Update the model selection in Settings → Models or configure a fallback model. "
        + "If using a ChatGPT account with Codex, use a Codex-supported model (not a GPT model).";
      piLog.error(`pi state error — model not supported for auth tier (model=${modelDesc}): ${stateError}`);
      throw new Error(`${stateError} (model=${modelDesc}). ${hint}`);
    }
    if (isUnsupportedMessageRoleError(stateError)) {
      const modelDesc = describeModel(session);
      const hint =
        "Operator action required: this agent's configured model/provider rejected a message role. Check the agent model selection and provider compatibility (imported non-default 'company' agents may default to an incompatible model+provider combination).";
      piLog.error(`pi state error — unsupported message role (model=${modelDesc}): ${stateError}`);
      throw new Error(`${stateError} (model=${modelDesc}). ${hint}`);
    }
    throw new Error(stateError);
  }
}

// Re-entry guard for the top-level dispatcher below. When `session.promptWithFallback`
// is attached (e.g. by `createFnAgent` at pi.ts:2012, where the rich model-swap +
// `isRetryableModelSelectionError` path lives), we want top-level callers like
// triage/executor to flow through it so missing-API-key, 401/403, rate-limit, etc.
// trigger the configured `fallbackModel`. The WeakSet prevents infinite recursion
// in case a session-attached `promptWithFallback` ever calls back into the
// top-level export with the same session.
const promptWithFallbackInFlight = new WeakSet<object>();

/*
FNXC:DelegatedRuntimeCompletion 2026-07-11-23:45:
FUSI-071 (plan-review point carried over from FUSI-063): a delegated CLI plugin
runtime's `promptWithFallback` resolves an `AgentPromptResult` (`{stopReason,
usage}`) on terminal success (e.g. cursor's `result.usage`), but this dispatcher
previously discarded that return value entirely (`await ...; return;`). Threading
it through lets the executor capture `result.usage` into task token usage and
treat a delegated runtime's terminal-success as the completion signal — see
executor.ts's delegated-CLI-runtime completion gate. The default pi-native path
below still returns `void`/`undefined` (pi's own token accounting flows through
`accumulateSessionTokenUsage`'s `session.getSessionStats()` seam instead).
*/
export async function promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void | AgentPromptResult> {
  const sessionWithDispatch = session as AgentSession & {
    promptWithFallback?: (prompt: string, options?: unknown) => Promise<void | AgentPromptResult>;
  };
  if (
    typeof sessionWithDispatch.promptWithFallback === "function" &&
    !promptWithFallbackInFlight.has(session as unknown as object)
  ) {
    promptWithFallbackInFlight.add(session as unknown as object);
    try {
      return await sessionWithDispatch.promptWithFallback(prompt, options);
    } finally {
      promptWithFallbackInFlight.delete(session as unknown as object);
    }
  }

  piLog.log(`promptWithFallback: calling session.prompt (prompt length=${prompt.length})`);
  try {
    await promptSessionAndCheck(session, prompt, options);
    piLog.log("promptWithFallback: prompt completed");
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!isContextLimitError(errorMessage)) {
      piLog.error(`promptWithFallback: non-context error — propagating: ${errorMessage}`);
      throw err;
    }

    // Context limit error — attempt auto-compaction and retry once
    const promptMemoryRetry = await retryWithCompactedPromptMemory(session, prompt, options);
    if (promptMemoryRetry.recovered) {
      return;
    }
    if (promptMemoryRetry.error) {
      const retryMessage = promptMemoryRetry.error instanceof Error ? promptMemoryRetry.error.message : String(promptMemoryRetry.error);
      if (!isContextLimitError(retryMessage)) {
        throw promptMemoryRetry.error;
      }
    }

    const promptSectionRetry = await retryWithCompactedPromptSections(session, prompt, options);
    if (promptSectionRetry.recovered) {
      return;
    }
    if (promptSectionRetry.error) {
      const retryMessage = promptSectionRetry.error instanceof Error ? promptSectionRetry.error.message : String(promptSectionRetry.error);
      if (!isContextLimitError(retryMessage)) {
        throw promptSectionRetry.error;
      }
    }

    piLog.warn("promptWithFallback: context limit error — attempting auto-compaction");
    await flushMemoryBeforeSessionCompaction(session);
    const compactResult = await compactSessionContext(session);
    if (!compactResult) {
      piLog.error("promptWithFallback: compaction unavailable — propagating original error");
      throw err;
    }

    piLog.log(`promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
    try {
      await promptSessionAndCheck(session, prompt, options);
      piLog.log("promptWithFallback: prompt completed after auto-compaction");
    } catch (retryErr: unknown) {
      const retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
      piLog.error(`promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
      throw err; // Throw original error to preserve original context
    }
  }
}

/**
 * Extract a human-readable model description from an AgentSession.
 * Returns `"<provider>/<modelId>"` (e.g. `"anthropic/claude-sonnet-4-5"`)
 * or `"unknown model"` when the session has no model set.
 */
/*
FNXC:DelegatedRuntimeCompletion 2026-07-11-23:52:
FUSI-071 Step 4: a plugin-runtime session's `model` is a plain string (e.g.
cursor's `"auto"`), not the pi-native `{provider,id}` shape read below, so
reading `model.provider`/`.id` on such a session produces the misleading
"undefined/undefined" marker even though the runtime executed successfully.
Dispatch to a session-attached `describeModel` override first (attached by
`createResolvedAgentSession` in agent-session-helpers.ts, parallel to the
`promptWithFallback` dispatch hook) so a plugin-runtime session reports its
own description (e.g. "cursor/auto"); the pi-native fallback below is
unchanged for sessions with no override attached.
*/
export function describeModel(session: AgentSession): string {
  const sessionWithDispatch = session as AgentSession & { describeModel?: () => string };
  if (typeof sessionWithDispatch.describeModel === "function") {
    try {
      const described = sessionWithDispatch.describeModel();
      if (typeof described === "string" && described.trim().length > 0) {
        return described;
      }
    } catch {
      // fall through to the pi-native description below
    }
  }

  const model = session.model;
  if (!model) return "unknown model";
  return `${model.provider}/${model.id}`;
}

/**
 * FNXC:TaskLogModelThinking 2026-07-01-00:00:
 * Task-log model markers must keep the historical provider/model prefix stable while appending resolved thinking effort on the same row for operator diagnostics. Extra annotations stay parenthesized after the thinking-effort annotation so dashboard parsers can strip all suffix metadata deterministically.
 */
export function formatModelMarkerDetails(
  modelDescription: string,
  thinkingLevel?: string | null,
  annotations: string[] = [],
): string {
  const suffixes: string[] = [];
  const normalizedThinkingLevel = typeof thinkingLevel === "string" ? thinkingLevel.trim() : "";
  if (normalizedThinkingLevel) {
    suffixes.push(`thinking effort: ${normalizedThinkingLevel}`);
  }
  suffixes.push(...annotations.map((annotation) => annotation.trim()).filter(Boolean));
  if (suffixes.length === 0) return modelDescription;
  return `${modelDescription} ${suffixes.map((suffix) => `(${suffix})`).join(" ")}`;
}

/**
 * Default instructions used when calling `session.compact()` for loop recovery.
 * These guide the compaction summary to preserve essential context while
 * freeing up the context window for continued work.
 */
export const COMPACTION_FALLBACK_INSTRUCTIONS = [
  "Summarize all completed steps concisely.",
  "Preserve the current step number and any in-progress work details.",
  "Keep references to key files, decisions, and error states.",
  "Discard verbose tool output, repeated attempts, and exploration history.",
].join(" ");

const MAX_COMPACTED_PROMPT_MEMORY_CHARS = 8_000;
const MAX_COMPACTED_SUBTASK_GUIDANCE_CHARS = 1_200;
const MAX_COMPACTED_ATTACHMENTS_CHARS = 4_000;
const MAX_COMPACTED_EXISTING_SPEC_CHARS = 4_000;
const MAX_COMPACTED_TASK_PROMPT_CHARS = MAX_COMPACTED_EXISTING_SPEC_CHARS;
const MAX_COMPACTED_USER_COMMENTS_CHARS = 2_000;

function compactMarkdownMemorySection(sectionBody: string): string {
  const lines = sectionBody.split("\n");
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const normalized = trimmed.trimStart();
    const isUseful =
      normalized.startsWith("##")
      || normalized.startsWith("- ")
      || normalized.startsWith("* ")
      || /^\d+\.\s/.test(normalized)
      || normalized.length === 0;

    if (!isUseful) {
      continue;
    }

    const nextLength = used + trimmed.length + 1;
    if (nextLength > MAX_COMPACTED_PROMPT_MEMORY_CHARS) {
      break;
    }

    kept.push(trimmed);
    used = nextLength;
  }

  const compacted = kept.join("\n").trim();
  if (compacted.length >= sectionBody.trim().length) {
    return sectionBody.trim();
  }

  return [
    compacted,
    "",
    `<!-- Memory compacted from ${sectionBody.length} characters to avoid context overflow. Use memory tools or the selected memory file later only if essential. -->`,
  ].join("\n").trim();
}

function compactPromptMemory(prompt: string): string | null {
  const sectionPattern = /(^|\n)(## (?:Project Memory|Agent Memory|Memory)\n\n)([\s\S]*?)(?=\n## [^#]|\n# [^#]|$)/g;
  let changed = false;
  const compactedPrompt = prompt.replace(sectionPattern, (match, prefix: string, heading: string, body: string) => {
    const trimmedBody = body.trim();
    if (trimmedBody.length <= MAX_COMPACTED_PROMPT_MEMORY_CHARS) {
      return match;
    }

    const compacted = compactMarkdownMemorySection(trimmedBody);
    if (compacted.length >= trimmedBody.length) {
      return match;
    }

    changed = true;
    return `${prefix}${heading}${compacted}`;
  });

  return changed && compactedPrompt.length < prompt.length ? compactedPrompt : null;
}

function trimSubtaskSectionBody(body: string): string {
  const paragraphs = body
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const rawFirstParagraph = paragraphs[0] ?? "Subtask guidance omitted for context limits.";
  const maxFirstParagraphChars = Math.max(200, MAX_COMPACTED_SUBTASK_GUIDANCE_CHARS - 200);
  const firstParagraph = rawFirstParagraph.length > maxFirstParagraphChars
    ? `${rawFirstParagraph.slice(0, maxFirstParagraphChars)}…`
    : rawFirstParagraph;
  return [
    firstParagraph,
    "",
    "Follow the project's standard subtask split rules.",
  ].join("\n");
}

function compactAttachmentSectionBody(body: string): string {
  if (body.length <= MAX_COMPACTED_ATTACHMENTS_CHARS) {
    return body.trim();
  }

  const lines = body.split("\n");
  const kept: string[] = [];
  let inFence = false;
  let fenceHasContent = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (!inFence) {
        inFence = true;
        fenceHasContent = false;
        continue;
      }
      inFence = false;
      if (fenceHasContent) {
        kept.push("```", "_... attachment body trimmed ..._", "```");
      }
      continue;
    }

    if (inFence) {
      fenceHasContent = true;
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n").trim();
}

function compactExistingSpecificationSectionBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_COMPACTED_EXISTING_SPEC_CHARS) {
    return trimmed;
  }

  const head = trimmed.slice(0, Math.floor(MAX_COMPACTED_EXISTING_SPEC_CHARS / 2));
  const tail = trimmed.slice(-Math.floor(MAX_COMPACTED_EXISTING_SPEC_CHARS / 2));
  return `${head}\n\n_... existing specification middle trimmed ..._\n\n${tail}`;
}

function extractMarkdownSection(document: string, headingName: string): string {
  const heading = `## ${headingName}`;
  const start = document.indexOf(heading);
  if (start === -1) {
    return "";
  }

  const afterHeading = start + heading.length;
  const nextH2 = document.indexOf("\n## ", afterHeading);
  const nextH1 = document.indexOf("\n# ", afterHeading);
  const endCandidates = [nextH2, nextH1].filter((value) => value !== -1);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : document.length;

  return document.slice(start, end).trim();
}

function compactTaskPromptStepsSection(section: string): string {
  const stepTitles = Array.from(section.matchAll(/^### Step \d+:.*$/gm), (match) => match[0].trim());
  if (stepTitles.length === 0) {
    return section.trim();
  }

  return [
    "## Steps",
    ...stepTitles,
    "",
    "_... step checklist details trimmed for context limits ..._",
  ].join("\n").trim();
}

function truncateCompactedSection(section: string, maxChars: number, label: string): string {
  const trimmed = section.trim();
  if (!trimmed || trimmed.length <= maxChars) {
    return trimmed;
  }

  const marker = `_... ${label} trimmed for context limits ..._`;
  const headBudget = Math.max(200, maxChars - marker.length - 2);
  return [
    `${trimmed.slice(0, headBudget).trimEnd()}…`,
    "",
    marker,
  ].join("\n").trim();
}

function compactTaskPromptSectionBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_COMPACTED_TASK_PROMPT_CHARS) {
    return trimmed;
  }

  const fencedMatch = /^```markdown\s*\n([\s\S]*?)\n```$/m.exec(trimmed);
  const promptContent = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const firstSectionIndex = promptContent.indexOf("\n## ");
  const preamble = (firstSectionIndex === -1 ? promptContent : promptContent.slice(0, firstSectionIndex)).trim();
  const missionSection = extractMarkdownSection(promptContent, "Mission");
  const dependenciesSection = extractMarkdownSection(promptContent, "Dependencies");
  const fileScopeSection = extractMarkdownSection(promptContent, "File Scope");
  const stepsSection = compactTaskPromptStepsSection(extractMarkdownSection(promptContent, "Steps"));

  const compactedContent = [
    truncateCompactedSection(preamble, 400, "task header"),
    truncateCompactedSection(missionSection, 900, "mission"),
    truncateCompactedSection(dependenciesSection, 500, "dependencies"),
    truncateCompactedSection(fileScopeSection, 1_000, "file scope"),
    truncateCompactedSection(stepsSection, 1_200, "steps outline"),
    "_... remaining PROMPT.md sections trimmed for context limits ..._",
  ].filter(Boolean).join("\n\n").trim();

  const narrowedContent = compactedContent.length <= MAX_COMPACTED_TASK_PROMPT_CHARS
    ? compactedContent
    : compactExistingSpecificationSectionBody(compactedContent);
  const finalContent = fencedMatch ? `\`\`\`markdown\n${narrowedContent}\n\`\`\`` : narrowedContent;

  return finalContent.length < trimmed.length ? finalContent : compactExistingSpecificationSectionBody(trimmed);
}

function compactUserCommentsSectionBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_COMPACTED_USER_COMMENTS_CHARS) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  const commentLines = lines.filter((line) => /^- \*\*\[[^\]]+\]\*\*/.test(line));
  const staticLines = lines.filter((line) => !/^- \*\*\[[^\]]+\]\*\*/.test(line));
  const sortedComments = [...commentLines].sort((a, b) => {
    const aDate = a.match(/^- \*\*\[([^\]]+)\]\*\*/)?.[1] ?? "";
    const bDate = b.match(/^- \*\*\[([^\]]+)\]\*\*/)?.[1] ?? "";
    return bDate.localeCompare(aDate);
  });

  const kept: string[] = [];
  let used = staticLines.join("\n").length;
  for (const line of sortedComments) {
    const next = used + line.length + 1;
    if (next > MAX_COMPACTED_USER_COMMENTS_CHARS) {
      break;
    }
    kept.push(line);
    used = next;
  }

  const trimmedCount = Math.max(0, commentLines.length - kept.length);
  return [
    ...staticLines,
    "",
    ...kept,
    ...(trimmedCount > 0 ? ["", `_... ${trimmedCount} earlier comments trimmed ..._`] : []),
  ].join("\n").trim();
}

function compactLargePromptSections(prompt: string): string | null {
  const sectionPattern = /(^|\n)(## (?:Subtask Consideration|Subtask Breakdown Requested|Attachments|Existing Specification|Task PROMPT\.md|User Comments)\n)((?:\n*```markdown[\s\S]*?\n```|[\s\S]*?))(?=\n## [^#]|\n# [^#]|$)/g;
  let changed = false;

  const compactedPrompt = prompt.replace(sectionPattern, (match, prefix: string, heading: string, body: string) => {
    const headingName = heading.trim().replace(/^##\s+/, "");
    const trimmedBody = body.trim();

    const maxByHeading: Record<string, number> = {
      "Subtask Consideration": MAX_COMPACTED_SUBTASK_GUIDANCE_CHARS,
      "Subtask Breakdown Requested": MAX_COMPACTED_SUBTASK_GUIDANCE_CHARS,
      Attachments: MAX_COMPACTED_ATTACHMENTS_CHARS,
      "Existing Specification": MAX_COMPACTED_EXISTING_SPEC_CHARS,
      "Task PROMPT.md": MAX_COMPACTED_TASK_PROMPT_CHARS,
      "User Comments": MAX_COMPACTED_USER_COMMENTS_CHARS,
    };

    const maxChars = maxByHeading[headingName] ?? MAX_COMPACTED_PROMPT_MEMORY_CHARS;
    if (trimmedBody.length <= maxChars) {
      return match;
    }

    let compactedBody = trimmedBody;
    if (headingName === "Subtask Consideration" || headingName === "Subtask Breakdown Requested") {
      compactedBody = trimSubtaskSectionBody(trimmedBody);
    } else if (headingName === "Attachments") {
      compactedBody = compactAttachmentSectionBody(trimmedBody);
    } else if (headingName === "Existing Specification") {
      compactedBody = compactExistingSpecificationSectionBody(trimmedBody);
    } else if (headingName === "Task PROMPT.md") {
      compactedBody = compactTaskPromptSectionBody(trimmedBody);
    } else if (headingName === "User Comments") {
      compactedBody = compactUserCommentsSectionBody(trimmedBody);
    }

    const finalBody = [
      compactedBody,
      "",
      `<!-- Section trimmed from ${trimmedBody.length} characters to fit context window. -->`,
    ].join("\n").trim();

    if (finalBody.length >= trimmedBody.length) {
      return match;
    }

    changed = true;
    return `${prefix}${heading}${finalBody}`;
  });

  return changed && compactedPrompt.length < prompt.length ? compactedPrompt : null;
}

export const __testOnlyPromptCompaction = {
  compactLargePromptSections,
};

async function retryWithCompactedPromptMemory(
  session: AgentSession,
  prompt: string,
  options?: unknown,
): Promise<{ recovered: boolean; error?: unknown }> {
  const compactedPrompt = compactPromptMemory(prompt);
  if (!compactedPrompt) {
    return { recovered: false };
  }

  piLog.log(
    `promptWithFallback: retrying with compacted prompt memory (${prompt.length} → ${compactedPrompt.length} chars)`,
  );

  try {
    await promptSessionAndCheck(session, compactedPrompt, options);
    piLog.log("promptWithFallback: prompt completed after prompt-memory compaction");
    return { recovered: true };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    piLog.error(`promptWithFallback: retry after prompt-memory compaction failed: ${errorMessage}`);
    return { recovered: false, error: err };
  }
}

async function retryWithCompactedPromptSections(
  session: AgentSession,
  prompt: string,
  options?: unknown,
): Promise<{ recovered: boolean; error?: unknown }> {
  const compactedPrompt = compactLargePromptSections(prompt);
  if (!compactedPrompt) {
    return { recovered: false };
  }

  piLog.log(
    `promptWithFallback: retrying with compacted prompt sections (${prompt.length} → ${compactedPrompt.length} chars)`,
  );

  try {
    await promptSessionAndCheck(session, compactedPrompt, options);
    piLog.log("promptWithFallback: prompt completed after section compaction");
    return { recovered: true };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    piLog.error(`promptWithFallback: retry after section compaction failed: ${errorMessage}`);
    return { recovered: false, error: err };
  }
}

async function flushMemoryBeforeSessionCompaction(session: AgentSession): Promise<void> {
  if ((session as any).__fusionMemoryAppendAvailable !== true) {
    return;
  }

  const flushPrompt = [
    "Before context compaction, preserve only unresolved durable memory if needed.",
    "If fn_memory_append is available and you learned reusable project decisions/conventions/pitfalls/open loops or private operating context that is not already saved, append it now.",
    "Use scope=\"project\" for shared workspace knowledge and scope=\"agent\" for private operating context.",
    "Use layer=\"long-term\" for durable facts and layer=\"daily\" for running notes/open loops.",
    "If there is nothing durable to save, reply exactly: NONE.",
  ].join("\n");

  try {
    await promptSessionAndCheck(session, flushPrompt);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    piLog.warn(`promptWithFallback: memory flush before compaction skipped: ${errorMessage}`);
  }
}

/**
 * Compact an agent session's context to free up the context window.
 *
 * Uses the SDK's native `session.compact()` method when available (the
 * preferred path — it produces structured, LLM-generated summaries).
 *
 * @param session — The agent session to compact
 * @param customInstructions — Optional instructions for the compaction summary.
 *   When not provided, uses COMPACTION_FALLBACK_INSTRUCTIONS.
 * @returns The compaction result with summary and token metrics, or null if
 *   compaction was not available or failed.
 */
export async function compactSessionContext(
  session: AgentSession,
  customInstructions?: string,
): Promise<{ summary: string; tokensBefore: number } | null> {
  const instructions = customInstructions ?? COMPACTION_FALLBACK_INSTRUCTIONS;

  // Check if session.compact is available (runtime capability detection)
  if (typeof (session as any).compact !== "function") {
    return null;
  }

  try {
    const result = await (session as any).compact(instructions);
    if (result && typeof result === "object") {
      return {
        summary: result.summary ?? "",
        tokensBefore: result.tokensBefore ?? 0,
      };
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    piLog.warn(`Context compaction failed (will fall through to kill/requeue): ${msg}`);
    return null;
  }
}

export interface FallbackModelUsedPayload {
  primaryModel: string;
  fallbackModel: string;
  triggerPoint: "session-creation" | "prompt-time";
  taskId?: string;
  taskTitle?: string;
  timestamp?: string;
}

export class ModelFallbackExhaustedError extends Error {
  readonly primaryModel: string;
  readonly fallbackModel?: string;
  readonly triggerPoint: "session-creation" | "prompt-time";
  readonly attempts: number;
  readonly underlyingReason: string;

  constructor(input: {
    primaryModel: string;
    fallbackModel?: string;
    triggerPoint: "session-creation" | "prompt-time";
    attempts: number;
    underlyingReason: string;
  }) {
    const fallbackClause = input.fallbackModel ? `, fallback ${input.fallbackModel}` : ", no fallback configured";
    super(
      `Unable to select a usable model after ${input.attempts} attempt${input.attempts === 1 ? "" : "s"} `
      + `(primary ${input.primaryModel}${fallbackClause}, trigger: ${input.triggerPoint}): ${input.underlyingReason}`,
    );
    this.name = "ModelFallbackExhaustedError";
    this.primaryModel = input.primaryModel;
    this.fallbackModel = input.fallbackModel;
    this.triggerPoint = input.triggerPoint;
    this.attempts = input.attempts;
    this.underlyingReason = input.underlyingReason;
  }
}

export type BuiltinWebToolName = "WebSearch" | "WebFetch";

export interface AgentOptions {
  cwd: string;
  systemPrompt: string;
  /**
   * FNXC:PluginProviderBridge 2026-07-11-00:00:
   * FUSI-069: optional PluginRunner used to bridge enabled Fusion-plugin
   * `cliProviders` (e.g. cursor-cli) into the execution ModelRegistry seeded
   * by `registerExtensionProviders`. Omitted (or a caller with no plugin
   * runner) degrades safely to the pre-existing zai/grok/pi-extension-only
   * seeding — no plugin-provider models are registered, but nothing throws.
   */
  pluginRunner?: PluginRunner;
  /** Structured prompt layers for cross-session caching. When provided,
   *  the stable layer is used as systemPromptOverride and the dynamic
   *  layer as appendSystemPromptOverride. Falls back to systemPrompt
   *  when not provided. */
  systemPromptLayers?: SystemPromptLayers;
  tools?: "coding" | "readonly";
  customTools?: ToolDefinition[];
  /**
   * Optional resolved tool-name allowlist. Undefined preserves the selected tool mode; an empty array deliberately exposes no matched tools.
   *
   * FNXC:AutomationTools 2026-06-26-00:00:
   * Automation AI steps can narrow coding sessions by tool name while legacy steps keep all tools. Normalize names case-insensitively at the engine boundary so dashboard labels like "Read" match pi tool names like "read".
   */
  toolsAllowlist?: string[];
  /** Optional allowlist of builtin runtime web tools to keep enabled. */
  builtinToolsAllowlist?: BuiltinWebToolName[];
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
  /** Default model provider (e.g. "anthropic"). Used with `defaultModelId` to select a specific model. */
  defaultProvider?: string;
  /** Default model ID within the provider (e.g. "claude-sonnet-4-5"). Used with `defaultProvider`. */
  defaultModelId?: string;
  /** Optional fallback model provider used when the primary selected model hits
   *  a retryable provider-side failure such as rate limiting or overload. */
  fallbackProvider?: string;
  /** Optional fallback model ID used with `fallbackProvider`. */
  fallbackModelId?: string;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Fallback model swaps must honor the fallback model's configured thinking level while preserving the lane/default thinking level when no fallback-specific value is set.
   */
  fallbackThinkingLevel?: string;
  /** Default thinking effort level (e.g. "medium", "high"). When provided, sets the session's thinking level after creation. */
  defaultThinkingLevel?: string;
  /** Optional pre-configured SessionManager. When provided, the agent session
   *  uses this instead of creating an in-memory session. Pass a file-based
   *  SessionManager to enable session persistence and pause/resume. */
  sessionManager?: SessionManager;
  /** Optional skill selection context. When provided, the agent session's
   *  skills are filtered according to project execution settings and any
   *  caller-requested skill names. Omit to use default skill discovery
   *  (all discovered skills included). */
  skillSelection?: SkillSelectionContext;
  /** Convenience: skill names to include in the session. When provided
   *  (and `skillSelection` is not), auto-constructs a SkillSelectionContext
   *  from the cwd and these names. Ignored when `skillSelection` is set. */
  skills?: string[];
  /** Extra directories to scan for skills (each holding `<id>/SKILL.md`), in
   *  addition to the default cwd/agent-dir roots. Forwarded to the resource
   *  loader so callers (e.g. plugins that install skills to a private dir) can
   *  make `skills`/`skillSelection` names discoverable in the live session. */
  additionalSkillPaths?: string[];
  /**
   * Resolved/materialized MCP servers for the session. The runtime-support guard
   * below decides whether to forward or skip them without logging contents.
   */
  mcpServers?: ResolvedMcpServerDefinition[];
  /**
   * Allow connected MCP session tools through the read-only custom-tool filter.
   * Defaults to false so validators/read-only helpers do not inherit arbitrary external tools.
   */
  allowMcpToolsInReadonly?: boolean;
  /** Test seam for MCP session tools; production uses the SDK client/transport factories. */
  mcpClientFactory?: McpClientFactory;
  /**
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-076 remediation: real callers (dashboard manual-AI-prompt path, and any future task-store-backed lane)
   * can inject the store-backed OAuth token writeback seam directly, or supply `mcpSettingsStore` +
   * `mcpServerScopeByName` below so `connectMcpSessionTools` builds it itself via `buildMcpOAuthTokenStore`.
   * Without either, MCP OAuth refresh stays in-memory-only for this session (the FUSI-074 warn-only default) —
   * this option is what closes that gap for real (non-test) callers.
   */
  mcpOAuthTokenStore?: McpOAuthTokenStore;
  /**
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-076: a settings/secrets-capable store (e.g. a `TaskStore`) used to build the real persisted
   * `McpOAuthTokenStore` when `mcpOAuthTokenStore` is not explicitly supplied. See `mcp-resolution.ts`'s
   * `buildMcpOAuthTokenStore` / `McpSettingsAndSecretsStore`.
   */
  mcpSettingsStore?: McpSettingsAndSecretsStore;
  /**
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-076: owning scope (project vs global) per resolved MCP server name, from
   * `resolveMcpServersForRuntime`/`resolveMcpServersForStore`'s `scopeByServerName`. Required for OAuth token
   * writeback to address the correct settings scope; omit only when the server's scope is unknown (writeback
   * then fails soft to a coarse warn).
   */
  mcpServerScopeByName?: Record<string, SecretScope>;
  /** Optional task-scoped env injected into this session's subprocess tools only. */
  taskEnv?: NodeJS.ProcessEnv;
  /** Last-chance abort hook fired immediately before `createAgentSession`.
   *  See `AgentRuntimeOptions.beforeSpawnSession`. */
  beforeSpawnSession?: () => Promise<void> | void;
  /** Callback fired when runtime falls back from primary model to fallback model. */
  onFallbackModelUsed?: (payload: FallbackModelUsedPayload) => Promise<void> | void;
  /** Optional task context for fallback notifications. */
  taskId?: string;
  taskTitle?: string;
  actionGateContext?: AgentActionGateContext;
  /** Permanent-agent action gating context forwarded by runtime/session helpers. */
  permanentAgentGating?: PermanentAgentGatingContext;
}

/**
 * Map a user-facing custom-provider `apiType` to the pi-ai api-registry key.
 *
 * FNXC:CustomProviders 2026-06-21-13:45:
 * Every arm must return a key that pi-ai's api-registry actually registers
 * (see @earendil-works/pi-ai register-builtins). `anthropic-compatible` resolves
 * to "anthropic-messages" — the key the Anthropic Messages API is registered
 * under. The bare "anthropic" key is never registered, so returning it let a
 * provider register but threw "No API provider registered for api: anthropic"
 * the moment a task tried to stream.
 *
 * @param apiType - the custom provider's declared compatibility type.
 * @returns the registered pi-ai api key to stream against.
 */
function resolveCustomProviderApiType(apiType: string): "anthropic-messages" | "openai-responses" | "openai-completions" {
  if (apiType === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (apiType === "openai-responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

function resolveConfiguredModel(
  modelRegistry: ModelRegistry,
  kind: "primary" | "fallback",
  provider?: string,
  modelId?: string,
) {
  if (!provider || !modelId) {
    return undefined;
  }

  const model = modelRegistry.find(provider, modelId);
  if (model) {
    return model;
  }

  // Fall back to constructing a model on-the-fly if the provider is known.
  // This mirrors the pi CLI's buildFallbackModel behaviour, which accepts any
  // model ID for a configured provider (e.g. any OpenRouter model string) even
  // when it isn't in the built-in or custom model list.
  const providerModels = modelRegistry.getAll().filter((m) => m.provider === provider);
  if (providerModels.length > 0) {
    const baseModel = providerModels[0]!;
    piLog.warn(`${kind} model ${provider}/${modelId} not in registry; using provider base model as template`);
    return { ...baseModel, id: modelId, name: modelId };
  }

  throw new Error(
    `Configured model ${provider}/${modelId} (${kind} selection) was not found in the pi model registry. `
    + "If this model comes from a custom provider, verify Settings → Custom Providers (stored in ~/.fusion/settings.json) includes this provider/model, "
    + "or choose an available model from /api/models.",
  );
}

export function isRetryableModelSelectionError(message: string): boolean {
  // Codex ChatGPT-account auth-tier model incompatibility: the model is valid
  // but not available for the current auth tier. This is a model-selection
  // problem — a configured fallback model may work. Treat as retryable so the
  // fallback path is tried once (the `usingFallback` guard prevents infinite
  // swaps).
  if (isModelAuthTierIncompatibilityError(message)) {
    return true;
  }

  // An unsupported message-role rejection (e.g. a reasoning model sending the
  // "developer" system role to a provider that only accepts
  // system/user/assistant/tool) is fundamentally a model+provider
  // compatibility problem. Treat it as a model-selection error so a configured
  // fallback model is tried once before the task is marked failed. The
  // `usingFallback` guard upstream keeps this to a single swap, so an
  // incompatible fallback fails terminally rather than looping.
  if (isUnsupportedMessageRoleError(message)) {
    return true;
  }
  /*
   * FNXC:ModelFallback 2026-07-01-16:42:
   * Prompt-time provider 404s for a selected model, including Anthropic's sparse `not_found_error` for Claude Sonnet 5 account/surface gaps, must enter the same single-swap fallback path as auth-tier and role-compatibility failures. Generic 404s remain excluded by the classifier.
   */
  if (isProviderModelNotFoundError(message)) {
    return true;
  }
  const normalized = message.toLowerCase();
  return normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("429")
    || normalized.includes("401")
    || normalized.includes("403")
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("authentication")
    || normalized.includes("invalid api key")
    || normalized.includes("invalid key")
    || normalized.includes("api key")
    || normalized.includes("overloaded")
    || normalized.includes("quota")
    || normalized.includes("capacity")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("invalid temperature");
}

interface PackageManagerSettingsView {
  getGlobalSettings(): Record<string, any>;
  getProjectSettings(): Record<string, any>;
  getNpmCommand(): string[] | undefined;
  isProjectTrusted(): boolean;
}

function readJsonObject(path: string): Record<string, any> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

/*
FNXC:ProviderAuth 2026-07-01-14:55:
Anthropic has three independent execution surfaces with NO runtime rerouting: direct OAuth and raw API key both run on pi-ai's built-in `anthropic` provider (OAuth → `/v1` with Claude Code impersonation; raw key → x-api-key), and explicit `pi-claude-cli/<model>` runs the vendored CLI. Do NOT register or route through an `/v1`-based `anthropic-subscription` provider — that reroute reintroduced the #1857 regression (FN-7391/FN-7396).
*/

function normalizeSessionHistoryEntries(sessionManager: SessionManagerLike): void {
  const entries = sessionManager.fileEntries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }

  let changed = false;
  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") {
      continue;
    }
    const role = entry.message.role;
    if (role !== "assistant" && role !== "toolResult") {
      continue;
    }
    if (!("content" in entry.message)) {
      entry.message.content = [];
      changed = true;
    }
  }

  if (changed) {
    sessionManager._rewriteFile?.();
  }
}

function normalizeAssistantOrToolResultMessage(message: unknown): message is Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return false;
  }

  const role = (message as Record<string, unknown>).role;
  if (role !== "assistant" && role !== "toolResult" && role !== "user") {
    return false;
  }

  const obj = message as Record<string, unknown>;
  // `user` messages may carry content as a string (plain prompt) — leave those alone.
  // For any other shape (undefined, null, object, etc.) coerce to an empty array so
  // pi-coding-agent's _getUserMessageText (content.filter(...)) can't crash.
  if (role === "user") {
    if (typeof obj.content !== "string" && !Array.isArray(obj.content)) {
      obj.content = [];
    }
    return true;
  }

  if (!Array.isArray(obj.content)) {
    obj.content = [];
  }
  return true;
}

function syncNormalizedMessageIntoAgentState(session: AgentToolHookSession, message: Record<string, unknown>): void {
  const messages = session.agent?.state?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (candidate === message) {
      normalizeAssistantOrToolResultMessage(candidate);
      return;
    }

    if (candidate.role !== message.role) {
      continue;
    }

    if (candidate.role === "toolResult") {
      if (candidate.toolCallId === message.toolCallId && candidate.toolName === message.toolName) {
        normalizeAssistantOrToolResultMessage(candidate);
        return;
      }
      continue;
    }

    if (candidate.timestamp === message.timestamp) {
      normalizeAssistantOrToolResultMessage(candidate);
      return;
    }
  }
}

function installToolResultContentGuard(session: AgentToolHookSession): void {
  if (session.__fusionToolResultGuardInstalled || !session.agent?.afterToolCall) {
    return;
  }

  const originalAfterToolCall = session.agent.afterToolCall.bind(session.agent) as any;
  (session.agent as any).afterToolCall = async (payload: ToolHookPayload) => {
    const hookResult = await originalAfterToolCall(payload);
    if (!hookResult || typeof hookResult !== "object") {
      return hookResult;
    }

    const content = hookResult.content ?? payload.result?.content ?? [];
    return {
      content: Array.isArray(content) ? content : [],
      details: hookResult.details ?? payload.result?.details,
      isError: hookResult.isError ?? payload.isError,
    };
  };
  session.__fusionToolResultGuardInstalled = true;
}

function installMessageContentGuard(session: AgentToolHookSession, sessionManager: SessionManagerLike): void {
  if (session.__fusionMessageContentGuardInstalled) {
    return;
  }

  // Sweep any pre-existing state.messages (e.g. restored from a session file)
  // so messages with malformed content can't crash pi-coding-agent's
  // _getUserMessageText / similar array traversals before our event hooks fire.
  const existingMessages = session.agent?.state?.messages;
  if (Array.isArray(existingMessages)) {
    for (const candidate of existingMessages) {
      normalizeAssistantOrToolResultMessage(candidate);
    }
  }

  if (typeof session.subscribe === "function") {
    session.subscribe((event: unknown) => {
      if (!event || typeof event !== "object" || (event as { type?: string }).type !== "message_end") {
        return;
      }

      const message = (event as { message?: unknown }).message;
      if (!normalizeAssistantOrToolResultMessage(message)) {
        return;
      }

      syncNormalizedMessageIntoAgentState(session, message);
    });
  }

  if (typeof sessionManager.appendMessage === "function") {
    const originalAppendMessage = sessionManager.appendMessage.bind(sessionManager);
    sessionManager.appendMessage = (message: Record<string, unknown>) => {
      normalizeAssistantOrToolResultMessage(message);
      syncNormalizedMessageIntoAgentState(session, message);
      return originalAppendMessage(message);
    };
  }

  session.__fusionMessageContentGuardInstalled = true;
}

function hasPackageManagerSettings(settings: Record<string, any>): boolean {
  return Array.isArray(settings.packages) || Array.isArray(settings.npmCommand);
}

function siblingAgentDir(agentDir: string, siblingRoot: ".fusion" | ".pi"): string | undefined {
  if (basename(agentDir) !== "agent") {
    return undefined;
  }
  return join(dirname(dirname(agentDir)), siblingRoot, "agent");
}

export function createReadOnlyPiSettingsView(cwd: string, agentDir: string): PackageManagerSettingsView {
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  const fusionAgentDir = agentDir.includes(`${join(".fusion", "agent")}`)
    ? agentDir
    : siblingAgentDir(agentDir, ".fusion");
  const legacyAgentDir = agentDir.includes(`${join(".pi", "agent")}`)
    ? agentDir
    : siblingAgentDir(agentDir, ".pi");
  const legacyGlobalSettings = legacyAgentDir ? readJsonObject(join(legacyAgentDir, "settings.json")) : {};
  const fusionGlobalSettings = fusionAgentDir ? readJsonObject(join(fusionAgentDir, "settings.json")) : {};
  const directGlobalSettings = readJsonObject(join(agentDir, "settings.json"));
  const globalSettings = { ...legacyGlobalSettings, ...directGlobalSettings, ...fusionGlobalSettings };
  const fusionProjectSettings = readJsonObject(join(projectRoot, ".fusion", "settings.json"));
  const mergedSettings = { ...globalSettings, ...fusionProjectSettings };

  return {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(fusionProjectSettings),
    getNpmCommand: () => Array.isArray(mergedSettings.npmCommand)
      ? [...mergedSettings.npmCommand]
      : undefined,
    // Pi's SettingsManager defaults projects to trusted. Fusion workspaces are
    // user-owned, so preserve pre-upgrade behavior and keep project-scoped
    // .fusion resources loadable through the read-only settings view.
    isProjectTrusted: () => true,
  };
}

function getPackageManagerAgentDir(): string {
  const fusionAgentDir = getFusionAgentDir();
  const legacyAgentDir = getLegacyPiAgentDir();
  const fusionSettings = readJsonObject(join(fusionAgentDir, "settings.json"));
  const legacySettings = readJsonObject(join(legacyAgentDir, "settings.json"));

  if (hasPackageManagerSettings(fusionSettings) || !existsSync(legacyAgentDir)) {
    return fusionAgentDir;
  }
  if (hasPackageManagerSettings(legacySettings)) {
    return legacyAgentDir;
  }
  return existsSync(fusionAgentDir) ? fusionAgentDir : legacyAgentDir;
}

/**
 * Resolve the absolute path to Fusion's vendored `@fusion/pi-claude-cli`
 * extension entry. Used by `registerExtensionProviders` to ensure the fork
 * always wins over any externally-installed `pi-claude-cli`.
 *
 * Returns null when the vendored package isn't available (e.g. someone
 * embedded `@fusion/engine` standalone without bundling the fork) — callers
 * should treat that as "no override needed, leave external paths alone".
 */
function resolveVendoredClaudeCliEntry(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve("@fusion/pi-claude-cli/package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
      pi?: { extensions?: unknown };
    };
    const extensions = pkgJson.pi?.extensions;
    if (!Array.isArray(extensions) || extensions.length === 0) return null;
    const entry = extensions[0];
    if (typeof entry !== "string" || entry.length === 0) return null;
    const path = resolve(dirname(pkgJsonPath), entry);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path to Fusion's vendored `@fusion/droid-cli`
 * extension entry. Used by `registerExtensionProviders` to ensure the
 * vendored extension always wins over any externally-installed `droid-cli`.
 */
function resolveVendoredDroidCliEntry(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve("@fusion/droid-cli/package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
      pi?: { extensions?: unknown };
    };
    const extensions = pkgJson.pi?.extensions;
    if (!Array.isArray(extensions) || extensions.length === 0) return null;
    const entry = extensions[0];
    if (typeof entry !== "string" || entry.length === 0) return null;
    const path = resolve(dirname(pkgJsonPath), entry);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * FNXC:PluginProviderBridge 2026-07-11-00:00:
 * FUSI-069: bridge one enabled Fusion-plugin `cliProviders` contribution (e.g.
 * cursor-cli) into the pi execution `ModelRegistry`. Mirrors the shape used by
 * `GROK_PROVIDER_REGISTRATION` (grok-provider.ts) but the models are
 * registered with an inert `streamSimple` that throws immediately rather than
 * an HTTP baseUrl/api pair: `cursor-agent` (and any future plugin CLI runtime)
 * has no HTTP endpoint, so execution must always be dispatched to the plugin
 * runtime (see `deriveCursorRuntimeHint` in agent-session-helpers.ts) — this
 * registration exists only to make `provider/modelId` RESOLVABLE (so
 * `resolveConfiguredModel` in this file stops throwing "not found in the pi
 * model registry"), never to be streamed against directly. If routing ever
 * fails to intercept a plugin-provider session, the thrown error names the
 * misroute instead of silently attempting a bogus network call.
 *
 * Guard contract (required by the task's Do-NOT list): a single unavailable /
 * unauthenticated / throwing plugin provider degrades to ZERO registered rows
 * for THAT provider and must never abort the caller's loop or the surrounding
 * zai/grok/pi-extension registration.
 */
async function registerPluginCliProvider(
  modelRegistry: ModelRegistry,
  pluginRunner: PluginRunner,
  pluginId: string,
  contribution: CliProviderContribution,
): Promise<void> {
  const providerId = contribution.providerId;
  if (!providerId || !contribution.discoverModels) return;

  try {
    const pluginContext = await pluginRunner.createRuntimeContext(pluginId);
    if (!pluginContext) {
      extensionsLog.warn(`Skipping plugin cliProvider "${providerId}" from "${pluginId}": no runtime context available`);
      return;
    }

    const discovery = await contribution.discoverModels(pluginContext);
    const discoveredModels = Array.isArray(discovery?.models) ? discovery.models : [];
    if (discoveredModels.length === 0) {
      // Unauthenticated/unavailable/binary-missing degrades to zero rows —
      // never a throw, never a partial/garbage registration.
      return;
    }

    /*
     * FNXC:SessionRouting 2026-07-13-00:00:
     * FUSI-090: this placeholder MUST NOT reuse a shared/real api id like
     * "openai-completions". `@earendil-works/pi-ai`'s api-provider dispatch
     * table (`apiProviderRegistry` in its compat.js) is a single
     * PROCESS-GLOBAL Map keyed ONLY by the `api` string, not by provider name
     * and not scoped per ModelRegistry instance/task. `ModelRegistry.
     * applyProviderConfig()` calls the SDK's `registerApiProvider()` (a plain
     * last-writer-wins Map.set) whenever a provider config declares
     * `streamSimple` — so registering this placeholder under
     * "openai-completions" clobbered the SAME global dispatch slot used by
     * every real openai-compatible provider (built-in OpenAI/OpenRouter and
     * any custom provider such as Ollama/LM Studio/vLLM) for the remainder of
     * the process, causing a same-session (no concurrency required) or
     * cross-task Ollama/custom-provider stream to hit this throwing
     * placeholder instead of its own real HTTP path (FUSI-090). Each plugin
     * cliProvider gets a dedicated, per-provider-unique api id instead
     * (`@earendil-works/pi-ai`'s `Api` type is an open string type, so this is
     * fully supported) — this gives the placeholder its own isolated slot in
     * the global dispatch map that no other provider's models ever share,
     * structurally preventing the cross-wire in both directions.
     */
    const placeholderApi = `fusion-plugin-cli:${providerId}`;
    modelRegistry.registerProvider(providerId, {
      name: contribution.displayName ?? providerId,
      // No real HTTP endpoint: `cursor-agent` (and any plugin cliProvider) is
      // dispatched by runtimeHint to the plugin runtime, never streamed by pi.
      // pi's registerProvider() requires a baseUrl when models are supplied;
      // this placeholder is never dialed because streamSimple below always
      // throws before any network call would be attempted.
      api: placeholderApi,
      baseUrl: "fusion-plugin-cli-provider://" + providerId,
      // No credentials are ever sent: streamSimple below throws before any
      // request would be constructed. This placeholder only satisfies pi's
      // registerProvider() validation that a models-bearing provider config
      // declares an apiKey or oauth.
      apiKey: "fusion-plugin-cli-provider-unused",
      streamSimple: () => {
        throw new Error(
          `Provider "${providerId}" is a plugin cliProvider with no HTTP endpoint; it must be dispatched to `
          + `the "${contribution.runtime?.runtimeId ?? providerId}" plugin runtime instead of pi's direct stream path.`,
        );
      },
      models: discoveredModels.map((model) => {
        const metadata = (model as { reasoning?: boolean; contextWindow?: number; metadata?: Record<string, unknown> }) ?? {};
        const reasoning = typeof metadata.reasoning === "boolean"
          ? metadata.reasoning
          : typeof metadata.metadata?.reasoning === "boolean"
            ? (metadata.metadata!.reasoning as boolean)
            : false;
        const contextWindow = typeof metadata.contextWindow === "number"
          ? metadata.contextWindow
          : typeof metadata.metadata?.contextWindow === "number"
            ? (metadata.metadata!.contextWindow as number)
            : 128000;
        return {
          id: model.id,
          name: model.label ?? model.id,
          reasoning,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: 65536,
        };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    extensionsLog.warn(`Failed to bridge plugin cliProvider "${providerId}" from "${pluginId}": ${message}`);
  }
}

/**
 * FNXC:PluginProviderBridge 2026-07-11-00:00:
 * FUSI-069: iterate every enabled plugin `cliProviders` contribution and bridge
 * each independently via `registerPluginCliProvider`. Each provider is fully
 * isolated: a failure/degrade for one provider must never affect another, or
 * the zai/grok/pi-extension registrations already performed above.
 */
async function registerPluginCliProviders(
  modelRegistry: ModelRegistry,
  pluginRunner: PluginRunner | undefined,
): Promise<void> {
  if (!pluginRunner) return;
  let contributions: Array<{ pluginId: string; contribution: CliProviderContribution }>;
  try {
    contributions = pluginRunner.getCliProviderContributions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    extensionsLog.warn(`Failed to list plugin cliProvider contributions: ${message}`);
    return;
  }
  for (const { pluginId, contribution } of contributions) {
    await registerPluginCliProvider(modelRegistry, pluginRunner, pluginId, contribution);
  }
}

// Exported (in addition to being used internally by createFnAgent) so unit
// tests can exercise the plugin cliProviders bridge (FUSI-069) directly
// against a fake ModelRegistry/PluginRunner without spinning up a full pi
// session.
export async function registerExtensionProviders(
  cwd: string,
  modelRegistry: ModelRegistry,
  pluginRunner?: PluginRunner,
): Promise<void> {
  registerBuiltInZaiProvider(modelRegistry, (message) => extensionsLog.warn(message));
  registerBuiltInGrokProvider(modelRegistry, (message) => extensionsLog.warn(message));

  try {
    const agentDir = getPackageManagerAgentDir();
    const settingsView = createReadOnlyPiSettingsView(cwd, agentDir);

    // Route A enable (experimental, DEFAULT ON): translate
    // experimentalFeatures.claudeCliAcp into the FUSION_CLAUDE_ACP dispatch the
    // pi-claude-cli provider reads. Still fail-closed — with no bridge path
    // published (acp-runtime plugin absent), the provider falls back to `-p`.
    applyClaudeAcpEnable(settingsView.getGlobalSettings() as Record<string, unknown>);

    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settingsView as any,
    });
    const resolvedPaths = await packageManager.resolve();
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path);

    // Always prefer Fusion's vendored `@fusion/pi-claude-cli` over any external
    // `pi-claude-cli` install (e.g. a global `npm install -g pi-claude-cli`,
    // or `npm:pi-claude-cli` in agent settings). Upstream has known timing
    // and once-and-lock MCP-config bugs that we fix in the fork; loading both
    // also produces unpredictable provider-registration winners.
    const vendoredClaudeCli = resolveVendoredClaudeCliEntry();
    const reconciledPaths = reconcileClaudeCliPaths(
      [...getEnabledPiExtensionPaths(cwd), ...packageExtensionPaths],
      vendoredClaudeCli,
    );

    // Prefer Fusion's vendored `@fusion/droid-cli` over any external
    // `droid-cli` install. Side-by-side loading of two extensions that
    // register the same provider name produces unpredictable winners.
    const vendoredDroidCli = resolveVendoredDroidCliEntry();
    const doubleReconciledPaths = reconcileDroidCliPaths(
      reconciledPaths,
      vendoredDroidCli,
    );

    const extensionsResult = await discoverAndLoadExtensions(
      doubleReconciledPaths,
      cwd,
      join(resolvePiExtensionProjectRoot(cwd), ".fusion", "disabled-auto-extension-discovery"),
    );

    for (const { path, error } of extensionsResult.errors) {
      extensionsLog.warn(`Failed to load ${path}: ${error}`);
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        extensionsLog.warn(`Failed to register provider from ${extensionPath}: ${message}`);
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    mergeBuiltInZaiProviderModels(modelRegistry, (message) => extensionsLog.warn(message));
    mergeBuiltInGrokProviderModels(modelRegistry, (message) => extensionsLog.warn(message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    extensionsLog.error(`Failed to discover extensions: ${message}`);
    createExtensionRuntime();
  }

  /*
   * FNXC:PluginProviderBridge 2026-07-11-00:00:
   * FUSI-069: bridge enabled Fusion-plugin cliProviders (cursor-cli, and any
   * future plugin CLI runtime) AFTER built-in + pi-extension registration and
   * BEFORE the final refresh(), and deliberately outside the pi-extension
   * try/catch above so a pi-extension discovery failure never prevents plugin
   * cliProviders from registering (and vice versa — each provider is already
   * independently guarded inside registerPluginCliProvider).
   */
  await registerPluginCliProviders(modelRegistry, pluginRunner);
  modelRegistry.refresh();
}

// ── Worktree Path Boundary Helpers ──────────────────────────────────────────

export { getProjectRootFromWorktree };

async function isRegisteredGitWorktree(projectRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    const resolvedWorktree = normalizeExistingPathForGitComparison(worktreePath);
    return stdout.split("\n").some((line) =>
      line.startsWith("worktree ") && normalizeExistingPathForGitComparison(line.slice("worktree ".length)) === resolvedWorktree
    );
  } catch {
    return false;
  }
}

function normalizeExistingPathForGitComparison(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isSameOrInsidePath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function isCompleteGitWorktree(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return normalizeExistingPathForGitComparison(stdout.trim()) === normalizeExistingPathForGitComparison(worktreePath);
  } catch {
    return false;
  }
}

async function assertValidWorktreeSession(cwd: string, projectRoot: string): Promise<void> {
  if (!existsSync(cwd)) {
    throw new Error(`Refusing to start coding agent in missing worktree: ${cwd}`);
  }
  if (!existsSync(join(cwd, ".git")) || !await isCompleteGitWorktree(cwd)) {
    throw new Error(`Refusing to start coding agent in incomplete worktree: ${cwd}`);
  }
  if (!await isRegisteredGitWorktree(projectRoot, cwd)) {
    throw new Error(`Refusing to start coding agent in unregistered git worktree: ${cwd}`);
  }
}

/**
 * Check if a path is allowed to be accessed from a worktree session.
 * Rules:
 * - Paths inside the worktree are always allowed
 * - Project root .fusion/memory/ files are allowed (for durable project learnings)
 * - Task attachments under .fusion/tasks/N/attachments/ are allowed (for reading context files)
 * - Sibling task specs (.fusion/tasks/N/PROMPT.md and task.json) are allowed for
 *   read-only tools (read/glob/grep) so agents can consult dependency specs.
 * - All other paths outside the worktree are rejected
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectRoot - Absolute path to the project root (derived from worktree)
 * @param requestedPath - The path being accessed
 * @param toolName - Tool making the request (controls read-only exceptions)
 * @returns true if allowed, false if rejected
 */
function isWorktreeAllowedPath(
  worktreePath: string,
  projectRoot: string,
  requestedPath: string,
  toolName?: string,
): boolean {
  // Normalize paths
  const worktreeResolved = resolve(worktreePath);
  const projectRootResolved = resolve(projectRoot);
  const requestedResolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(worktreeResolved, requestedPath);
  const worktreeCanonical = normalizeExistingPathForGitComparison(worktreeResolved);
  const projectRootCanonical = normalizeExistingPathForGitComparison(projectRootResolved);
  const requestedCanonical = normalizeExistingPathForGitComparison(requestedResolved);

  // Check if path is inside the worktree
  if (
    isSameOrInsidePath(worktreeResolved, requestedResolved) ||
    isSameOrInsidePath(worktreeCanonical, requestedCanonical)
  ) {
    return true; // Path is inside the worktree
  }

  // Exception: project root `.fusion/memory/` files for durable project learnings
  const relToProjectRoot = relative(projectRootResolved, requestedResolved).replace(/\\/g, "/");
  const relToCanonicalProjectRoot = relative(projectRootCanonical, requestedCanonical).replace(/\\/g, "/");
  const projectRelativePaths = [relToProjectRoot, relToCanonicalProjectRoot];
  if (
    projectRelativePaths.some((relPath) =>
      relPath === ".fusion/memory" ||
      relPath === ".fusion/memory/" ||
      relPath.startsWith(".fusion/memory/")
    )
  ) {
    return true;
  }

  // Exception: task attachments under `.fusion/tasks/*/attachments/*`
  if (projectRelativePaths.some((relPath) => relPath.match(/^\.fusion\/tasks\/[^/]+\/attachments\//))) {
    return true;
  }

  // Exception (read-only): sibling task specs so the agent can consult the
  // PROMPT.md / task.json of dependency tasks without needing them copied
  // into the worktree. `glob`/`grep` are narrow enough to allow as well so
  // the agent can discover them; writes and bash remain restricted.
  const readOnlyTools = new Set(["read", "glob", "grep"]);
  if (
    toolName &&
    readOnlyTools.has(toolName) &&
    projectRelativePaths.some((relPath) => /^\.fusion\/tasks\/[^/]+\/(PROMPT\.md|task\.json)$/.test(relPath))
  ) {
    return true;
  }

  // All other paths outside the worktree are rejected
  return false;
}

/**
 * Wrap tools with worktree boundary validation.
 * When cwd is a worktree path, file operations are validated against worktree boundaries.
 *
 * @param tools - Array of tool definitions to wrap
 * @param worktreePath - Absolute path to the worktree directory (if applicable)
 * @param projectRoot - Absolute path to the project root (if applicable)
 * @returns Wrapped tools with boundary validation
 */
/**
 * Build a tool result payload in the shape pi-coding-agent / pi-ai expect
 * (content as an array of typed blocks, isError=true) rather than a bare
 * `{ok:false,error}` object. Returning the bare object leaves the toolResult
 * message with `content: undefined`, which pi's downstream handling later
 * crashes on with "Cannot read properties of undefined (reading 'filter')".
 */
function boundaryRejection(message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ok: false,
    error: message,
    ...(details ? { details } : {}),
  };
}

function normalizeApprovalRequestCategory(
  category: PermanentAgentActionCategory,
): AgentPermissionPolicyActionCategory {
  if (category === "none") {
    return "command_execution";
  }
  return category;
}

function buildPermanentAgentApprovalDedupeKey(input: {
  requesterActorId?: string;
  taskId?: string;
  toolName: string;
  category: PermanentAgentActionCategory;
}): string {
  return [
    input.requesterActorId ?? "",
    input.taskId ?? "",
    input.toolName,
    input.category,
  ].join("|");
}

const GATE_BYPASS_TOOL_NAMES = new Set([
  "fn_heartbeat_done",
  "fn_send_message",
  "fn_post_room_message",
]);

export function wrapToolsWithBoundary(
  tools: ToolDefinition[],
  worktreePath: string | null,
  projectRoot: string | null,
): ToolDefinition[] {
  if (!worktreePath || !projectRoot) {
    return tools; // Not a worktree session, no wrapping needed
  }

  return tools.map((tool) => {
    // Only wrap tools that access the filesystem
    const fileToolNames = new Set(["read", "write", "edit", "glob", "grep", "bash"]);
    if (!fileToolNames.has(tool.name)) {
      return tool;
    }

    // Store the original execute function
    const originalExecute = tool.execute as any;

     
    return {
      ...tool,
       
      execute: async (...args: any[]) => {
        const _toolCallId = args[0] as string;
        const params = args[1] as Record<string, unknown>;
        const _signal = args[2] as AbortSignal | undefined;

        // Check path argument for file operations
        const pathArg = params.path as string | undefined;
        if (pathArg && !isWorktreeAllowedPath(worktreePath, projectRoot, pathArg, tool.name)) {
          const relToProject = relative(projectRoot, pathArg);
          return boundaryRejection(
            `Path "${relToProject}" is outside the worktree boundary. ` +
              `Coding agents can only modify files inside the current worktree. ` +
              `Exceptions (read-only): .fusion/memory/, .fusion/tasks/*/attachments/, ` +
              `and .fusion/tasks/*/{PROMPT.md,task.json} for dependency context.`,
          );
        }

        // For bash, also check the working directory if specified
        const cwdArg = params.cwd as string | undefined;
        if (tool.name === "bash" && cwdArg && !isWorktreeAllowedPath(worktreePath, projectRoot, cwdArg, tool.name)) {
          return boundaryRejection(
            `Working directory is outside the worktree boundary. ` +
              `Commands must run inside the worktree.`,
          );
        }

        // Call the original tool implementation with all arguments passed through
        return originalExecute(...args);
      },
    };
  });
}

export function wrapToolsWithRtkRewrite(
  tools: ToolDefinition[],
  options: RtkRewriteOptions = resolveRtkRewriteOptions(),
): ToolDefinition[] {
  const resolvedOptions = normalizeRtkRewriteOptions(options);

  if (resolvedOptions.mode !== "rewrite") {
    return tools;
  }

  return tools.map((tool) => {
    if (tool.name !== "bash") {
      return tool;
    }

    const originalExecute = tool.execute as any;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const params = args[1] as Record<string, unknown> | undefined;
        const command = params?.command;
        if (typeof command !== "string" || !command.trim()) {
          return originalExecute(...args);
        }

        const signal = args[2] as AbortSignal | undefined;
        const rewrittenCommand = await rewriteCommandWithRtk(command, resolvedOptions, signal);
        if (!rewrittenCommand) {
          return originalExecute(...args);
        }

        const rewrittenArgs = [...args];
        rewrittenArgs[1] = { ...(params ?? {}), command: rewrittenCommand };
        return originalExecute(...rewrittenArgs);
      },
    };
  });
}

export function wrapToolsWithPermanentAgentGating(
  tools: ToolDefinition[],
  gating: PermanentAgentGatingContext | undefined,
): ToolDefinition[] {
  if (!gating) {
    return tools;
  }

  return tools.map((tool) => {
    // FN-3852/FN-3855: terminal completion and send-message coordination
    // primitives must never be approval-gated, or open sessions can deadlock.
    if (GATE_BYPASS_TOOL_NAMES.has(tool.name)) {
      return tool;
    }

    const originalExecute = tool.execute as any;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const params = (args[1] ?? {}) as Record<string, unknown>;
        const decision = resolvePermanentAgentToolDecision({
          toolName: tool.name,
          args: params,
          gating,
        });

        if (decision.disposition === "allow") {
          return originalExecute(...args);
        }

        const details: Record<string, unknown> = {
          disposition: decision.disposition,
          category: decision.category,
          toolName: decision.toolName,
          ...(decision.disposition === "require-approval" ? { requiresApproval: true } : {}),
        };

        if (decision.disposition === "require-approval") {
          const dedupeKey = buildPermanentAgentApprovalDedupeKey({
            requesterActorId: gating.requester?.actorId,
            taskId: gating.taskId,
            toolName: decision.toolName,
            category: decision.category,
          });
          details.approvalDedupeKey = dedupeKey;

          let approvalRequest = await gating.findPendingApprovalRequest?.(dedupeKey);
          if (!approvalRequest && gating.createApprovalRequest) {
            // FNXC:AgentGating 2026-07-05-00:00:
            // FN-7609: pass the dedupe key through so the gating closure can persist
            // it into targetAction.context.approvalDedupeKey — without this, the
            // findPendingApprovalRequest lookup above can never match and every
            // retrying heartbeat tick mints a fresh duplicate approval request.
            approvalRequest = await gating.createApprovalRequest({
              category: normalizeApprovalRequestCategory(decision.category),
              toolName: decision.toolName,
              args: params,
              approvalDedupeKey: dedupeKey,
            });
          }

          if (approvalRequest?.id) {
            details.approvalRequestId = approvalRequest.id;
          }
        }

        const reason = decision.disposition === "block"
          ? `Action blocked by permanent-agent policy (${decision.category}) for tool ${decision.toolName}`
          : `Action requires approval (${decision.category}) before tool ${decision.toolName} can run`;

        return boundaryRejection(reason, details);
      },
    };
  });
}

export function wrapToolsWithActionGate(
  tools: ToolDefinition[],
  gateContext: AgentActionGateContext | undefined,
): ToolDefinition[] {
  if (!gateContext) {
    return tools;
  }

  return tools.map((tool) => {
    // FN-3852/FN-3855: terminal completion and send-message coordination
    // primitives must never be approval-gated, or open sessions can deadlock.
    if (GATE_BYPASS_TOOL_NAMES.has(tool.name)) {
      return tool;
    }

    const originalExecute = tool.execute as any;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const params = (args[1] ?? {}) as Record<string, unknown>;
        const decision = evaluateAgentActionGate({
          agentId: gateContext.agentId,
          taskId: gateContext.taskId,
          toolName: tool.name,
          args: params,
          permissionPolicy: gateContext.permissionPolicy,
        });

        const latestApproval = gateContext.findApprovalByDedupeKey
          ? await gateContext.findApprovalByDedupeKey(decision.approvalDedupeKey)
          : await gateContext.findPendingApprovalByDedupeKey?.(decision.approvalDedupeKey).then((request) =>
            request ? { id: request.id, status: "pending" as const } : null
          );

        const gateOutcome = resolveGateOutcome(decision, latestApproval ?? null);

        if (gateOutcome.outcome === "allow") {
          return originalExecute(...args);
        }

        if (gateOutcome.outcome === "execute-once-then-complete") {
          const result = await originalExecute(...args);
          if (gateOutcome.approvalRequestId) {
            await gateContext.markApprovalCompleted?.(gateOutcome.approvalRequestId);
          }
          return result;
        }

        if (gateOutcome.outcome === "block") {
          if (latestApproval?.status === "denied") {
            return buildGateRejection(
              {
                ...decision,
                metadata: {
                  ...decision.metadata,
                  approvalRequestId: latestApproval.id,
                  dedupeKey: decision.approvalDedupeKey,
                },
              },
              "Action was denied by approver. The agent must not retry this action.",
            );
          }

          return buildGateRejection(
            decision,
            `Action blocked by permission policy (${decision.category}) for ${gateContext.agentName}`,
          );
        }

        /*
        FNXC:AgentGating 2026-07-05-00:00:
        FN-7608: pauseForApproval (which pauses the task AND suspends the
        in-flight session — see executor.ts buildActionGateContext) must run
        for BOTH the newly-created-request sub-case and the reused-pending
        sub-case. Previously it only ran when a fresh approval request was
        minted, so a second identical gated call that resolved to an already-
        pending request (dedupe working as designed) never paused/suspended
        the session — the agent's turn kept going and it hunted for ungated
        workarounds instead of stopping. resolveGateOutcome() already
        guarantees no duplicate request is created on the reused-pending path
        (gateOutcome.approvalRequestId is set from the existing pending row),
        so this only ever pauses once per distinct approval request.
        */
        let approvalRequestId = gateOutcome.approvalRequestId;
        if (!approvalRequestId) {
          const created = await gateContext.createApprovalRequest(decision, params) as { id?: string } | null;
          approvalRequestId = created?.id;
        }
        if (approvalRequestId) {
          await gateContext.pauseForApproval?.({ approvalRequestId, decision });
        }

        return buildGateRejection(
          {
            ...decision,
            metadata: {
              ...decision.metadata,
              ...(approvalRequestId ? { approvalRequestId } : {}),
              dedupeKey: decision.approvalDedupeKey,
            },
          },
          `Action requires approval (request ${approvalRequestId ?? "pending"}). Task paused and session suspended awaiting decision; do not attempt alternatives.`,
        );
      },
    };
  });
}

/**
 * FNXC:SessionRouting 2026-06-23-16:40:
 * Outbound LLM chat completion requests must carry `X-Session-Id` and
 * `X-Session-Affinity` headers (GitHub issue #1675). These are widely
 * understood by LLM gateways, proxies, and observability tooling:
 *  - Gateways/routers use them for sticky routing, keeping consecutive requests
 *    from one conversation on the same backend or cache instance.
 *  - Observability tools (e.g. Langfuse, Arize) use them to group individually
 *    stateless API calls into a single cohesive multi-turn chat trace.
 *  - Memory/proxy middleware uses them to fetch and append conversation history.
 *
 * Both headers carry the same stable identifier so sticky-routing affinity and
 * trace grouping refer to the same session. Builds the header pair for a given
 * session id.
 */
export function buildSessionRoutingHeaders(sessionId: string): Record<string, string> {
  return {
    "X-Session-Id": sessionId,
    "X-Session-Affinity": sessionId,
  };
}

/**
 * FNXC:SessionRouting 2026-06-23-16:40:
 * Merge the session-routing headers into every header set the model registry
 * resolves for outbound LLM requests (#1675). `getApiKeyAndHeaders` is the
 * single point pi-coding-agent uses to resolve per-request auth and headers
 * (for the main stream and compaction alike), so wrapping it applies the
 * headers to every HTTP-based provider path (built-in, custom, and
 * HTTP-streaming extension providers). Subprocess-based providers that make
 * their own outbound HTTP calls inside a child process (e.g. CLI bridges) are
 * outside this seam and do not inherit the headers.
 * Operating on the resolved output (rather than re-registering providers)
 * preserves provider-specific headers and never disturbs API-key resolution.
 */
export function attachSessionRoutingHeaders(modelRegistry: ModelRegistry, sessionId: string): void {
  // FNXC:SessionRouting 2026-06-23-16:46:
  // Auxiliary feature: never let header injection break session creation. If a
  // future pi-coding-agent rename removes getApiKeyAndHeaders, warn (rather than
  // silently no-op) so the degraded routing/observability headers are detectable.
  if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
    piLog.warn("[pi] session-routing headers not attached: ModelRegistry.getApiKeyAndHeaders is not a function (pi API changed?)");
    return;
  }
  const routingHeaders = buildSessionRoutingHeaders(sessionId);
  const resolveAuth = modelRegistry.getApiKeyAndHeaders.bind(modelRegistry);
  modelRegistry.getApiKeyAndHeaders = async (model) => {
    const result = await resolveAuth(model);
    if (!result.ok) {
      return result;
    }
    return {
      ...result,
      headers: { ...result.headers, ...routingHeaders },
    };
  };
}

/**
 * Create a pi agent session configured for fn.
 * Reuses the user's existing pi auth and model configuration.
 *
 * Returned sessions are wrapped so `session.dispose()` emits pi's
 * `session_shutdown` extension event before teardown.
 */
function withMcpPromptOptions(promptOptions: unknown, mcpServers: ResolvedMcpServerDefinition[] | undefined): unknown {
  if (!mcpServers || mcpServers.length === 0) return promptOptions;
  if (promptOptions && typeof promptOptions === "object" && !Array.isArray(promptOptions)) {
    return { ...(promptOptions as Record<string, unknown>), mcpServers };
  }
  return { mcpServers };
}

/*
 * FNXC:ModelSlotValidation 2026-07-11-00:00:
 * FUSI-050 Fix #1: save-time validation of a model-slot selection (project
 * settings, global settings, workflow settings) must validate against the SAME
 * live execution `ModelRegistry` that `createFnAgent` resolves against at
 * runtime -- not `/api/models` picker visibility (that mismatch was the root
 * cause of the FN-7711/incident confusion this task corrects). This helper
 * builds that registry (auth storage, extension providers via
 * `registerExtensionProviders`, custom providers, supplemental model merges)
 * without creating a full agent session, so save-time callers (dashboard
 * settings routes) can pass the result to `@fusion/core`'s
 * `validateModelSlotSelection`.
 */
export async function buildExecutionModelRegistry(cwd: string): Promise<ModelRegistry> {
  registerNativeOllamaApiProvider();
  const authStorage = createFusionAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage, getModelRegistryModelsPath());
  const resolvedProjectRoot = getProjectRootFromWorktree(cwd) ?? resolvePiExtensionProjectRoot(cwd);
  await registerExtensionProviders(resolvedProjectRoot, modelRegistry);

  registerNativeOllamaProvider(modelRegistry, readNativeOllamaSettings());
  const customProviders = readCustomProviders();
  for (const provider of customProviders) {
    try {
      const registryKey = customProviderRegistryKey(provider, customProviders);
      const api = resolveCustomProviderApiType(provider.apiType);
      modelRegistry.registerProvider(registryKey, {
        baseUrl: provider.baseUrl,
        api,
        apiKey: provider.apiKey,
        models: buildCustomProviderModels(provider, api),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const registryKey = customProviderRegistryKey(provider, customProviders);
      piLog.warn(`Failed to register custom provider "${provider.name}" for model-slot validation (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }
  modelRegistry.refresh();
  mergeSupplementalAnthropicModels(modelRegistry, (message) => extensionsLog.warn(message));
  mergeSupplementalOpenAiCodexModels(modelRegistry, (message) => extensionsLog.warn(message));
  return modelRegistry;
}

export async function createFnAgent(options: AgentOptions): Promise<AgentResult> {
  registerNativeOllamaApiProvider();
  piLog.log(`createFnAgent called (tools=${options.tools}, provider=${options.defaultProvider}, model=${options.defaultModelId})`);
  // FNXC:McpConfig 2026-06-25-22:02:
  // The pi session is the final shared forwarding seam for direct createFnAgent lanes. Forward the resolved MCP set only to MCP-capable provider/runtime combinations and keep unsupported lanes content-free by logging just provider/runtime/count metadata.
  const requestedMcpServers = options.mcpServers ?? [];
  const forwardedMcpServers = runtimeSupportsMcp("pi", options.defaultProvider) ? requestedMcpServers : [];
  if (requestedMcpServers.length > 0 && forwardedMcpServers.length === 0) {
    logMcpForwardingSkipped({ runtimeId: "pi", provider: options.defaultProvider, skippedCount: requestedMcpServers.length, lane: "createFnAgent" });
  }
  const authStorage = createFusionAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage, getModelRegistryModelsPath());

  // Resolve the project root early so extension providers, skill discovery,
  // and resource loading all use the correct root when cwd is a worktree,
  // subdirectory, or any path other than the project root itself.
  const resolvedProjectRoot = getProjectRootFromWorktree(options.cwd) ?? resolvePiExtensionProjectRoot(options.cwd);
  await registerExtensionProviders(resolvedProjectRoot, modelRegistry, options.pluginRunner);

  registerNativeOllamaProvider(modelRegistry, readNativeOllamaSettings());
  const customProviders = readCustomProviders();
  for (const provider of customProviders) {
    try {
      const registryKey = customProviderRegistryKey(provider, customProviders);
      const api = resolveCustomProviderApiType(provider.apiType);
      // FNXC:ProviderAuth 2026-07-08-00:00:
      // FN-7689: reuse the shared `buildCustomProviderModels` helper (custom-provider-registry.ts)
      // instead of building the model list inline here. This is registration path B (the
      // `createFnAgent` inline path); path A is `custom-provider-registry.ts`'s `toProviderConfig`.
      // Before this fix path B set no `compat` at all, so an opted-in provider's
      // `anthropicPromptCaching` flag only took effect via path A and silently dropped here —
      // exactly the drift risk called out for FN-7689. Sharing the builder makes that
      // impossible to reintroduce.
      modelRegistry.registerProvider(registryKey, {
        baseUrl: provider.baseUrl,
        api,
        apiKey: provider.apiKey,
        models: buildCustomProviderModels(provider, api),
      });
      piLog.log(`Registered custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const registryKey = customProviderRegistryKey(provider, customProviders);
      piLog.warn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}, apiType=${provider.apiType}, baseUrl=${provider.baseUrl}): ${message}`);
    }
  }
  modelRegistry.refresh();
  mergeSupplementalAnthropicModels(modelRegistry, (message) => extensionsLog.warn(message));
  /*
   * FNXC:ModelCatalog 2026-07-09-00:00:
   * FN-7754 mirrors the dashboard register-model-routes.ts supplemental merge seam so the GPT-5.6 codenamed OpenAI-Codex models surface on the engine createFnAgent registry-seeding path, not just /api/models. FN-7745 only wired the dashboard surface; this merge is additive and dedupe-safe, so pinned catalog rows win and no duplicate ids are added.
   */
  mergeSupplementalOpenAiCodexModels(modelRegistry, (message) => extensionsLog.warn(message));

  // Build the pi built-in tool set. We deliberately do NOT use the bundled
  // `createCodingTools` / `createReadOnlyTools` presets — they're missing
  // tools that pi-claude-cli's Claude→pi name mapping depends on (Glob→find,
  // Grep→grep). When a coding session ran via Claude CLI tried `Glob`, pi
  // returned "Tool find not found" and the agent looped. Compose explicitly
  // so every tool referenced by tool-mapping.ts is registered.
  const bashToolOptions = options.taskEnv
    ? {
        spawnHook: ({ command, cwd, env }: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
          command,
          cwd,
          env: {
            ...env,
            ...options.taskEnv,
          },
        }),
      }
    : undefined;

  const isReadonly = options.tools === "readonly";
  const normalizedToolsAllowlist = options.toolsAllowlist === undefined
    ? undefined
    : new Set(options.toolsAllowlist.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const isAllowedByToolAllowlist = (toolName: string): boolean => normalizedToolsAllowlist === undefined || normalizedToolsAllowlist.has(toolName.trim().toLowerCase());
  const builtins = [
    createReadTool(options.cwd),
    createBashTool(options.cwd, bashToolOptions),
    createEditTool(options.cwd),
    createWriteTool(options.cwd),
    createGrepTool(options.cwd),
    createFindTool(options.cwd),
    createLsTool(options.cwd),
  ] as ToolDefinition[];
  const modeFilteredTools = isReadonly
    ? builtins.filter((tool) => isReadonlyAllowed(tool.name))
    : builtins;
  const tools = modeFilteredTools.filter((tool) => isAllowedByToolAllowlist(tool.name));
  // Suppress lint about unused presets — kept in scope for incremental migration.
  void createCodingTools;
  void createReadOnlyTools;

  // Detect if this is a worktree session and apply path boundaries
  const worktreePath = options.cwd;
  const worktreeProjectRoot = getProjectRootFromWorktree(worktreePath);
  if (worktreeProjectRoot) {
    await assertValidWorktreeSession(worktreePath, worktreeProjectRoot);
  }
  const boundaryContext = { worktreePath, worktreeProjectRoot };

  // resolvedProjectRoot was computed above (before registerExtensionProviders)
  // and is reused here for resource loader and skill discovery.

  // Compaction is explicitly enabled to prevent context-window overflow during
  // long-running agent conversations (triage, execution, review, merge).
  // When the context fills up, pi auto-compacts the conversation history to
  // keep the session alive without manual intervention. This must remain enabled
  // as a reliability safeguard — disabling it would cause overflow failures.
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  // Resolve explicit model selection if provider and model ID are specified.
  // If the primary configured model cannot be resolved but a fallback model is
  // configured, prefer the fallback as the initial model selection.
  let selectedModel: ReturnType<typeof resolveConfiguredModel>;
  let fallbackModel: ReturnType<typeof resolveConfiguredModel>;
  let fallbackModelDegraded: { provider: string; modelId: string; reason: string } | undefined;

  /*
   * FNXC:ModelFallback 2026-07-11-00:00:
   * FUSI-050: a fallback slot only fires under rate-limit/overload, so a
   * fallback pointing at a provider/model absent from the execution
   * ModelRegistry (e.g. a plugin-gated provider like cursor-cli/grok-cli
   * whose runtime plugin/extension isn't registered) stayed invisible until a
   * real incident forced the swap and hard-failed every task using it
   * (2026-07-11: a 5-hour Claude subscription rate limit forced a fallback to
   * cursor-cli/gpt-5.3-codex-high, which threw "... (fallback selection) was
   * not found in the pi model registry" for several in-flight tasks at once).
   * Degrade instead of hard-failing: leave `fallbackModel` unresolved so
   * `createSessionWithModel`'s `modelOverride` guard falls through to the pi
   * runtime's own built-in default model, and record the reason so callers
   * (see the `fallbackModelDegraded` field on `AgentResult`) can surface a
   * warning through the same FN-7787 `noModelResolved` audit channel. Only the
   * registry-not-found case degrades — any other resolution error still
   * throws, and a primary failure with no fallback configured still throws
   * unchanged.
   */
  const resolveFallbackModel = (): void => {
    if (fallbackModel || fallbackModelDegraded) {
      return;
    }
    try {
      fallbackModel = resolveConfiguredModel(
        modelRegistry,
        "fallback",
        options.fallbackProvider,
        options.fallbackModelId,
      );
    } catch (fallbackResolutionError) {
      const message = fallbackResolutionError instanceof Error ? fallbackResolutionError.message : String(fallbackResolutionError);
      if (!message.includes("was not found in the pi model registry")) {
        throw fallbackResolutionError;
      }
      fallbackModelDegraded = {
        provider: options.fallbackProvider!,
        modelId: options.fallbackModelId!,
        reason: message,
      };
      piLog.warn(
        `[ModelFallback] configured fallback model ${options.fallbackProvider}/${options.fallbackModelId} `
        + `not found in the pi model registry; degrading to the runtime's built-in fallback model. ${message}`,
      );
    }
  };

  try {
    selectedModel = resolveConfiguredModel(
      modelRegistry,
      "primary",
      options.defaultProvider,
      options.defaultModelId,
    );
  } catch (primaryResolutionError) {
    if (!options.fallbackProvider || !options.fallbackModelId) {
      throw primaryResolutionError;
    }
    resolveFallbackModel();
    selectedModel = fallbackModel;
  }

  if (!fallbackModel) {
    resolveFallbackModel();
  }

  // Resolve skill selection: explicit skillSelection wins over convenience `skills`
  let effectiveSkillSelection: SkillSelectionContext | undefined = options.skillSelection;
  if (!effectiveSkillSelection && options.skills && options.skills.length > 0) {
    piLog.log(`Using skills from convenience parameter: [${options.skills.join(", ")}]`);
    effectiveSkillSelection = {
      projectRootDir: resolvedProjectRoot,
      requestedSkillNames: options.skills,
      sessionPurpose: "executor",
    };
  }

  // Resolve skill selection if provided
  let skillsOverrideFn: ReturnType<typeof createSkillsOverrideFromSelection> | undefined;
  if (effectiveSkillSelection) {
    const selectionResult = resolveSessionSkills(effectiveSkillSelection);
    if (selectionResult.diagnostics.length > 0) {
      const purpose = effectiveSkillSelection.sessionPurpose ?? "skills";
      for (const diag of selectionResult.diagnostics) {
        if (diag.type === "info" && diag.message.startsWith("Configured skill pattern:")) continue;
        const msg = `[skills] [${purpose}] ${diag.type}: ${diag.message}`;
        if (diag.type === "error") piLog.error(msg);
        else if (diag.type === "warning") piLog.warn(msg);
        else piLog.log(msg);
      }
    }
    skillsOverrideFn = createSkillsOverrideFromSelection(selectionResult, {
      requestedSkillNames: effectiveSkillSelection.requestedSkillNames,
      sessionPurpose: effectiveSkillSelection.sessionPurpose,
    });
  }

  // `tools: "readonly"` MUST mean a hermetically sealed read-only session with
  // respect to host extension injection. Host extensions (`@runfusion/fusion`)
  // can register write tools like `fn_task_create`, so they are deliberately
  // EXCLUDED in readonly mode. Caller-supplied `customTools` are preserved,
  // since heartbeat/reviewer flows explicitly provide engine-owned tools.
  // This keeps summarizer/compaction sessions safe while retaining intended
  // delegation/memory tools for readonly engine sessions.
  const effectiveExtensionPaths = isReadonly ? [] : hostExtensionPaths;
  if (isReadonly && hostExtensionPaths.length > 0) {
    piLog.log(`readonly session — host extensions (${hostExtensionPaths.length}) skipped`);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: resolvedProjectRoot,
    agentDir: getFusionAgentDir(),
    settingsManager,
    systemPromptOverride: () => options.systemPromptLayers?.stable ?? options.systemPrompt,
    appendSystemPromptOverride: () =>
      options.systemPromptLayers?.dynamic
        ? [options.systemPromptLayers.dynamic]
        : [],
    ...(effectiveExtensionPaths.length > 0 ? { additionalExtensionPaths: [...effectiveExtensionPaths] } : {}),
    ...(options.additionalSkillPaths && options.additionalSkillPaths.length > 0
      ? { additionalSkillPaths: [...options.additionalSkillPaths] }
      : {}),
    ...(skillsOverrideFn ? { skillsOverride: skillsOverrideFn } : {}),
  });
  await resourceLoader.reload();

  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  normalizeSessionHistoryEntries(sessionManager as unknown as SessionManagerLike);

  // FNXC:SessionRouting 2026-06-23-16:40:
  // Tag every outbound LLM chat completion request with stable session-routing
  // headers (X-Session-Id / X-Session-Affinity) for gateway sticky routing and
  // observability trace grouping (#1675). Prefer the task id, which is stable
  // across pause/resume (each resume spins up a fresh SessionManager), and fall
  // back to the pi session id for non-task sessions (chat, summarizer, reviewer).
  const piSessionId = typeof sessionManager.getSessionId === "function"
    ? sessionManager.getSessionId()
    : undefined;
  const sessionRoutingId = options.taskId ?? piSessionId;
  if (sessionRoutingId) {
    attachSessionRoutingHeaders(modelRegistry, sessionRoutingId);
  }

  const createSessionWithModel = async (modelOverride?: typeof selectedModel) => {
    // pi-coding-agent 0.68+: `tools` is a string[] allowlist of tool names, not
    // Tool instances. We need boundary-wrapped versions of the built-ins, so we
    // suppress the defaults with `noTools: "builtin"` and register our wrapped
    // tools through `customTools` instead. The wrapped tools preserve the same
    // names (`read`, `bash`, ...) as the built-ins they replace.
    let mcpToolset: McpSessionToolset | undefined;
    const allowReadonlyMcpTools = options.allowMcpToolsInReadonly === true;
    if (forwardedMcpServers.length > 0 && (!isReadonly || allowReadonlyMcpTools)) {
      /*
       * FNXC:McpConfig 2026-06-27-14:06:
       * pi-coding-agent does not have a createAgentSession `mcpServers` option, so passing resolved servers is silently ignored. Connect MCP servers here and merge namespaced tools into the same customTools filtering/gating/boundary pipeline as engine tools before the session sees them.
       *
       * FNXC:McpConfig 2026-06-29-00:00:
       * Planning and mission interviews are read-only lanes that still need operator-configured documentation/context MCP tools. They must opt in explicitly; other read-only sessions continue to skip MCP connection so unknown external tools do not bypass the read-only allowlist by default.
       */
      /*
       * FNXC:McpConfig 2026-07-12-00:00:
       * FUSI-076 remediation: thread the real OAuth token writeback seam through so a non-interactive refresh
       * performed inside this session actually persists (rather than silently falling back to the FUSI-074
       * warn-only no-op that every real createFnAgent call site previously hit). `mcpOAuthTokenStore` wins when
       * explicitly supplied; otherwise `mcpSettingsStore` + `mcpServerScopeByName` let `connectMcpSessionTools`
       * build the store-backed implementation itself. Both are optional and additive — omitting them keeps the
       * prior in-memory-only behavior unchanged.
       */
      mcpToolset = await connectMcpSessionTools(forwardedMcpServers, {
        cwd: options.cwd,
        clientFactory: options.mcpClientFactory,
        logger: piLog,
        oauthTokenStore: options.mcpOAuthTokenStore,
        mcpSettingsStore: options.mcpSettingsStore,
        scopeByServerName: options.mcpServerScopeByName,
      });
      /*
       * FNXC:McpConfig 2026-07-12-17:02:
       * MAIN-008 requires a configured MCP bootstrap failure to be observably
       * different from a genuine zero-server/tool catalog. Fail session creation
       * using names plus coarse categories only, and dispose every partially
       * connected client before the error crosses the runtime boundary.
       */
      const bootstrapFailures = mcpToolset.skipped.filter(({ reason }) => reason !== "disabled");
      if (bootstrapFailures.length > 0) {
        await mcpToolset.dispose();
        throw new McpSessionBootstrapError(bootstrapFailures);
      }
    } else if (forwardedMcpServers.length > 0 && isReadonly) {
      piLog.log(`readonly session — MCP servers (${forwardedMcpServers.length}) skipped`);
    }

    const mcpReadonlyTools = new Set(mcpToolset?.tools ?? []);
    const candidateCustomTools = [
      ...(options.customTools ?? []),
      ...(mcpToolset?.tools ?? []),
    ];
    const readonlyFilteredCustomTools = isReadonly
      ? filterCustomToolsForReadonly(
          candidateCustomTools,
          allowReadonlyMcpTools ? { allowTool: (tool) => mcpReadonlyTools.has(tool) } : {},
        )
      : { allowed: candidateCustomTools, denied: [] };
    const allowlistFilteredCustomTools = {
      ...readonlyFilteredCustomTools,
      allowed: readonlyFilteredCustomTools.allowed.filter((tool) => isAllowedByToolAllowlist(tool.name)),
    };
    if (isReadonly && readonlyFilteredCustomTools.denied.length > 0) {
      piLog.warn(
        `[pi] readonly mode: dropped ${readonlyFilteredCustomTools.denied.length} denied custom tool(s): ${readonlyFilteredCustomTools.denied.join(", ")}`,
      );
    }

    const toolChainStart: ToolDefinition[] = [
      ...(tools as ToolDefinition[]),
      ...allowlistFilteredCustomTools.allowed,
    ];
    const toolsWithRtkRewrite = wrapToolsWithRtkRewrite(toolChainStart);
    /*
     * FNXC:AgentGating 2026-07-12-17:22:
     * MAIN-008 requires one approval authority per tool call. Executor sessions
     * provide the status-aware action gate for permanent, ephemeral, and
     * fallback task-worker identities; applying the legacy permanent gate
     * inside it would reject the call again after the outer gate consumed an
     * approved request. Standalone lanes without actionGateContext retain the
     * permanent gate unchanged.
     */
    const toolsWithPermanentGating = options.actionGateContext
      ? toolsWithRtkRewrite
      : wrapToolsWithPermanentAgentGating(toolsWithRtkRewrite, options.permanentAgentGating);
    const toolsWithActionGate = wrapToolsWithActionGate(
      toolsWithPermanentGating,
      options.actionGateContext,
    );
    const customToolList: ToolDefinition[] = wrapToolsWithBoundary(
      toolsWithActionGate,
      boundaryContext.worktreePath,
      boundaryContext.worktreeProjectRoot,
    );
    // Sort tools alphabetically by name for deterministic ordering.
    // Prompt caching requires the tool list to be byte-identical across
    // sessions — reordering breaks cache prefix matching.
    // Exception: fn_heartbeat_done must remain last (stable terminal signal
    // required by the heartbeat executor — see agent-heartbeat.ts).
    customToolList.sort((a, b) => a.name.localeCompare(b.name));
    const heartbeatDoneIdx = customToolList.findIndex((t) => t.name === "fn_heartbeat_done");
    if (heartbeatDoneIdx >= 0 && heartbeatDoneIdx < customToolList.length - 1) {
      const [doneTool] = customToolList.splice(heartbeatDoneIdx, 1);
      customToolList.push(doneTool);
    }
    // Last-chance abort hook. Fires *here* — after every awaited setup step
    // in createFnAgent (provider registration, worktree validation, resource
    // loader reload) and immediately before the actual LLM session spawn.
    // This is the latest synchronous decision point where the engine can
    // honor a pause that flipped during this function's setup window.
    if (options.beforeSpawnSession) {
      try {
        await options.beforeSpawnSession();
      } catch (error) {
        await mcpToolset?.dispose();
        throw error;
      }
    }
    const createSessionOptions: Parameters<typeof createAgentSession>[0] = {
      cwd: options.cwd,
      authStorage,
      modelRegistry,
      resourceLoader,
      noTools: "builtin",
      customTools: customToolList,
      sessionManager,
      settingsManager,
      ...(modelOverride ? { model: modelOverride } : {}),
    };

    if (options.builtinToolsAllowlist && options.builtinToolsAllowlist.length > 0) {
      const safeBuiltinAllowlist = (isReadonly
        ? options.builtinToolsAllowlist.filter((name) => READONLY_ALLOWLIST.includes(name as (typeof READONLY_ALLOWLIST)[number]))
        : options.builtinToolsAllowlist).filter(isAllowedByToolAllowlist);
      createSessionOptions.tools = [
        ...new Set([
          ...customToolList.map((tool) => tool.name),
          ...safeBuiltinAllowlist,
        ]),
      ].sort();
    }
    if (normalizedToolsAllowlist !== undefined) {
      createSessionOptions.tools = [
        ...new Set([
          ...customToolList.map((tool) => tool.name),
          ...options.toolsAllowlist!.map((name) => name.trim()).filter(Boolean),
        ]),
      ].sort();
    }

    try {
      const result = await createAgentSession(createSessionOptions);
      if (mcpToolset) {
        const sessionWithDispose = result.session as AgentSession & { dispose?: () => void | Promise<void> };
        const originalDispose = typeof sessionWithDispose.dispose === "function"
          ? sessionWithDispose.dispose.bind(sessionWithDispose)
          : () => undefined;
        let mcpDisposeStarted = false;
        sessionWithDispose.dispose = async () => {
          if (!mcpDisposeStarted) {
            mcpDisposeStarted = true;
            await mcpToolset.dispose();
          }
          await Promise.resolve(originalDispose());
        };
      }
      /*
       * FNXC:TokenAnalytics 2026-06-26-13:58:
       * Token analytics depends on every resolved lane model being visible on `session.model` after session creation. Some pi providers accept the explicit model override but do not mirror it back onto the session, so backfill the snapshot here before shared token accounting reads it.
       */
      if (modelOverride && !(result.session as AgentSession & { model?: unknown }).model) {
        (result.session as AgentSession & { model?: typeof modelOverride }).model = modelOverride;
      }
      return result;
    } catch (error) {
      await mcpToolset?.dispose();
      throw error;
    }
  };

  const modelDescription = (model: typeof selectedModel): string => model ? `${model.provider}/${model.id}` : "unknown model";
  const configuredFallbackDiffers = Boolean(
    options.fallbackProvider
    && options.fallbackModelId
    && (options.fallbackProvider !== options.defaultProvider || options.fallbackModelId !== options.defaultModelId),
  );
  const hasDistinctFallback = Boolean(
    selectedModel
    && fallbackModel
    && (configuredFallbackDiffers || selectedModel.provider !== fallbackModel.provider || selectedModel.id !== fallbackModel.id),
  );
  const makeFallbackExhaustedError = (
    triggerPoint: "session-creation" | "prompt-time",
    attempts: number,
    underlying: unknown,
  ): ModelFallbackExhaustedError => {
    const underlyingReason = underlying instanceof Error ? underlying.message : String(underlying);
    return new ModelFallbackExhaustedError({
      primaryModel: modelDescription(selectedModel),
      fallbackModel: hasDistinctFallback ? modelDescription(fallbackModel) : undefined,
      triggerPoint,
      attempts,
      underlyingReason,
    });
  };

  /*
   * FNXC:RateLimitResume 2026-07-11-00:00:
   * A usage-limit/429 underlying error (rate limit, quota, overloaded, billing —
   * see isUsageLimitError) must NEVER surface as a terminal ModelFallbackExhaustedError,
   * even when it is the reason a distinct fallback model also failed. Every AI lane's
   * catch block classifies isUsageLimitError() on the raw underlying error to trigger a
   * pause-and-auto-resume (UsageLimitPauser -> globalPause('rate-limit') -> self-healing
   * auto-unpause), not a task failure. Wrapping the usage-limit reason inside
   * ModelFallbackExhaustedError's composed message shadowed that classification in
   * exactly the same string-matching lanes rely on when a genuinely distinct fallback
   * ALSO hit a limit (FUSI-064). Fix at the source: when the underlying reason is a
   * usage-limit condition, re-throw it unchanged instead of wrapping — every lane's
   * isUsageLimitError(err.message) check then classifies it correctly. A genuine
   * non-usage-limit model-selection failure (auth-tier incompatibility, 404 model not
   * found, unsupported role, etc.) is unaffected and still produces the terminal,
   * operator-actionable ModelFallbackExhaustedError.
   */
  const throwFallbackExhausted = (
    triggerPoint: "session-creation" | "prompt-time",
    attempts: number,
    underlying: unknown,
  ): never => {
    const underlyingMessage = underlying instanceof Error ? underlying.message : String(underlying);
    if (isUsageLimitError(underlyingMessage)) {
      throw underlying instanceof Error ? underlying : new Error(underlyingMessage);
    }
    throw makeFallbackExhaustedError(triggerPoint, attempts, underlying);
  };

  const emitFallbackUsed = async (triggerPoint: "session-creation" | "prompt-time"): Promise<void> => {
    if (!options.onFallbackModelUsed || !selectedModel || !fallbackModel || !hasDistinctFallback) {
      return;
    }
    await options.onFallbackModelUsed({
      primaryModel: `${selectedModel.provider}/${selectedModel.id}`,
      fallbackModel: `${fallbackModel.provider}/${fallbackModel.id}`,
      triggerPoint,
      taskId: options.taskId,
      taskTitle: options.taskTitle,
      timestamp: new Date().toISOString(),
    });
  };

  /*
   * FNXC:ModelFallback 2026-07-02-00:00:
   * Planner and shared AI lanes may try one distinct fallback model for a logical model-selection failure, but they must then throw ModelFallbackExhaustedError instead of swapping back or relying on scheduler re-pick loops. This keeps transient fallback useful while making exhausted model configuration actionable for operators.
   */
  let sessionResult;
  let usingFallback = false;
  try {
    sessionResult = await createSessionWithModel(selectedModel);
    piLog.log(`Session created successfully (model=${selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "default"})`);
  } catch (err: any) {
    if (!fallbackModel || !selectedModel || !hasDistinctFallback || !isRetryableModelSelectionError(err?.message || "")) {
      piLog.error(`Session creation failed: ${err.message}`);
      throw err;
    }
    piLog.warn(`Primary model failed (${err.message}), trying fallback`);
    usingFallback = true;
    try {
      sessionResult = await createSessionWithModel(fallbackModel);
    } catch (fallbackErr: unknown) {
      throw throwFallbackExhausted("session-creation", 2, fallbackErr);
    }
    await emitFallbackUsed("session-creation");
    piLog.log("Fallback session created successfully");
  }

  let activeSession = sessionResult.session;
  wrapSessionDisposeWithShutdown(activeSession);
  installToolResultContentGuard(activeSession as AgentToolHookSession);
  installMessageContentGuard(activeSession as AgentToolHookSession, sessionManager as unknown as SessionManagerLike);
  (activeSession as any).__fusionMemoryAppendAvailable = options.customTools?.some((tool) => tool.name === FN_MEMORY_APPEND_TOOL_NAME) === true;
  const promptableSession = activeSession as PromptableSession;

  let thinkingCompatibilityDisabled = false;
  const applyThinkingLevelIfSupported = (targetSession: AgentSession, sourceModel: string): void => {
    /*
     * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
     * Fallback-swap sessions apply the fallback model's configured thinking level, or transparently keep the lane/default level when no fallback-specific value exists. The compatibility-disable guard remains shared so thinking/reasoning conflicts disable explicit thinking for both primary and fallback paths.
     */
    const effectiveThinkingLevel = usingFallback
      ? options.fallbackThinkingLevel ?? options.defaultThinkingLevel
      : options.defaultThinkingLevel;
    if (!effectiveThinkingLevel || thinkingCompatibilityDisabled) {
      return;
    }
    try {
      (targetSession as PromptableSession).setThinkingLevel(effectiveThinkingLevel as any);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isThinkingReasoningConflictError(message)) {
        throw err;
      }
      thinkingCompatibilityDisabled = true;
      piLog.warn(`Disabling explicit thinking level for model ${sourceModel}: ${message}`);
    }
  };

  const wireFallbackHooks = (targetSession: PromptableSession): void => {
    installToolResultContentGuard(targetSession as unknown as AgentToolHookSession);
    installMessageContentGuard(
      targetSession as unknown as AgentToolHookSession,
      sessionManager as unknown as SessionManagerLike,
    );
    (targetSession as any).__fusionMemoryAppendAvailable = options.customTools?.some((tool) => tool.name === FN_MEMORY_APPEND_TOOL_NAME) === true;
    const deltaNormalizer = createStreamingDeltaNormalizer();
    /*
     * FNXC:SessionWiring 2026-07-13-00:00:
     * Not every resolved runtime session implements the pi `subscribe(listener)`
     * API — delegated CLI runtimes (cursor/droid/grok) stream through their own
     * `onText`/`onThinking` callbacks instead. Calling `.subscribe` unguarded on
     * such a session throws `session.subscribe is not a function`, which the
     * workflow-graph executor surfaces as a no-verdict "failed before producing
     * a verdict" failure that burns the task's entire retry budget (FUSI-088,
     * observed on FUSI-082; same class as Runfusion/Fusion#1946). Streaming
     * already flows through `options.onText`/`options.onThinking` at session
     * creation for non-subscribe runtimes, so simply skip resubscribing here
     * when `subscribe` is absent instead of throwing.
     */
    if (typeof targetSession.subscribe === "function") {
      targetSession.subscribe((event) => {
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            options.onText?.(deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "text"));
          } else if (msgEvent.type === "thinking_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            options.onThinking?.(deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "thinking"));
          }
        }
        if (event.type === "tool_execution_start") {
          options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
        }
        if (event.type === "tool_execution_end") {
          options.onToolEnd?.(event.toolName, event.isError, event.result);
        }
      });
    }
  };

  const swapPromptSession = async (modelToUse: typeof selectedModel): Promise<PromptableSession> => {
    if (!modelToUse) {
      throw new Error("Cannot swap session without a resolved model");
    }
    wrapSessionDisposeWithShutdown(activeSession);
    try {
      activeSession.dispose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      piLog.warn(`Failed to dispose session during swap: ${msg}`);
    }
    const next = (await createSessionWithModel(modelToUse)).session as PromptableSession;
    wireFallbackHooks(next);
    wrapSessionDisposeWithShutdown(next);
    applyThinkingLevelIfSupported(next, `${modelToUse.provider}/${modelToUse.id}`);
    Object.setPrototypeOf(promptableSession, Object.getPrototypeOf(next));
    Object.assign(promptableSession, next);
    promptableSession.promptWithFallback = next.promptWithFallback ?? promptableSession.promptWithFallback;
    activeSession = next;
    return next;
  };

  promptableSession.promptWithFallback = async (prompt: string, promptOptions?: unknown) => {
    const effectivePromptOptions = withMcpPromptOptions(promptOptions, forwardedMcpServers);
    try {
      await promptSessionAndCheck(activeSession, prompt, effectivePromptOptions);
      return;
    } catch (err: any) {
      const errorMessage = err?.message || "";
      if (isContextLimitError(errorMessage)) {
        // Context limit error — attempt auto-compaction and retry once
        const promptMemoryRetry = await retryWithCompactedPromptMemory(activeSession, prompt, effectivePromptOptions);
        if (promptMemoryRetry.recovered) {
          return;
        }
        if (promptMemoryRetry.error) {
          const retryMessage = promptMemoryRetry.error instanceof Error ? promptMemoryRetry.error.message : String(promptMemoryRetry.error);
          if (!isContextLimitError(retryMessage)) {
            throw promptMemoryRetry.error;
          }
        }

        const promptSectionRetry = await retryWithCompactedPromptSections(activeSession, prompt, effectivePromptOptions);
        if (promptSectionRetry.recovered) {
          return;
        }
        if (promptSectionRetry.error) {
          const retryMessage = promptSectionRetry.error instanceof Error ? promptSectionRetry.error.message : String(promptSectionRetry.error);
          if (!isContextLimitError(retryMessage)) {
            throw promptSectionRetry.error;
          }
        }

        piLog.warn("promptWithFallback: context limit error — attempting auto-compaction");
        await flushMemoryBeforeSessionCompaction(activeSession);
        const compactResult = await compactSessionContext(activeSession);
        if (compactResult) {
          piLog.log(`promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
          try {
            await promptSessionAndCheck(activeSession, prompt, effectivePromptOptions);
            return;
          } catch (retryErr: any) {
            const retryErrorMessage = retryErr?.message || "";
            piLog.error(`promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
            // Throw original error to preserve original context
            throw err;
          }
        } else {
          piLog.error("promptWithFallback: compaction unavailable — propagating original error");
          throw err;
        }
      }

      if (!usingFallback && options.defaultThinkingLevel && !thinkingCompatibilityDisabled && isThinkingReasoningConflictError(errorMessage)) {
        thinkingCompatibilityDisabled = true;
        piLog.warn(`Prompt failed with thinking/reasoning conflict; retrying without explicit thinking level: ${errorMessage}`);
        const recoveredSession = await swapPromptSession(selectedModel);
        await promptSessionAndCheck(recoveredSession, prompt, effectivePromptOptions);
        return;
      }

      if (!fallbackModel || usingFallback || !isRetryableModelSelectionError(errorMessage)) {
        throw err;
      }
      if (!hasDistinctFallback) {
        throw throwFallbackExhausted("prompt-time", 1, err);
      }

      usingFallback = true;
      const fallbackSession = await swapPromptSession(fallbackModel);
      await emitFallbackUsed("prompt-time");

      // Retry with fallback model, also with auto-compaction support
      try {
        await promptSessionAndCheck(fallbackSession, prompt, effectivePromptOptions);
        return;
      } catch (fallbackErr: any) {
        const fallbackErrorMessage = fallbackErr?.message || "";
        if (isContextLimitError(fallbackErrorMessage)) {
          const promptMemoryRetry = await retryWithCompactedPromptMemory(fallbackSession, prompt, effectivePromptOptions);
          if (promptMemoryRetry.recovered) {
            return;
          }
          if (promptMemoryRetry.error) {
            const retryMessage = promptMemoryRetry.error instanceof Error ? promptMemoryRetry.error.message : String(promptMemoryRetry.error);
            if (!isContextLimitError(retryMessage)) {
              throw promptMemoryRetry.error;
            }
          }

          const promptSectionRetry = await retryWithCompactedPromptSections(fallbackSession, prompt, effectivePromptOptions);
          if (promptSectionRetry.recovered) {
            return;
          }
          if (promptSectionRetry.error) {
            const retryMessage = promptSectionRetry.error instanceof Error ? promptSectionRetry.error.message : String(promptSectionRetry.error);
            if (!isContextLimitError(retryMessage)) {
              throw promptSectionRetry.error;
            }
          }

          piLog.warn("promptWithFallback: fallback session context limit error — attempting auto-compaction");
          await flushMemoryBeforeSessionCompaction(fallbackSession);
          const compactResult = await compactSessionContext(fallbackSession);
          if (compactResult) {
            piLog.log(`promptWithFallback: fallback compaction succeeded (${compactResult.tokensBefore} tokens) — retrying`);
            try {
              await promptSessionAndCheck(fallbackSession, prompt, effectivePromptOptions);
              return;
            } catch (retryErr: any) {
              const retryErrorMessage = retryErr?.message || "";
              piLog.error(`promptWithFallback: fallback retry after auto-compaction failed: ${retryErrorMessage}`);
              throw fallbackErr; // Throw original fallback error
            }
          } else {
            piLog.error("promptWithFallback: fallback compaction unavailable — propagating original error");
            throw fallbackErr;
          }
        }
        throw throwFallbackExhausted("prompt-time", 2, fallbackErr);
      }
    }
  };

  // Apply thinking level if specified (with compatibility fallback).
  applyThinkingLevelIfSupported(
    promptableSession,
    selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : describeModel(promptableSession),
  );

  // Wire up event listeners
  const deltaNormalizer = createStreamingDeltaNormalizer();
  /*
   * FNXC:SessionWiring 2026-07-13-00:00:
   * Same guard as `wireFallbackHooks` above: a resolved runtime session may not
   * implement the pi `subscribe(listener)` API (delegated CLI runtimes stream
   * via their own `onText`/`onThinking`). Guard the call so a subscribe-less
   * session doesn't throw `session.subscribe is not a function` and no-verdict
   * the calling review/workflow-step (FUSI-088 / Runfusion/Fusion#1946);
   * `options.onText`/`options.onThinking` were already forwarded at session
   * creation and remain the streaming path for such runtimes.
   */
  if (typeof promptableSession.subscribe === "function") {
    promptableSession.subscribe((event) => {
      if (event.type === "message_update") {
        const msgEvent = event.assistantMessageEvent;
        if (msgEvent.type === "text_delta") {
          // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
          // including tool-call cross-message boundaries (see streaming-delta.ts).
          options.onText?.(deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "text"));
        } else if (msgEvent.type === "thinking_delta") {
          // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
          // including tool-call cross-message boundaries (see streaming-delta.ts).
          options.onThinking?.(deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "thinking"));
        }
      }
      if (event.type === "tool_execution_start") {
        options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
      }
      if (event.type === "tool_execution_end") {
        options.onToolEnd?.(event.toolName, event.isError, event.result);
      }
    });
  }

  return {
    session: promptableSession,
    sessionFile: promptableSession.sessionFile,
    ...(fallbackModelDegraded ? { fallbackModelDegraded } : {}),
  };
}
