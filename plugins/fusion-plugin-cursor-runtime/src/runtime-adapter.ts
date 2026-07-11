import { createInterface } from "node:readline";
import { probeCursorBinary } from "./probe.js";
import { buildCursorExecutionArgs, captureBoundedStderr, killCursorExecution, spawnCursorExecution } from "./execution-process-manager.js";
import { extractMessageText, parseCursorLine } from "./stream-parser.js";
import { CursorRuntimeBlockedError } from "./types.js";
import type {
  AgentPromptResult,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  CursorExecutionMode,
  CursorExecutionUsage,
  CursorSession,
  CursorTaskTokenUsage,
} from "./types.js";

/*
FNXC:CursorCli 2026-07-11-00:00:
FUSI-063: replaces the FN-3396 `promptWithFallback()` no-op stub. This adapter
delegates the agentic loop entirely to `cursor-agent` (its own write/shell
tools) rather than treating it as a raw text-completion provider, mirroring
`fusion-plugin-droid-runtime`'s runtime-delegation model. See
docs/cursor-cli-contract.md's "Execution / streaming contract" section for
the full invocation/event contract this file implements.
*/

/**
 * Classify a non-authenticated `probeCursorBinary()` result into a distinct
 * runtime-blocked kind, using the SAME reason text `probe.ts` already
 * produces (`"macOS login keychain is locked"` / `"Cursor IDE installation
 * not found"`) rather than collapsing every case into a generic
 * "unauthenticated" bucket.
 */
function classifyAuthFailure(reason: string | undefined): "keychain-locked" | "missing-ide" | "unauthenticated" {
  if (reason?.includes("keychain is locked")) return "keychain-locked";
  if (reason?.includes("IDE installation not found")) return "missing-ide";
  return "unauthenticated";
}

/** Map cursor-agent's raw `result.usage` field names into Fusion's `TaskTokenUsage`-shaped fields. */
function mapUsage(usage: CursorExecutionUsage | undefined): CursorTaskTokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cachedTokens + cacheWriteTokens,
  };
}

/** Duck-typed extraction of an `AbortSignal` off the opaque `options` argument, if the caller supplied one. */
function extractAbortSignal(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== "object") return undefined;
  const signal = (options as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export class CursorRuntimeAdapter implements AgentRuntime {
  readonly id = "cursor";
  readonly name = "Cursor Runtime";

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const probe = await probeCursorBinary({ binaryPath: options.binaryPath });

    if (!probe.available) {
      throw new CursorRuntimeBlockedError(probe.reason ?? "cursor-agent binary not found", "unavailable");
    }
    if (!probe.authenticated) {
      throw new CursorRuntimeBlockedError(
        probe.reason ?? "cursor-agent not authenticated",
        classifyAuthFailure(probe.reason),
      );
    }

    const binary = probe.binaryPath ?? probe.binaryName ?? "cursor-agent";
    // FNXC:CursorCli 2026-07-11-00:00: "auto" is cursor-agent's OWN built-in
    // default model alias (confirmed live: an unmodeled invocation's
    // `system`/`init` event reports `"model":"Auto"`) — not a Fusion-side
    // static model catalog. Only used when the caller genuinely supplied no
    // defaultModelId; discovery (`provider.ts`) remains dynamic-first.
    const model = options.defaultModelId?.trim() || "auto";
    // FUSI-063: `tools:"readonly"` sessions (e.g. reviewer/validator lanes)
    // map to cursor-agent's `--mode plan` — read-only/planning, no edits —
    // rather than `--mode ask`, since Fusion's readonly lane analyzes/reviews
    // code rather than holding a pure Q&A conversation.
    const mode: CursorExecutionMode = options.tools === "readonly" ? "plan" : "agent";

    const session: CursorSession = {
      model,
      systemPrompt: options.systemPrompt ?? "",
      messages: [],
      sessionId: "",
      mode,
      lastModelDescription: `cursor/${model}`,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      binary,
      cwd: options.cwd,
      dispose: () => undefined,
    };

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void | AgentPromptResult> {
    const signal = extractAbortSignal(options);
    const execArgs = buildCursorExecutionArgs({
      cwd: session.cwd,
      model: session.model,
      prompt,
      // FUSI-063: resume the prior turn's cursor-agent session (captured
      // off the `system`/`result` events' `session_id`) so multi-turn
      // conversations keep cursor-agent's own context, without Fusion ever
      // needing to call `create-chat` to pre-allocate an id up front — the
      // CLI mints one itself on the first turn.
      resumeChatId: session.sessionId || undefined,
      mode: session.mode,
    });

    const child = spawnCursorExecution(session.binary, execArgs, session.cwd);
    const getStderr = captureBoundedStderr(child);

    return new Promise<AgentPromptResult>((resolve, reject) => {
      let settled = false;
      let sawResult = false;

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        rl.close();
      };

      const finish = (outcome: AgentPromptResult | Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };

      const onAbort = () => {
        killCursorExecution(child);
        finish(new Error("cursor-agent execution aborted"));
      };

      if (signal) {
        if (signal.aborted) {
          killCursorExecution(child);
          finish(new Error("cursor-agent execution aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      rl.on("line", (line) => {
        const event = parseCursorLine(line);
        if (!event) return;

        switch (event.type) {
          case "system":
            if (event.session_id) session.sessionId = event.session_id;
            break;
          case "thinking":
            if (event.subtype === "delta" && event.text) {
              session.callbacks.onThinking?.(event.text);
            }
            break;
          case "assistant": {
            const text = extractMessageText(event);
            if (text) session.callbacks.onText?.(text);
            break;
          }
          case "result": {
            sawResult = true;
            if (event.session_id) session.sessionId = event.session_id;
            if (event.is_error) {
              // FUSI-063: never silently swallow a failed turn — throwing
              // here surfaces a rejected promise so the caller's existing
              // fallback/retry machinery (the same path `pi.ts`'s
              // `promptWithFallback` failures already flow through) can act
              // on it, instead of resolving as if the turn succeeded.
              finish(new Error(`cursor-agent execution failed: ${event.error ?? event.result ?? "unknown error"}`));
            } else {
              finish({ stopReason: "stop", usage: mapUsage(event.usage) });
            }
            break;
          }
          default:
            break;
        }
      });

      child.once("error", (error: Error) => {
        finish(new Error(`cursor-agent failed to start: ${error.message}`));
      });

      // Backstop on the READLINE close (fires once all already-buffered
      // `line` events have been emitted), not the child process `close` —
      // the child's stdio can report `close` before readline finishes
      // draining its internal buffer, which would otherwise race a genuine
      // trailing `result` event against this no-result fallback.
      rl.once("close", () => {
        if (settled) return;
        if (!sawResult) {
          const diagnostic = getStderr();
          const exitInfo = child.exitCode ?? "unknown";
          finish(
            new Error(
              `cursor-agent exited (code ${exitInfo}) before emitting a result event${diagnostic ? `: ${diagnostic}` : ""}`,
            ),
          );
        }
      });
    });
  }

  describeModel(session: AgentSession): string {
    const model = session.model || "default";
    return model.startsWith("cursor/") ? model : `cursor/${model}`;
  }
}
