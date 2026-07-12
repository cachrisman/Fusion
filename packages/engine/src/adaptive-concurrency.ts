import type { UsageControlSnapshot } from "./self-healing.js";

/*
FNXC:UsageControl 2026-07-11-14:30 (FUSI-059):
CONTROL BEHAVIOR #2 of parent FUSI-054: adaptive concurrency + pace-aware dispatch. The
scheduler dispatch gate previously used a STATIC `maxConcurrent` cap right up until a hard
429/usage-limit error triggered a binary global pause (UsageLimitPauser). This helper computes
an EFFECTIVE cap that instead GLIDES down as worst-case usage rises from
`usageThrottleThresholdPercent` toward `usagePauseThresholdPercent`, so quota is stretched
across the window instead of being burned at full speed until a hard stop. It is a pure,
side-effect-free function (mirrors `computeConcurrencyGateDiagnostic`'s style) so the
interpolation contract is unit-testable in isolation from the scheduler.

Rules encoded here:
 - Feature OFF (`throttleThresholdPercent` undefined, or no `snapshot`): return
   `baseMaxConcurrent` unchanged — EXACT legacy behavior, no glide at all.
 - Below throttle (`worstPercentUsed < throttleThresholdPercent`): full `baseMaxConcurrent`
   (pace never throttles an under-usage board — see the pace rule below).
 - Between thresholds: linearly interpolate from `baseMaxConcurrent` at the throttle
   threshold down to a floor of `1` at the pause threshold (or at `100` when
   `pauseThresholdPercent` is undefined). Rounded with `Math.round` for a deterministic,
   symmetric glide (not floor-biased on either end).
 - At/over the pause threshold: floor `1` while unpaused. This helper NEVER decides the
   hard global pause itself — that boundary belongs to FUSI-058's proactive-threshold
   pause and the pre-existing hard-429 `UsageLimitPauser` path, both out of scope here.
 - Pace-aware step: when `snapshot.pace === "ahead"` (burning quota faster than the
   even-pace budget for the weekly window — i.e. OVER pace), subtract one additional
   step from the interpolated cap once usage is AT OR ABOVE the throttle threshold
   (chosen bounded, reversible mechanism: a concurrency step-down rather than a timing
   cooldown, so it composes cleanly with the existing dispatch loop instead of adding a
   second delay dimension). Pace never applies below throttle, so an otherwise
   comfortably-under-usage board is never throttled by pace alone.
 - Never returns below `1` while unpaused, and never returns `0`/`NaN`/negative.
 - Misconfiguration guard: a non-finite or `<1` `baseMaxConcurrent` is coerced up to `1`.
   A `throttleThresholdPercent >= pauseThresholdPercent` misconfiguration is treated as
   feature-off (returns `baseMaxConcurrent` unchanged) rather than risking a
   divide-by-zero/inverted ramp.
*/

export interface ComputeEffectiveMaxConcurrentParams {
  /** The current live usage-control snapshot (FUSI-057 seam), or `null` when unavailable. */
  snapshot: UsageControlSnapshot | null | undefined;
  /** The operator-configured base cap (`settings.maxConcurrent ?? options.maxConcurrent ?? 2`).
   *  This is the CEILING of the glide, never overwritten by this helper. */
  baseMaxConcurrent: number;
  /** `settings.usageThrottleThresholdPercent`. Undefined = feature off. */
  throttleThresholdPercent?: number;
  /** `settings.usagePauseThresholdPercent`. Undefined = ramp ceiling defaults to 100. */
  pauseThresholdPercent?: number;
}

/**
 * Pure helper: computes the effective dispatch concurrency cap from a live usage snapshot,
 * gliding from the full operator-configured cap down to a floor of 1 as usage rises from
 * the throttle threshold toward the pause threshold. See the FNXC comment above this
 * export for the full interpolation contract. Byte-for-byte identical to
 * `baseMaxConcurrent` when `throttleThresholdPercent` is undefined (feature off).
 */
export function computeEffectiveMaxConcurrent(params: ComputeEffectiveMaxConcurrentParams): number {
  const { snapshot, throttleThresholdPercent, pauseThresholdPercent } = params;

  // Guard: coerce a non-finite / <1 base to at least 1 so downstream math never
  // divides by zero or interpolates against a nonsensical ceiling.
  const baseMaxConcurrent = Number.isFinite(params.baseMaxConcurrent) && params.baseMaxConcurrent >= 1
    ? Math.floor(params.baseMaxConcurrent)
    : 1;

  // Feature OFF: undefined throttle threshold or no snapshot → exact legacy behavior.
  if (throttleThresholdPercent === undefined || !snapshot) {
    return baseMaxConcurrent;
  }

  // Misconfiguration guard: an inverted/degenerate threshold pair resolves to feature-off
  // rather than risking a divide-by-zero or an inverted (increasing) ramp.
  const rampCeiling = pauseThresholdPercent ?? 100;
  if (!Number.isFinite(throttleThresholdPercent) || !Number.isFinite(rampCeiling) || throttleThresholdPercent >= rampCeiling) {
    return baseMaxConcurrent;
  }

  const worstPercentUsed = snapshot.worstPercentUsed;
  const isAhead = snapshot.pace === "ahead";

  // Below throttle: full cap, unaffected by pace (an under-usage board is never
  // throttled by pace alone).
  if (worstPercentUsed < throttleThresholdPercent) {
    return baseMaxConcurrent;
  }

  // At/over the pause threshold: floor 1 while unpaused (the actual pause decision
  // belongs to FUSI-058 / the hard-429 UsageLimitPauser, not this helper).
  if (worstPercentUsed >= rampCeiling) {
    return 1;
  }

  // Between thresholds: linear interpolation from baseMaxConcurrent (at throttle) down
  // to 1 (at rampCeiling). Math.round for a deterministic, symmetric glide.
  const progress = (worstPercentUsed - throttleThresholdPercent) / (rampCeiling - throttleThresholdPercent);
  const interpolated = baseMaxConcurrent - progress * (baseMaxConcurrent - 1);
  let effective = Math.round(interpolated);

  // Pace-aware step-down: "ahead" (over pace) shaves one extra step once at/above
  // throttle, clamped to the floor of 1.
  if (isAhead) {
    effective -= 1;
  }

  return Math.min(baseMaxConcurrent, Math.max(1, effective));
}
