import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import type { ProviderUsage } from "../api";
import { useUsageData } from "../hooks/useUsageData";
import "./GlobalPauseBanner.css";

interface GlobalPauseBannerProps {
  globalPaused: boolean;
  globalPauseReason: string | undefined;
}

/**
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * Browser-side twin of `resolveRateLimitResetAt` in `packages/dashboard/src/usage.ts`
 * (that file is server-only — it uses Node built-ins like `https`/`fs` and cannot be
 * imported into the browser bundle). Keep this algorithm in lockstep with the server
 * twin: select, across the Claude provider's windows, the exhausted windows
 * (`percentLeft <= 0` or `percentUsed >= 100` — the window that would have triggered
 * the rate-limit globalPause) and return the soonest future `resetAt`/`resetMs`.
 * Returns `null` when no exhausted window has a valid future reset — a non-exhausted
 * window's resetAt is intentionally ignored even if it's the soonest, since it isn't
 * the reason for the pause.
 */
function resolveRateLimitResetAt(
  providers: ProviderUsage[],
): { resetAt: string; resetMs: number } | null {
  const claude = providers.find((p) => p.name === "Claude" && p.status === "ok");
  if (!claude) return null;

  const now = Date.now();
  let best: { resetAt: string; resetMs: number } | null = null;

  for (const window of claude.windows) {
    const isExhausted = window.percentLeft <= 0 || window.percentUsed >= 100;
    if (!isExhausted) continue;
    if (!window.resetAt || window.resetMs === undefined) continue;

    const resetTimeMs = new Date(window.resetAt).getTime();
    if (Number.isNaN(resetTimeMs) || resetTimeMs <= now) continue;
    if (window.resetMs <= 0) continue;

    if (!best || resetTimeMs < new Date(best.resetAt).getTime()) {
      best = { resetAt: window.resetAt, resetMs: window.resetMs };
    }
  }

  return best;
}

/** Format a millisecond duration as e.g. "2h 15m" / "45m" / "30s". */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatClockTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * Wires previously display-only usage data (`packages/dashboard/src/usage.ts`
 * resetAt/resetMs, formerly only shown inside the Usage dropdown) into an
 * operator-facing ETA on the global-pause banner. Renders only when paused for
 * `rate-limit` — manual pauses and non-paused states render nothing (no shell).
 */
export function GlobalPauseBanner({ globalPaused, globalPauseReason }: GlobalPauseBannerProps) {
  const { t } = useTranslation("app");
  const isRateLimitPause = globalPaused && globalPauseReason === "rate-limit";
  const { providers } = useUsageData({ autoRefresh: isRateLimitPause });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isRateLimitPause) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isRateLimitPause]);

  if (!isRateLimitPause) return null;

  const reset = resolveRateLimitResetAt(providers);
  const remainingMs = reset ? new Date(reset.resetAt).getTime() - nowMs : 0;

  return (
    <section className="global-pause-banner" role="status" aria-live="polite" data-testid="global-pause-banner">
      <div className="global-pause-banner__indicator" aria-hidden="true">
        <Clock className="global-pause-banner__icon" />
      </div>
      <div className="global-pause-banner__content">
        {reset ? (
          <p className="global-pause-banner__body">
            {t(
              "globalPauseBanner.rateLimitEta",
              "Paused — Claude 5h/weekly limit, resumes ~{{clockTime}} (in {{countdown}})",
              { clockTime: formatClockTime(reset.resetAt), countdown: formatCountdown(Math.max(remainingMs, 0)) },
            )}
          </p>
        ) : (
          <p className="global-pause-banner__body">
            {t("globalPauseBanner.rateLimitUnknown", "Paused — Claude limit, resuming automatically")}
          </p>
        )}
      </div>
    </section>
  );
}
