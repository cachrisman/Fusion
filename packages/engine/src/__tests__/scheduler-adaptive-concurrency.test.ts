import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Task, TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import type { UsageControlSnapshot } from "../self-healing.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    title: "Adaptive concurrency task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/*
FNXC:UsageControl 2026-07-11-14:30 (FUSI-059):
Scheduler-level harness proving `computeEffectiveMaxConcurrent` is actually wired into
live dispatch (not just unit-tested in isolation). All todo->in-progress dispatch in this
codebase flows through the hold/release sweep (`shouldRunWorkflowColumnScheduler` always
returns true), so exercising `scheduler.schedule()` end-to-end covers BOTH the primary
maxConcurrent read and the reservation/hold-release read described in the task spec —
they are the same code path here.
*/
function storeWith(
  tasks: Task[],
  settings: Record<string, unknown> = {},
): TaskStore {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return {
    listTasks: vi.fn(async () => [...byId.values()]),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 4,
      maxWorktrees: 10,
      ...settings,
    })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ ...settings, ...patch })),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const current = byId.get(id);
      if (current) Object.assign(current, patch);
      return current as Task;
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = byId.get(id);
      if (current) current.column = column;
      return current as Task;
    }),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getMissionStore: vi.fn(() => ({
      listMissions: () => [],
      listGoalIdsForMission: () => [],
    })),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

function inProgressCount(tasks: Task[]): number {
  return tasks.filter((t) => t.column === "in-progress").length;
}

describe("Scheduler adaptive concurrency (FUSI-059)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nBody");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches to the REDUCED effective cap when usage is between throttle and pause thresholds", async () => {
    const tasks = [
      task({ id: "FN-100" }),
      task({ id: "FN-101" }),
      task({ id: "FN-102" }),
      task({ id: "FN-103" }),
    ];
    const store = storeWith(tasks, {
      maxConcurrent: 4,
      usageThrottleThresholdPercent: 75,
      usagePauseThresholdPercent: 90,
    });
    const snapshot: UsageControlSnapshot = {
      worstPercentUsed: 82.5, // midpoint -> effective cap 3 (see adaptive-concurrency.test.ts)
      worstPercentLeft: 17.5,
      soonestResetAt: null,
      soonestResetMs: null,
      pace: "on-track",
      worstWindowLabel: "Weekly",
    };
    const getUsageControlSnapshot = vi.fn(async () => snapshot);
    const scheduler = new Scheduler(store, { getUsageControlSnapshot });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(getUsageControlSnapshot).toHaveBeenCalled();
    expect(inProgressCount(tasks)).toBe(3);
    expect(inProgressCount(tasks)).toBeLessThan(4);
  });

  it("dispatches to the full static cap when the feature is OFF (thresholds undefined) — no behavior change", async () => {
    const tasks = [
      task({ id: "FN-200" }),
      task({ id: "FN-201" }),
      task({ id: "FN-202" }),
      task({ id: "FN-203" }),
    ];
    const store = storeWith(tasks, { maxConcurrent: 4 });
    const snapshot: UsageControlSnapshot = {
      worstPercentUsed: 95, // would be at/over a pause threshold if the feature were on
      worstPercentLeft: 5,
      soonestResetAt: null,
      soonestResetMs: null,
      pace: "ahead",
      worstWindowLabel: "Weekly",
    };
    const getUsageControlSnapshot = vi.fn(async () => snapshot);
    const scheduler = new Scheduler(store, { getUsageControlSnapshot });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(inProgressCount(tasks)).toBe(4);
  });

  it("floors dispatch at 1 when usage is at/over the pause threshold (still unpaused — never fully blocks)", async () => {
    const tasks = [
      task({ id: "FN-300" }),
      task({ id: "FN-301" }),
      task({ id: "FN-302" }),
    ];
    const store = storeWith(tasks, {
      maxConcurrent: 4,
      usageThrottleThresholdPercent: 75,
      usagePauseThresholdPercent: 90,
    });
    const snapshot: UsageControlSnapshot = {
      worstPercentUsed: 96,
      worstPercentLeft: 4,
      soonestResetAt: null,
      soonestResetMs: null,
      pace: "ahead",
      worstWindowLabel: "Weekly",
    };
    const getUsageControlSnapshot = vi.fn(async () => snapshot);
    const scheduler = new Scheduler(store, { getUsageControlSnapshot });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(inProgressCount(tasks)).toBe(1);
  });

  it("treats a rejected/undefined snapshot provider as null and dispatches to the full static cap without throwing", async () => {
    const tasks = [
      task({ id: "FN-400" }),
      task({ id: "FN-401" }),
    ];
    const store = storeWith(tasks, {
      maxConcurrent: 2,
      usageThrottleThresholdPercent: 75,
      usagePauseThresholdPercent: 90,
    });
    const getUsageControlSnapshot = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const scheduler = new Scheduler(store, { getUsageControlSnapshot });
    (scheduler as unknown as { running: boolean }).running = true;

    await expect(scheduler.schedule()).resolves.toBeUndefined();
    expect(inProgressCount(tasks)).toBe(2);
  });

  it("honors the effective cap in the hold/release reservation path (the sole todo->in-progress dispatcher)", async () => {
    // This is the same code path exercised above (shouldRunWorkflowColumnScheduler is
    // always true in this codebase), so the reduced-cap assertion above already proves
    // the reservation/hold-release read (~2178) applies computeEffectiveMaxConcurrent —
    // this test additionally asserts moveTask was invoked exactly effectiveCap times.
    const tasks = [
      task({ id: "FN-500" }),
      task({ id: "FN-501" }),
      task({ id: "FN-502" }),
      task({ id: "FN-503" }),
    ];
    const store = storeWith(tasks, {
      maxConcurrent: 4,
      usageThrottleThresholdPercent: 75,
      usagePauseThresholdPercent: 90,
    });
    const snapshot: UsageControlSnapshot = {
      worstPercentUsed: 86.25, // -> effective cap 2 (see adaptive-concurrency.test.ts)
      worstPercentLeft: 13.75,
      soonestResetAt: null,
      soonestResetMs: null,
      pace: "on-track",
      worstWindowLabel: "Weekly",
    };
    const getUsageControlSnapshot = vi.fn(async () => snapshot);
    const scheduler = new Scheduler(store, { getUsageControlSnapshot });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledTimes(2);
    expect(inProgressCount(tasks)).toBe(2);
  });
});
