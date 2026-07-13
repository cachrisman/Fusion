/**
 * FUSI-058: proactive usage-threshold global-pause tests.
 *
 * Covers the maintenance-sweep seam (`SelfHealingManager.checkUsageThresholdPause`,
 * private — invoked via `(manager as any)`, matching the established pattern in
 * self-healing-db-corruption.test.ts) and its ntfy dispatch, plus the
 * `UsageLimitPauser.onUsageThresholdReached` entry point it calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, TaskStore } from "@fusion/core";

import { SelfHealingManager, type UsageControlSnapshot } from "../self-healing.js";
import { UsageLimitPauser } from "../usage-limit-detector.js";
import type { NotificationService } from "../notification/notification-service.js";
import * as notifierModule from "../notifier.js";

function createMockStore(overrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({
      maintenanceIntervalMs: 0,
      globalPause: false,
      enginePaused: false,
      // usagePauseThresholdPercent intentionally undefined by default (feature off)
    } as unknown as Settings),
    updateSettings: vi.fn().mockResolvedValue({} as Settings),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

function makeSnapshot(overrides: Partial<UsageControlSnapshot> = {}): UsageControlSnapshot {
  return {
    worstPercentUsed: 95,
    worstPercentLeft: 5,
    soonestResetAt: new Date(Date.now() + 3_600_000).toISOString(),
    soonestResetMs: 3_600_000,
    pace: "on-track",
    worstWindowLabel: "weekly",
    ...overrides,
  };
}

describe("FUSI-058: proactive usage-threshold pause (SelfHealingManager.checkUsageThresholdPause)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue(undefined);
    vi.spyOn(notifierModule, "sendNtfyNotification").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("triggers a proactive pause (globalPauseReason: \"usage-threshold\") when worst-case usage crosses the configured threshold", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 90,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 92 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true, globalPauseReason: "usage-threshold" });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:usage-threshold-pause",
      target: "global",
      metadata: expect.objectContaining({ worstPercentUsed: 92, thresholdPercent: 90 }),
    }));
  });

  it("does NOT pause when usage is under the configured threshold", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 90,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 55 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(store.updateSettings).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("does NOT pause when the feature is off (usagePauseThresholdPercent undefined), even at 100% usage", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: undefined,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 100 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(getUsageControlSnapshot).not.toHaveBeenCalled();
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("does NOT pause when the snapshot resolves null (no Claude provider / unavailable)", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 90,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(null);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("does NOT pause (and does not even read the snapshot) when already paused for any reason, including \"manual\"", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: true,
        globalPauseReason: "manual",
        usagePauseThresholdPercent: 50,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 99 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(getUsageControlSnapshot).not.toHaveBeenCalled();
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("does NOT re-pause when already paused with globalPauseReason: \"usage-threshold\" (idempotent)", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: true,
        globalPauseReason: "usage-threshold",
        usagePauseThresholdPercent: 50,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 99 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("does NOT pause when no usageLimitPauser is wired (graceful no-op)", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 50,
      }),
    });
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 99 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("dispatches a usage-threshold-pause notification via the active NotificationService when a pause is triggered", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue({ dispatch } as unknown as NotificationService);
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 90,
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 92, worstWindowLabel: "weekly" }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(dispatch).toHaveBeenCalledWith("usage-threshold-pause", expect.objectContaining({
      event: "usage-threshold-pause",
      metadata: expect.objectContaining({ worstPercentUsed: 92, thresholdPercent: 90, worstWindowLabel: "weekly" }),
    }));
  });

  it("dispatches the ntfy fallback path when no NotificationService is active and the event is enabled", async () => {
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue(undefined);
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 90,
        ntfyEnabled: true,
        ntfyTopic: "fusion-alerts",
        ntfyEvents: ["usage-threshold-pause"],
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 92 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    expect(notifierModule.sendNtfyNotification).toHaveBeenCalledWith(expect.objectContaining({
      topic: "fusion-alerts",
    }));
  });

  it("does NOT dispatch ntfy when the usage-threshold-pause event is not in ntfyEvents (opt-in, disabled by default)", async () => {
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue(undefined);
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        usagePauseThresholdPercent: 90,
        ntfyEnabled: true,
        ntfyTopic: "fusion-alerts",
        ntfyEvents: ["failed"], // usage-threshold-pause NOT included
      }),
    });
    const usageLimitPauser = new UsageLimitPauser(store);
    const getUsageControlSnapshot = vi.fn().mockResolvedValue(makeSnapshot({ worstPercentUsed: 92 }));
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      usageLimitPauser,
      getUsageControlSnapshot,
    });

    await (manager as any).checkUsageThresholdPause();

    // Pause still fires — notification opt-in is independent of the pause trigger.
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true, globalPauseReason: "usage-threshold" });
    expect(notifierModule.sendNtfyNotification).not.toHaveBeenCalled();
  });
});

describe("FUSI-058: UsageLimitPauser.onUsageThresholdReached", () => {
  function createPauserMockStore(globalPause = false, globalPauseReason?: string) {
    return {
      getSettings: vi.fn().mockResolvedValue({ globalPause, globalPauseReason }),
      updateSettings: vi.fn().mockResolvedValue({ globalPause: true }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("activates a proactive pause with globalPauseReason: \"usage-threshold\" and returns true", async () => {
    const store = createPauserMockStore(false);
    const pauser = new UsageLimitPauser(store);

    const activated = await pauser.onUsageThresholdReached({ window: "weekly", percentUsed: 92, thresholdPercent: 90 });

    expect(activated).toBe(true);
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true, globalPauseReason: "usage-threshold" });
  });

  it("returns false and does not call updateSettings when already paused for any reason", async () => {
    const store = createPauserMockStore(true, "manual");
    const pauser = new UsageLimitPauser(store);

    const activated = await pauser.onUsageThresholdReached({ window: "weekly", percentUsed: 92, thresholdPercent: 90 });

    expect(activated).toBe(false);
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("a subsequent onUsageLimitHit (\"rate-limit\") escalates a prior \"usage-threshold\" pause in place", async () => {
    const store = createPauserMockStore(false);
    const pauser = new UsageLimitPauser(store);

    // First: proactive threshold pause activates.
    await pauser.onUsageThresholdReached({ window: "weekly", percentUsed: 92, thresholdPercent: 90 });
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true, globalPauseReason: "usage-threshold" });

    // Now a hard rate-limit hit occurs while that pause is still active.
    store.getSettings.mockResolvedValue({ globalPause: true, globalPauseReason: "usage-threshold" });
    await pauser.onUsageLimitHit("executor", "FN-001", "429 rate limited");

    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true, globalPauseReason: "rate-limit" });
    expect(store.updateSettings).toHaveBeenCalledTimes(2);
  });
});
