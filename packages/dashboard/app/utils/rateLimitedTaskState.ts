import type { Task } from "@fusion/core";

/*
FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
Before this task, a usage-limit/429 condition rendered IDENTICALLY to a hard
crash: red `failed` badge + "Task Failed" header, raw `rate_limit_error` JSON
dumped inline, and manual Retry as the primary CTA (FUSI-060/052/063 operator
screenshots 2026-07-11). This util is the SINGLE SOURCE OF TRUTH classifier
consumed by TaskCard, TaskDetailModal, and ListView so a self-recovering pause
renders as a calm "waiting for reset — auto-resuming" warning-tier state
instead. Genuine terminal failures (build/type/lint errors, permission
denials, etc.) MUST still classify false and keep the existing red treatment
— do not widen the match set beyond what the engine detector considers a
usage-limit condition.

`isUsageLimitTaskError` mirrors `isUsageLimitError` in
`packages/engine/src/usage-limit-detector.ts` byte-for-byte (same regex set).
It is intentionally re-implemented here rather than imported: `@fusion/engine`
must never be imported into the browser bundle (see AGENTS.md "Importing
across @fusion/* packages"). Keep the two pattern lists in lockstep — if you
change one, change the other in the same commit.

FUSI-064 (todo, not yet landed) will make usage-limit conditions non-terminal
at the engine layer. Until then the engine still marks these tasks `failed`,
so this classifier must key off `task.error` text and/or the board-level
`globalPauseReason === "rate-limit"` rather than a new engine-set field that
does not exist yet.
*/

/** Mirrors USAGE_LIMIT_PATTERNS in packages/engine/src/usage-limit-detector.ts — keep in lockstep. */
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
 * Classify whether a task's error message indicates a usage-limit condition
 * (rate limit, overloaded, quota/billing) rather than a genuine terminal
 * failure. Undefined/empty input is never a usage-limit condition.
 */
export function isUsageLimitTaskError(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export interface RateLimitedTaskContext {
  /** Board-level global pause state (from useAppSettings). */
  globalPaused?: boolean;
  /** Board-level global pause reason (from useAppSettings); "rate-limit" when the pause was triggered by a usage-limit hit. */
  globalPauseReason?: string;
}

/**
 * True when `task` represents a self-recovering usage-limit pause rather than
 * a genuine terminal failure. Two entry points both resolve to true:
 *  1. The task's own `error` text matches a usage-limit pattern (regardless
 *     of board-level pause state — the task may have already retried past
 *     the board pause window).
 *  2. The task is `failed` and the whole board is currently paused for
 *     `globalPauseReason === "rate-limit"` — even if this particular task's
 *     error text doesn't cleanly match (e.g. truncated/wrapped provider
 *     error), it was almost certainly interrupted by the same systemic
 *     condition that triggered the board pause.
 *
 * Returns false for any task that is not `failed`, and for genuine terminal
 * failures (build/type/lint/permission errors) even while the board happens
 * to be paused for an unrelated reason.
 */
export function isRateLimitedTask(
  task: Pick<Task, "status" | "error">,
  ctx: RateLimitedTaskContext = {},
): boolean {
  if (task.status !== "failed") return false;

  if (isUsageLimitTaskError(task.error)) return true;

  const boardRateLimitPause = ctx.globalPaused === true && ctx.globalPauseReason === "rate-limit";
  if (boardRateLimitPause && task.error) return true;

  return false;
}

export interface RateLimitedTaskCopy {
  /** Short headline used on the compact (card) variant and detail full variant alike. */
  headline: string;
  /** i18n key backing the headline, for callers that want to re-translate with interpolation. */
  headlineKey: string;
}

/**
 * Pure copy helper — returns the i18n key + English fallback for the calm
 * headline. Callers (RateLimitedTaskNotice) still route the key through
 * `useTranslation` themselves for interpolation; this only centralizes the
 * key/fallback pairing so card/detail/list never drift.
 */
export function getRateLimitedTaskCopy(): RateLimitedTaskCopy {
  return {
    headlineKey: "taskStatus.rateLimited.headline",
    headline: "Rate limit reached — waiting for reset",
  };
}
