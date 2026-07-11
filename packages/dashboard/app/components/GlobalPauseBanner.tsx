import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import { useUsageData } from "../hooks/useUsageData";
import { resolveRateLimitResetAt, formatCountdown, formatClockTime } from "../utils/rateLimitReset";
import "./GlobalPauseBanner.css";

interface GlobalPauseBannerProps {
  globalPaused: boolean;
  globalPauseReason: string | undefined;
}

/*
FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
resolveRateLimitResetAt/formatCountdown/formatClockTime moved to
`../utils/rateLimitReset.ts` so `RateLimitedTaskNotice` (per-task calm state)
shares the exact same resolver/formatter code — no forked second algorithm.
See that file for the lockstep-with-server-twin contract.
*/

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
