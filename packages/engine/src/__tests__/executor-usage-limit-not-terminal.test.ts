/*
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * FUSI-064 Step 2 regression: a usage-limit/429 error during single-session
 * TaskExecutor.execute() must classify BEFORE the generic "execution failed"
 * terminal handling, must call usageLimitPauser.onUsageLimitHit, and must
 * leave the task resumable in todo (never status:"failed").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { UsageLimitPauser } from "../usage-limit-detector.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function createMockTask() {
  return {
    id: "FN-USAGE-EXEC",
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("TaskExecutor.execute — usage limit is never a terminal task failure (FUSI-064)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("fires the pauser, requeues to todo with resume state preserved, and never marks the task failed", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
    });

    const pauser = new UsageLimitPauser(store as any);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    const mockPrompt = vi.fn().mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: mockPrompt,
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test", { usageLimitPauser: pauser } as any);
    await executor.execute(createMockTask() as any);

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "executor",
      "FN-USAGE-EXEC",
      expect.stringContaining("rate_limit_error"),
    );
    expect(store.updateSettings).toHaveBeenCalledWith({
      globalPause: true,
      globalPauseReason: "rate-limit",
    });

    // Requeued to todo (resumable), not left dangling in-progress nor failed.
    const moveTaskMock = store.moveTask as unknown as ReturnType<typeof vi.fn>;
    const todoMoveCalls = moveTaskMock.mock.calls.filter(([, column]: [string, string]) => column === "todo");
    expect(todoMoveCalls.length).toBeGreaterThan(0);
    expect(todoMoveCalls[0]![2]).toMatchObject({ preserveResumeState: true });

    // Never persisted status:"failed" for the usage-limit condition.
    const updateTaskMock = store.updateTask as unknown as ReturnType<typeof vi.fn>;
    const failedCalls = updateTaskMock.mock.calls.filter(
      ([, patch]: [string, Record<string, unknown>]) => patch && patch.status === "failed",
    );
    expect(failedCalls).toHaveLength(0);
  });
});
