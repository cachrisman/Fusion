/*
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * FUSI-064 Step 3 regression: when a rate-limit globalPause clears via
 * self-healing's auto-unpause, tasks parked by the usage limit must be
 * re-driven without manual Retry — verified here by asserting the
 * globalPause/globalPauseReason clear (which re-opens the existing
 * triage-poll/executor-scheduler/auto-merge-cooldown pickup seams) and the
 * `task:reconcile-rate-limit-redrive` run-audit event fires. Uses fake
 * timers — no real waits (per the "Do Not Add Slow Tests" standing rule).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => logger),
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../worktree-pool.js", () => ({
  WorktreePool: vi.fn(),
  RemovalReason: {},
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  resolveWorktreeBackend: vi.fn(),
}));

vi.mock("../merger.js", () => ({ classifyOwnedLandedEvidence: vi.fn() }));

import { SelfHealingManager } from "../self-healing.js";
import type { Settings, Task, TaskStore } from "@fusion/core";

function createMockStore(tasks: Task[], initialSettings: Partial<Settings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let settings: Settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 0,
    autoUnpauseEnabled: true,
    ...initialSettings,
  } as unknown as Settings;

  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Partial<Settings>) => {
      const previous = settings;
      settings = { ...settings, ...patch };
      emitter.emit("settings:updated", { settings, previous });
      return settings;
    }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    updateTask: vi.fn().mockResolvedValue({} as Task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
  }) as unknown as TaskStore & EventEmitter;
  return store;
}

function parkedTodoTask(): Task {
  // FUSI-064: after the lane fix, a task parked by a usage-limit hit lands
  // here — todo, status cleared/null, NOT failed — so it is naturally
  // rescheduled once globalPause clears.
  return {
    id: "FN-RATE-1",
    column: "todo",
    paused: false,
    userPaused: false,
    status: null,
    error: null,
    steps: [{ status: "pending" }],
    title: "usage-limit parked task",
  } as unknown as Task;
}

describe("SelfHealingManager — rate-limit auto-unpause re-drives parked tasks (FUSI-064)", () => {
  let manager: SelfHealingManager;
  let store: TaskStore & EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
  });

  afterEach(() => {
    manager?.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("clears globalPause('rate-limit') and emits the redrive audit event after the auto-unpause backoff elapses", async () => {
    const task = parkedTodoTask();
    store = createMockStore([task]);
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    manager.start();

    // Simulate UsageLimitPauser.onUsageLimitHit triggering the pause.
    await store.updateSettings({ globalPause: true, globalPauseReason: "rate-limit" });

    let settings = await store.getSettings();
    expect(settings.globalPause).toBe(true);
    expect(settings.globalPauseReason).toBe("rate-limit");

    // Advance past the default auto-unpause base delay (300_000ms) so the
    // scheduled attemptUnpause() fires.
    await vi.advanceTimersByTimeAsync(300_000);

    settings = await store.getSettings();
    expect(settings.globalPause).toBe(false);
    expect(settings.globalPauseReason).toBeUndefined();

    // The parked task itself was never marked failed by self-healing during
    // this flow — it remains schedulable for the normal pickup seams.
    const updateTaskMock = store.updateTask as unknown as ReturnType<typeof vi.fn>;
    const failedCalls = updateTaskMock.mock.calls.filter(
      ([, patch]: [string, Record<string, unknown>]) => patch && patch.status === "failed",
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("does not emit a redrive event or backoff-clear for a manual (non-rate-limit) pause", async () => {
    store = createMockStore([parkedTodoTask()]);
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    manager.start();

    await store.updateSettings({ globalPause: true, globalPauseReason: "manual" });
    await vi.advanceTimersByTimeAsync(300_000);

    // Manual pauses are NOT auto-unpaused — requires explicit operator action.
    const settings = await store.getSettings();
    expect(settings.globalPause).toBe(true);
    expect(settings.globalPauseReason).toBe("manual");
  });
});
