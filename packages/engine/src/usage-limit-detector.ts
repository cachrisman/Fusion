/**
 * Usage Limit Detector — classifies API errors as usage-limit-related
 * and triggers the global pause mechanism when detected.
 *
 * Usage-limit errors indicate systemic conditions (rate limits, quota exceeded,
 * billing issues, overloaded APIs) where continued retrying across multiple
 * agents is wasteful. Transient server errors (500, timeout, connection refused)
 * are NOT classified as usage-limit errors — they are temporary and may resolve
 * on their own via per-session retry.
 */

import type { TaskStore } from "@fusion/core";
import { createLogger } from "./logger.js";

const log = createLogger("usage-limit");

/**
 * Patterns that indicate API usage/capacity/billing limits.
 * These are checked case-insensitively against error messages.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate[_\s]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b529\b/,
  /quota/i,
  /billing/i,
  /\bcredit/i,
  /insufficient.*(quota|credit|balance|fund)/i,
];

/**
 * Classify whether an error message indicates a usage-limit condition.
 *
 * Returns `true` for rate limits, overloaded errors, quota/billing issues —
 * conditions where all agents should stop. Returns `false` for transient
 * server errors (500/502/503/504, timeout, connection refused) that may
 * resolve on their own.
 */
export function isUsageLimitError(errorMessage: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Lightweight coordinator that agents call when they detect usage-limit errors.
 * Triggers the global pause mechanism by calling
 * `store.updateSettings({ globalPause: true, globalPauseReason: "rate-limit" })`.
 *
 * **Idempotency:** Tracks an internal `paused` flag so that multiple concurrent
 * agents hitting limits only trigger one pause. The flag resets when `globalPause`
 * is externally set back to `false` (detected by reading settings before pausing).
 */
/**
 * Check if an agent session resolved with an error after exhausting retries.
 *
 * pi-coding-agent's `session.prompt()` does **not** throw when retries are
 * exhausted — it resolves normally and stores the error on
 * `session.state.errorMessage` (was `session.state.error` prior to
 * pi-coding-agent 0.70). Call this immediately after every
 * `await session.prompt(...)` to re-raise the swallowed error so existing
 * `catch` blocks (with `isUsageLimitError` checks) can detect rate-limit
 * conditions and trigger `UsageLimitPauser`.
 *
 * @param session — The agent session (or any object with `state.errorMessage?: string`)
 * @throws {Error} If `session.state.errorMessage` is set and non-empty
 */
export function checkSessionError(session: { state: { errorMessage?: string; error?: string } }): void {
  const state = session.state;
  const error = state?.errorMessage ?? state?.error;
  if (error) {
    throw new Error(error);
  }
}

/*
FNXC:UsageControl 2026-07-13-00:00 (FUSI-058):
Two distinct pause reasons now exist: "rate-limit" (reactive — a hard 429/usage-limit error
was actually hit) and "usage-threshold" (proactive — the self-healing maintenance sweep
observed worst-case usage crossing `usagePauseThresholdPercent` BEFORE any hard error).
Separating the reasons lets the dashboard and reset-aware auto-unpause distinguish "we
reserved headroom early" from "we got throttled". A hard rate-limit hit always takes
priority: `onUsageLimitHit` escalates an active "usage-threshold" pause to "rate-limit"
in place (same idempotent no-op semantics otherwise) since the reactive condition is more
severe than the proactive one it was standing in for. Neither pause method ever overrides
an existing "manual" pause — a caller must never see this class turn `globalPause` from
true back to a different reason (other than the threshold->rate-limit escalation) or from
true to false; only the FUSI-053 reset-aware auto-unpause and explicit operator action clear it.
*/
export class UsageLimitPauser {
  private paused = false;

  constructor(private store: TaskStore) {}

  /**
   * Called by agents when a usage-limit error is detected after retries are exhausted.
   * Triggers global pause if not already paused.
   *
   * @param agentType - The type of agent that hit the limit (e.g., "executor", "triage", "merger")
   * @param taskId - The task that was being processed when the limit was hit
   * @param errorMessage - The error message from the API
   */
  async onUsageLimitHit(agentType: string, taskId: string, errorMessage: string): Promise<void> {
    // If we already triggered a pause, check if it was externally reset
    if (this.paused) {
      const settings = await this.store.getSettings();
      if (settings.globalPause) {
        // FUSI-058: a hard rate-limit hit escalates a prior proactive "usage-threshold"
        // pause in place — the reactive condition is more severe than the proactive one.
        if (settings.globalPauseReason === "usage-threshold") {
          await this.store.updateSettings({ globalPause: true, globalPauseReason: "rate-limit" });
          log.warn(
            `${agentType} hit usage limit on ${taskId} while a proactive usage-threshold pause was active — escalating to rate-limit`,
          );
          return;
        }
        // Still paused — no need to trigger again
        log.log(`Global pause already active — ignoring duplicate from ${agentType}/${taskId}`);
        return;
      }
      // External reset detected — allow re-triggering
      this.paused = false;
    }

    this.paused = true;

    log.warn(`${agentType} hit usage limit on ${taskId}: ${errorMessage}`);
    log.warn(`Matched pattern in error: "${errorMessage.slice(0, 200)}"`);

    // Log the triggering error on the task
    await this.store.logEntry(
      taskId,
      `Usage limit detected (${agentType}): ${errorMessage}`,
    );

    // Activate global pause
    await this.store.updateSettings({ globalPause: true, globalPauseReason: "rate-limit" });

    log.warn("⚠ Global pause activated — all automated activity will halt");
  }

  /**
   * FUSI-058: called by the self-healing maintenance sweep when the injected
   * `getUsageControlSnapshot()` reports worst-case usage crossing
   * `usagePauseThresholdPercent` — BEFORE any hard 429/usage-limit error occurs.
   * Triggers a proactive global pause with the reserved `globalPauseReason:
   * "usage-threshold"` so the operator keeps headroom.
   *
   * **Idempotency:** reads current settings before every call so repeated ticks over
   * threshold only pause once, and never overrides an already-active pause of ANY
   * reason (including a prior "usage-threshold" pause, a "rate-limit" pause, or a
   * "manual" operator pause) — the caller does not need to pre-check `globalPause`.
   *
   * @returns `true` if a new pause was activated, `false` if a pause was already active.
   */
  async onUsageThresholdReached(details: {
    window: string;
    percentUsed: number;
    thresholdPercent: number;
  }): Promise<boolean> {
    const { window, percentUsed, thresholdPercent } = details;

    const settings = await this.store.getSettings();
    if (settings.globalPause) {
      log.log(
        `Skipping proactive usage-threshold pause — global pause already active (reason=${settings.globalPauseReason ?? "unknown"})`,
      );
      return false;
    }

    this.paused = true;

    log.warn(
      `Proactive usage-threshold pause: ${window} at ${percentUsed}% (>= threshold ${thresholdPercent}%)`,
    );

    await this.store.updateSettings({ globalPause: true, globalPauseReason: "usage-threshold" });

    log.warn("⚠ Global pause activated proactively (usage-threshold) — reserving operator headroom before a hard limit");
    return true;
  }
}
