/*
FNXC:UsageControl 2026-07-11-00:00 (FUSI-057):
Real-assertion coverage for `resolveUsageControlSnapshot`, the pure engine-consumable
reduction of `ProviderUsage[]`. Covers worst-case window selection, soonest-future-reset
selection, weekly pace passthrough, and the null cases (no Claude provider, non-"ok"
status, zero usable windows).
*/
import { describe, it, expect } from "vitest";
import { resolveUsageControlSnapshot, type ProviderUsage, type UsageWindow } from "../usage.js";

function makeWindow(overrides: Partial<UsageWindow> & Pick<UsageWindow, "label" | "percentUsed" | "percentLeft">): UsageWindow {
  return {
    resetText: null,
    ...overrides,
  };
}

function makeClaudeProvider(windows: UsageWindow[], status: ProviderUsage["status"] = "ok"): ProviderUsage {
  return {
    name: "Claude",
    icon: "🤖",
    status,
    windows,
  };
}

describe("resolveUsageControlSnapshot", () => {
  it("selects the worst-case window (highest percentUsed) across 5h + weekly", () => {
    const providers: ProviderUsage[] = [
      makeClaudeProvider([
        makeWindow({ label: "Session (5h)", percentUsed: 40, percentLeft: 60 }),
        makeWindow({ label: "Weekly", percentUsed: 92, percentLeft: 8 }),
      ]),
    ];

    const snapshot = resolveUsageControlSnapshot(providers);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.worstPercentUsed).toBe(92);
    expect(snapshot!.worstWindowLabel).toBe("Weekly");
    expect(snapshot!.worstPercentLeft).toBe(8);
  });

  it("picks the soonest positive resetMs across windows and ignores missing/zero/negative resetMs", () => {
    const providers: ProviderUsage[] = [
      makeClaudeProvider([
        makeWindow({
          label: "Session (5h)",
          percentUsed: 10,
          percentLeft: 90,
          resetMs: 500_000,
          resetAt: "2026-07-11T01:00:00.000Z",
        }),
        makeWindow({
          label: "Weekly",
          percentUsed: 20,
          percentLeft: 80,
          resetMs: 100_000,
          resetAt: "2026-07-11T00:30:00.000Z",
        }),
        makeWindow({
          label: "Weekly (Sonnet)",
          percentUsed: 5,
          percentLeft: 95,
          resetMs: 0,
          resetAt: "2026-07-11T00:00:00.000Z",
        }),
        makeWindow({
          label: "Weekly (Opus)",
          percentUsed: 5,
          percentLeft: 95,
          resetMs: -100,
          resetAt: "2026-07-10T23:00:00.000Z",
        }),
      ]),
    ];

    const snapshot = resolveUsageControlSnapshot(providers);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.soonestResetMs).toBe(100_000);
    expect(snapshot!.soonestResetAt).toBe("2026-07-11T00:30:00.000Z");
  });

  it("copies the Weekly window's pace.status to snapshot.pace", () => {
    const providers: ProviderUsage[] = [
      makeClaudeProvider([
        makeWindow({
          label: "Weekly",
          percentUsed: 50,
          percentLeft: 50,
          pace: { status: "behind", percentElapsed: 60, message: "behind pace" },
        }),
      ]),
    ];

    const snapshot = resolveUsageControlSnapshot(providers);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.pace).toBe("behind");
  });

  it("returns null pace when the Weekly window has no pace", () => {
    const providers: ProviderUsage[] = [
      makeClaudeProvider([makeWindow({ label: "Weekly", percentUsed: 50, percentLeft: 50 })]),
    ];

    const snapshot = resolveUsageControlSnapshot(providers);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.pace).toBeNull();
  });

  it("returns null when there is no Claude provider", () => {
    const providers: ProviderUsage[] = [
      {
        name: "Codex",
        icon: "🧠",
        status: "ok",
        windows: [makeWindow({ label: "Weekly", percentUsed: 90, percentLeft: 10 })],
      },
    ];

    expect(resolveUsageControlSnapshot(providers)).toBeNull();
  });

  it("returns null when the Claude provider status is not ok", () => {
    const providers: ProviderUsage[] = [
      makeClaudeProvider([makeWindow({ label: "Weekly", percentUsed: 90, percentLeft: 10 })], "error"),
    ];

    expect(resolveUsageControlSnapshot(providers)).toBeNull();
  });

  it("returns null when the Claude provider has zero usable windows", () => {
    const providers: ProviderUsage[] = [makeClaudeProvider([])];

    expect(resolveUsageControlSnapshot(providers)).toBeNull();

    const providersWithUnrelatedWindow: ProviderUsage[] = [
      makeClaudeProvider([makeWindow({ label: "Some Other Window", percentUsed: 90, percentLeft: 10 })]),
    ];
    expect(resolveUsageControlSnapshot(providersWithUnrelatedWindow)).toBeNull();
  });
});
