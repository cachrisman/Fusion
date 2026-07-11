import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, RotateCw } from "lucide-react";
import { useUsageData } from "../hooks/useUsageData";
import { formatClockTime, formatCountdown, resolveRateLimitResetAt } from "../utils/rateLimitReset";
import "./RateLimitedTaskNotice.css";

export interface RateLimitedTaskNoticeProps {
  /** Raw error text captured on the task (e.g. `429 {"type":"error",...}`). Rendered collapsed, never inline. */
  error?: string;
  /** `compact` for the card surface, `full` for the task detail surface. Controls copy density only — same warning-tier treatment either way. */
  variant?: "compact" | "full";
  /** Retry handler. When provided, Retry renders as a SECONDARY action — never primary — while auto-resume is pending. */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
 * Shared warning-tier "waiting for reset — resuming automatically" affordance
 * for a usage-limit-classified task, rendered by TaskCard (compact), List
 * rows (compact), and TaskDetailModal (full) in place of the red
 * card-error/detail-error-alert box. Never uses `--color-error`; reuses the
 * same `resolveRateLimitResetAt` + `useUsageData` combo that powers
 * `GlobalPauseBanner` (FUSI-053) so the reset ETA is consistent across the
 * board banner and every per-task surface, with no new provider polling.
 * The raw error text is collapsed behind a native `<details>` disclosure —
 * it must never be dumped inline (that was the original FUSI-060/052/063
 * "identical to a hard crash" symptom this task fixes).
 */
export function RateLimitedTaskNotice({ error, variant = "compact", onRetry, retrying = false }: RateLimitedTaskNoticeProps) {
  const { t } = useTranslation("app");
  const { providers } = useUsageData({ autoRefresh: true });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const reset = resolveRateLimitResetAt(providers);
  const remainingMs = reset ? new Date(reset.resetAt).getTime() - nowMs : 0;
  const isCompact = variant === "compact";

  return (
    <div
      className={`rate-limited-notice rate-limited-notice--${variant}`}
      role="status"
      aria-live="polite"
      data-testid="rate-limited-notice"
    >
      <span className="rate-limited-notice__icon" aria-hidden="true">
        <Clock size={isCompact ? 12 : 16} />
      </span>
      <div className="rate-limited-notice__content">
        <div className="rate-limited-notice__headline">
          {t("taskStatus.rateLimited.headline", "Rate limit reached — waiting for reset")}
        </div>
        <div className="rate-limited-notice__subcopy">
          {reset ? (
            t(
              "taskStatus.rateLimited.subcopyWithEta",
              "Resumes automatically ~{{clockTime}} (in {{countdown}})",
              { clockTime: formatClockTime(reset.resetAt), countdown: formatCountdown(Math.max(remainingMs, 0)) },
            )
          ) : (
            t("taskStatus.rateLimited.subcopyUnknownEta", "Resuming automatically once the provider limit resets")
          )}
        </div>
        {error && (
          <details className="rate-limited-notice__details">
            <summary className="rate-limited-notice__details-summary">
              {t("taskStatus.rateLimited.rawErrorSummary", "Show raw error details")}
            </summary>
            <pre className="rate-limited-notice__raw-error">{error}</pre>
          </details>
        )}
        {onRetry && (
          <button
            type="button"
            className="btn btn-sm rate-limited-notice__retry-btn"
            onClick={onRetry}
            disabled={retrying}
          >
            <RotateCw size={12} />
            {retrying ? t("tasks.retrying", "Retrying…") : t("taskStatus.rateLimited.retry", "Retry now")}
          </button>
        )}
      </div>
    </div>
  );
}
