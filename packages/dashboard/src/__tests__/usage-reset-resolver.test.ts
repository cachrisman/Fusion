import { describe, it, expect } from "vitest";
import { resolveRateLimitResetAt, type ProviderUsage } from "../usage.js";

function claude(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    name: "Claude",
    icon: "🟠",
    status: "ok",
    windows: [],
    ...overrides,
  };
}

describe("resolveRateLimitResetAt", () => {
  it("returns null when no window is exhausted", () => {
    const providers = [
      claude({
        windows: [
          { label: "Session (5h)", percentUsed: 50, percentLeft: 50, resetText: null, resetMs: 1000, resetAt: new Date(Date.now() + 1000).toISOString() },
        ],
      }),
    ];

    expect(resolveRateLimitResetAt(providers)).toBeNull();
  });

  it("returns null when the exhausted window's reset is in the past", () => {
    const providers = [
      claude({
        windows: [
          { label: "Session (5h)", percentUsed: 100, percentLeft: 0, resetText: null, resetMs: -1000, resetAt: new Date(Date.now() - 1000).toISOString() },
        ],
      }),
    ];

    expect(resolveRateLimitResetAt(providers)).toBeNull();
  });

  it("returns null when the Claude provider status is not 'ok'", () => {
    const providers = [
      claude({
        status: "error",
        windows: [
          { label: "Session (5h)", percentUsed: 100, percentLeft: 0, resetText: null, resetMs: 1000, resetAt: new Date(Date.now() + 1000).toISOString() },
        ],
      }),
    ];

    expect(resolveRateLimitResetAt(providers)).toBeNull();
  });

  it("picks the soonest future resetAt among exhausted windows, preferring Session over Weekly when both are exhausted", () => {
    const sessionReset = new Date(Date.now() + 60_000).toISOString();
    const weeklyReset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const providers = [
      claude({
        windows: [
          { label: "Weekly", percentUsed: 100, percentLeft: 0, resetText: null, resetMs: 7 * 24 * 60 * 60 * 1000, resetAt: weeklyReset },
          { label: "Session (5h)", percentUsed: 100, percentLeft: 0, resetText: null, resetMs: 60_000, resetAt: sessionReset },
        ],
      }),
    ];

    const result = resolveRateLimitResetAt(providers);
    expect(result).not.toBeNull();
    expect(result?.resetAt).toBe(sessionReset);
  });

  it("treats percentLeft <= 0 as exhausted even if percentUsed is slightly under 100", () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const providers = [
      claude({
        windows: [
          { label: "Session (5h)", percentUsed: 99.5, percentLeft: 0, resetText: null, resetMs: 60_000, resetAt },
        ],
      }),
    ];

    const result = resolveRateLimitResetAt(providers);
    expect(result).toEqual({ resetAt, resetMs: 60_000 });
  });

  it("ignores non-Claude providers", () => {
    const providers = [
      { name: "Codex", icon: "🟢", status: "ok" as const, windows: [
        { label: "Session (5h)", percentUsed: 100, percentLeft: 0, resetText: null, resetMs: 60_000, resetAt: new Date(Date.now() + 60_000).toISOString() },
      ] },
    ];

    expect(resolveRateLimitResetAt(providers)).toBeNull();
  });
});
