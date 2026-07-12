import { describe, expect, it } from "vitest";
import { computeEffectiveMaxConcurrent } from "../adaptive-concurrency.js";
import type { UsageControlSnapshot } from "../self-healing.js";

function makeSnapshot(overrides: Partial<UsageControlSnapshot> = {}): UsageControlSnapshot {
  return {
    worstPercentUsed: 50,
    worstPercentLeft: 50,
    soonestResetAt: null,
    soonestResetMs: null,
    pace: null,
    worstWindowLabel: "Weekly",
    ...overrides,
  };
}

describe("computeEffectiveMaxConcurrent", () => {
  it("feature OFF (throttleThresholdPercent undefined) returns baseMaxConcurrent unchanged, regardless of usage/pace", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 99, pace: "ahead" });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: undefined,
        pauseThresholdPercent: 90,
      }),
    ).toBe(4);
  });

  it("null snapshot returns baseMaxConcurrent unchanged", () => {
    expect(
      computeEffectiveMaxConcurrent({
        snapshot: null,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(4);
  });

  it("undefined snapshot (provider unavailable) returns baseMaxConcurrent unchanged", () => {
    expect(
      computeEffectiveMaxConcurrent({
        snapshot: undefined,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(4);
  });

  it("below throttle returns the full baseMaxConcurrent", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 50 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(4);
  });

  it("interpolates at the midpoint between thresholds (base 4, throttle 75, pause 90, worst 82.5 -> 3)", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 82.5 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(3);
  });

  it("interpolates at the 3/4 point between thresholds (base 4, throttle 75, pause 90, worst 86.25 -> 2)", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 86.25 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(2);
  });

  it("at/over the pause threshold returns the floor of 1", () => {
    const atPause = makeSnapshot({ worstPercentUsed: 90 });
    const overPause = makeSnapshot({ worstPercentUsed: 97 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot: atPause,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(1);
    expect(
      computeEffectiveMaxConcurrent({
        snapshot: overPause,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(1);
  });

  it("never returns below 1, even with pace 'ahead' at/over the pause threshold", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 95, pace: "ahead" });
    const result = computeEffectiveMaxConcurrent({
      snapshot,
      baseMaxConcurrent: 4,
      throttleThresholdPercent: 75,
      pauseThresholdPercent: 90,
    });
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBe(1);
  });

  it("pace 'ahead' reduces the effective cap by one additional step vs on-track/behind/null within the throttle band", () => {
    const onTrack = computeEffectiveMaxConcurrent({
      snapshot: makeSnapshot({ worstPercentUsed: 82.5, pace: "on-track" }),
      baseMaxConcurrent: 4,
      throttleThresholdPercent: 75,
      pauseThresholdPercent: 90,
    });
    const behind = computeEffectiveMaxConcurrent({
      snapshot: makeSnapshot({ worstPercentUsed: 82.5, pace: "behind" }),
      baseMaxConcurrent: 4,
      throttleThresholdPercent: 75,
      pauseThresholdPercent: 90,
    });
    const noPace = computeEffectiveMaxConcurrent({
      snapshot: makeSnapshot({ worstPercentUsed: 82.5, pace: null }),
      baseMaxConcurrent: 4,
      throttleThresholdPercent: 75,
      pauseThresholdPercent: 90,
    });
    const ahead = computeEffectiveMaxConcurrent({
      snapshot: makeSnapshot({ worstPercentUsed: 82.5, pace: "ahead" }),
      baseMaxConcurrent: 4,
      throttleThresholdPercent: 75,
      pauseThresholdPercent: 90,
    });

    expect(onTrack).toBe(3);
    expect(behind).toBe(3);
    expect(noPace).toBe(3);
    expect(ahead).toBe(onTrack - 1);
    expect(ahead).toBe(2);
  });

  it("pace 'ahead' step-down is clamped at the floor of 1 near the pause threshold", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 88.5, pace: "ahead" });
    // Without pace this would round to 1 already; pace must not push it below 1.
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(1);
  });

  it("pace 'ahead' has no effect below the throttle threshold (an under-usage board is never throttled by pace alone)", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 50, pace: "ahead" });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(4);
  });

  it("misconfiguration guard: throttle >= pause resolves to feature-off (no NaN/0)", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 95 });
    const result = computeEffectiveMaxConcurrent({
      snapshot,
      baseMaxConcurrent: 4,
      throttleThresholdPercent: 90,
      pauseThresholdPercent: 75,
    });
    expect(result).toBe(4);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("misconfiguration guard: equal throttle/pause resolves to feature-off", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 80 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 80,
        pauseThresholdPercent: 80,
      }),
    ).toBe(4);
  });

  it("misconfiguration guard: non-finite baseMaxConcurrent is coerced to at least 1", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 50 });
    const result = computeEffectiveMaxConcurrent({
      snapshot,
      baseMaxConcurrent: Number.NaN,
      throttleThresholdPercent: 75,
      pauseThresholdPercent: 90,
    });
    expect(result).toBe(1);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("misconfiguration guard: baseMaxConcurrent < 1 is coerced to at least 1", () => {
    const snapshot = makeSnapshot({ worstPercentUsed: 50 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 0,
        throttleThresholdPercent: 75,
        pauseThresholdPercent: 90,
      }),
    ).toBe(1);
  });

  it("defaults the ramp ceiling to 100 when pauseThresholdPercent is undefined", () => {
    // base 4, throttle 50, no pause threshold -> ceiling 100. Midpoint (worst=75) should
    // interpolate to roughly half-way: progress=(75-50)/50=0.5 -> 4 - 0.5*3 = 2.5 -> round 3.
    const snapshot = makeSnapshot({ worstPercentUsed: 75 });
    expect(
      computeEffectiveMaxConcurrent({
        snapshot,
        baseMaxConcurrent: 4,
        throttleThresholdPercent: 50,
        pauseThresholdPercent: undefined,
      }),
    ).toBe(3);
  });
});
