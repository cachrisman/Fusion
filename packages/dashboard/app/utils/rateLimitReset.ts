import type { ProviderUsage } from "../api";

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
 *
 * FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
 * Extracted out of `GlobalPauseBanner.tsx` (originally added by FUSI-053) into this
 * shared util so `RateLimitedTaskNotice` (per-task calm state) and `GlobalPauseBanner`
 * (board-level banner) consume ONE copy of the resolver/formatters instead of forking
 * a second algorithm. `GlobalPauseBanner.tsx` now imports from here — no behavior change.
 */
export function resolveRateLimitResetAt(
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
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatClockTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
}
