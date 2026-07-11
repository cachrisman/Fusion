import { describe, expect, it } from "vitest";

import { formatClockTime, formatCountdown, resolveRateLimitResetAt } from "../rateLimitReset";
import type { ProviderUsage } from "../../api";

function makeClaudeUsage(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    name: "Claude",
    icon: "\ud83e\udd16",
    status: "ok",
    windows,
  };
}

describe("resolveRateLimitResetAt", () => {
  it("returns null when no Claude provider is present", () => {
    expect(resolveRateLimitResetAt([{ name: "OpenAI", icon: "", status: "ok", windows: [] }])).toBeNull();
  });

  it("returns null when no window is exhausted", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const providers = [
      makeClaudeUsage([
        { label: "Session (5h)", percentLeft: 40, percentUsed: 60, resetText: "resets in 1m", resetAt: future, resetMs: 60_000 },
      ]),
    ];
    expect(resolveRateLimitResetAt(providers)).toBeNull();
  });

  it("returns null when the exhausted window's reset is in the past", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const providers = [
      makeClaudeUsage([
        { label: "Session (5h)", percentLeft: 0, percentUsed: 100, resetText: "resets in 1s", resetAt: past, resetMs: 1000 },
      ]),
    ];
    expect(resolveRateLimitResetAt(providers)).toBeNull();
  });

  it("picks the soonest future reset among exhausted windows", () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 90_000).toISOString();
    const providers = [
      makeClaudeUsage([
        { label: "Weekly", percentLeft: 0, percentUsed: 100, resetText: "resets in 90s", resetAt: later, resetMs: 90_000 },
        { label: "Session (5h)", percentLeft: -1, percentUsed: 101, resetText: "resets in 30s", resetAt: soon, resetMs: 30_000 },
      ]),
    ];
    const result = resolveRateLimitResetAt(providers);
    expect(result?.resetAt).toBe(soon);
  });

  it("ignores a non-exhausted window's resetAt even if soonest", () => {
    const soonNonExhausted = new Date(Date.now() + 5_000).toISOString();
    const exhaustedLater = new Date(Date.now() + 90_000).toISOString();
    const providers = [
      makeClaudeUsage([
        { label: "Session (5h)", percentLeft: 50, percentUsed: 50, resetText: "resets in 5s", resetAt: soonNonExhausted, resetMs: 5_000 },
        { label: "Weekly", percentLeft: 0, percentUsed: 100, resetText: "resets in 90s", resetAt: exhaustedLater, resetMs: 90_000 },
      ]),
    ];
    const result = resolveRateLimitResetAt(providers);
    expect(result?.resetAt).toBe(exhaustedLater);
  });
});

describe("formatCountdown", () => {
  it("returns 'now' for zero/negative durations", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-100)).toBe("now");
  });

  it("formats seconds/minutes/hours", () => {
    expect(formatCountdown(30_000)).toBe("30s");
    expect(formatCountdown(90_000)).toBe("1m");
    expect(formatCountdown(2 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe("2h 15m");
    expect(formatCountdown(3 * 60 * 60 * 1000)).toBe("3h");
  });
});

describe("formatClockTime", () => {
  it("formats an ISO timestamp as a locale clock time string", () => {
    const formatted = formatClockTime("2026-07-11T14:30:00.000Z");
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });
});
