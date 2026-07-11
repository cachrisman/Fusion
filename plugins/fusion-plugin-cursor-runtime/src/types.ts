export interface CursorBinaryStatus {
  available: boolean;
  authenticated?: boolean;
  binaryPath?: string;
  binaryName?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  diagnostics?: string[];
  version?: string;
  reason?: string;
  probeDurationMs: number;
}

/*
FNXC:CursorCli 2026-07-11-00:00:
FUSI-063: execution/streaming wire types below were captured live against a
real `cursor-agent` binary (v2026.07.08-0c04a8a in the original spec capture,
re-verified live at v2026.07.09-a3815c0 during implementation) invoked as
`cursor-agent -p --output-format stream-json --force --trust --workspace <cwd>
--model <id> "<prompt>"`. Transcribed into docs/cursor-cli-contract.md's
"Execution / streaming contract" section — this file is the typed mirror of
that doc, not a separate source of truth.
*/

/** Execution mode passed via `cursor-agent --mode <mode>`; default (agent) omits the flag entirely. */
export type CursorExecutionMode = "agent" | "plan" | "ask";

/** `system`/`init` NDJSON event — first event of every stream, carries session bootstrap info. */
export interface CursorSystemEvent {
  type: "system";
  subtype: string;
  apiKeySource?: string;
  cwd?: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
}

/** `user` NDJSON event — echoes the prompt cursor-agent received. */
export interface CursorUserEvent {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: string; text?: string }>;
  };
  session_id?: string;
}

/** `thinking` NDJSON event — `delta` carries incremental reasoning text, `completed` closes the block (no `text`). */
export interface CursorThinkingEvent {
  type: "thinking";
  subtype: "delta" | "completed";
  text?: string;
  session_id?: string;
  timestamp_ms?: number;
}

/** `assistant` NDJSON event — final assistant message content (cursor-agent does not stream partial assistant text by default; text arrives whole per block). */
export interface CursorAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: string; text?: string }>;
  };
  session_id?: string;
}

/** Raw `result.usage` field names as emitted by cursor-agent — distinct casing/shape from Fusion's `TaskTokenUsage`. */
export interface CursorExecutionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `result` NDJSON event — terminal event of the stream; `is_error:true` means the run failed. */
export interface CursorResultEvent {
  type: "result";
  subtype: string;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error: boolean;
  result?: string;
  error?: string;
  session_id?: string;
  request_id?: string;
  usage?: CursorExecutionUsage;
}

export type CursorNdjsonEvent =
  | CursorSystemEvent
  | CursorUserEvent
  | CursorThinkingEvent
  | CursorAssistantEvent
  | CursorResultEvent;

/** Options accepted by `buildCursorExecutionArgs`/`spawnCursorExecution`. */
export interface CursorExecutionOptions {
  cwd: string;
  model: string;
  prompt: string;
  /** `--resume <chatId>` — resumes a prior cursor-agent chat/session. */
  resumeChatId?: string;
  /** `--mode plan|ask` for read-only lanes; omitted entirely for the default full-edit agent mode. */
  mode?: CursorExecutionMode;
  /** `--add-dir <path>`, repeatable — additional workspace roots beyond `--workspace`. */
  addDirs?: string[];
  /** `--approve-mcps` — auto-approve all forwarded MCP servers. */
  approveMcps?: boolean;
  signal?: AbortSignal;
}

/** Fusion-side task-token-usage shape (structural mirror of `@fusion/core`'s `TaskTokenUsage`, minus the task-level accumulation timestamps this single-turn adapter never owns). */
export interface CursorTaskTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/** Callbacks the engine wires to surface streamed agent output into Fusion's UI/logs. */
export interface CursorCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

/**
 * Live Cursor session state tracked by the runtime adapter. Duck-typed against
 * `AgentSession` from `@earendil-works/pi-coding-agent` (see `DroidSession` in
 * `fusion-plugin-droid-runtime/src/types.ts` for the established precedent) —
 * `runtime-resolution.ts`'s `wrapPluginRuntime` bridges plugin adapters
 * structurally via `Record<string, unknown>`, so this need not literally
 * satisfy the pi-coding-agent type.
 */
export interface CursorSession {
  model: string;
  systemPrompt: string;
  messages: unknown[];
  /** cursor-agent `session_id`/chat id, usable with `--resume` on the next turn. */
  sessionId: string;
  mode: CursorExecutionMode;
  lastModelDescription: string;
  callbacks: CursorCallbacks;
  /** Resolved binary path/name used to spawn this session's turns. */
  binary: string;
  cwd: string;
  dispose(): void;
}

export type AgentSession = CursorSession;

/** Plugin-local structural copy of the engine's `AgentRuntimeOptions` (subset this runtime reads). */
export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: string;
  /** Optional binary path override, mirroring `probeCursorBinary`'s `binaryPath` option. */
  binaryPath?: string;
}

export interface AgentPromptResult {
  stopReason?: string;
  /** Token usage for this turn, mapped from `result.usage`. Optional — omitted when the stream never reached a `result` event (e.g. aborted). */
  usage?: CursorTaskTokenUsage;
  /** Reserved for parity with the engine's fallback-degradation signal; this runtime doesn't currently downgrade models mid-stream. */
  fallbackModelDegraded?: boolean;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

/** The Fusion runtime contract this plugin implements (mirrors `packages/engine/src/agent-runtime.ts`). */
export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void | AgentPromptResult>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}

/** Thrown by `createSession` when the binary is unavailable or auth-blocked; carries the probe's distinct reason text verbatim. */
export class CursorRuntimeBlockedError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "keychain-locked" | "missing-ide" | "unauthenticated",
  ) {
    super(message);
    this.name = "CursorRuntimeBlockedError";
  }
}
