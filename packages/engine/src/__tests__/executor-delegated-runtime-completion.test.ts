/*
FNXC:DelegatedRuntimeCompletion 2026-07-12-00:30:
FUSI-071 symptom-based acceptance coverage: a delegated CLI plugin runtime
(cursor/droid/grok — anything `isDelegatedCliRuntime()` returns true for) runs
its own self-contained agentic loop and never calls Fusion's injected
`fn_task_done` tool. Before this fix, executor.ts's completion gate treated
that as "Agent finished without calling fn_task_done", retried up to 3 times
(each retry re-spawning the CLI and re-doing identical work), and ultimately
failed the task despite the work having succeeded on the very first session.

These tests assert the fixed invariant across the Surface Enumeration's
"Terminal event / outcome states" row:
  1. Delegated success (promptWithFallback resolves without throwing) completes
     the task on the FIRST session — `taskDoneSessionRetries === 0`, asserted
     indirectly via `mockedCreateFnAgent` call count staying at 1.
  2. Delegated terminal-error (promptWithFallback rejects, mirroring the cursor
     adapter throwing on `result.is_error:true`) maps to a REAL Fusion failure
     (`status: "failed"`, error surfaced, `onError` called) — never a silent
     no-fn_task_done retry.
  3. pi/mock sessions (the resolved runtimeId stays "pi") are UNCHANGED — a
     session that resolves without calling fn_task_done still enters the
     existing retry loop (regression guard; already covered by
     executor-step-session.test.ts's "requeues to todo after 3 retries..." but
     re-asserted here alongside the delegated-runtime override plumbing to
     prove the two paths are mutually exclusive on the SAME test harness).
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  resetExecutorMocks,
  resolvedRuntimeIdOverride,
} from "./executor-test-helpers.js";

describe("FUSI-071: delegated CLI runtime terminal-success completion gate", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function baseTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-CURSOR-1",
      title: "Cursor task",
      description: "Delegated CLI runtime task",
      column: "in-progress",
      dependencies: [],
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
      currentStep: 1,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [x] check\n### Step 1: Implement\n- [ ] implement",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("completes on the first session with zero fn_task_done-missing retries when a delegated CLI runtime terminal-succeeds", async () => {
    const store = createMockStore();
    const task = baseTask();
    store.getTask.mockResolvedValue(task);

    resolvedRuntimeIdOverride.current = "cursor";
    resolvedRuntimeIdOverride.wasConfigured = true;

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        model: "auto",
        // Resolves without ever invoking the fn_task_done custom tool —
        // exactly the reported cursor-agent shape (its own agentic loop
        // succeeds but Fusion's injected tool is never called).
        prompt: vi.fn().mockResolvedValue({
          stopReason: "stop",
          usage: {
            inputTokens: 120,
            outputTokens: 40,
            cachedTokens: 10,
            cacheWriteTokens: 5,
            totalTokens: 175,
          },
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
    await executor.execute(task as any);

    // Zero fn_task_done-missing retries: only ONE session was ever created
    // (the primary session), never the "initial + 3 retries" shape asserted
    // by executor-step-session.test.ts's pi-path regression case.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Delegated terminal-success is treated as implicit fn_task_done and
    // hands the task off to review — never "Agent finished without calling
    // fn_task_done".
    expect(store.moveTask).toHaveBeenCalledWith("FN-CURSOR-1", "in-review");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-CURSOR-1",
      expect.stringContaining('Delegated CLI runtime "cursor" completed without calling fn_task_done'),
      undefined,
      expect.any(Object),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-CURSOR-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();

    // result.usage is captured into task token usage.
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-CURSOR-1",
      expect.objectContaining({
        tokenUsage: expect.objectContaining({
          inputTokens: 120,
          outputTokens: 40,
          cachedTokens: 10,
          cacheWriteTokens: 5,
        }),
      }),
    );
  });

  it("maps a delegated CLI runtime terminal-error to a real failure, never a silent no-fn_task_done retry", async () => {
    const store = createMockStore();
    const task = baseTask({ id: "FN-CURSOR-2" });
    store.getTask.mockResolvedValue(task);

    resolvedRuntimeIdOverride.current = "cursor";
    resolvedRuntimeIdOverride.wasConfigured = true;

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        model: "auto",
        // Mirrors CursorRuntimeAdapter throwing on `result.is_error:true`.
        prompt: vi.fn().mockRejectedValue(
          new Error("cursor-agent execution failed: something went wrong"),
        ),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
    await executor.execute(task as any);

    // A real failure — surfaced immediately, no retry sessions spun up.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-CURSOR-2", {
      status: "failed",
      error: expect.stringContaining("cursor-agent execution failed"),
    });
    expect(onError).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-CURSOR-2", "in-review");
  });

  it("pi sessions that resolve without fn_task_done still enter the existing retry loop (regression guard)", async () => {
    const store = createMockStore();
    const task = baseTask({ id: "FN-PI-1" });
    store.getTask.mockResolvedValue(task);

    // Explicitly the default — a delegated-runtime override must never apply
    // to the pi/default path.
    resolvedRuntimeIdOverride.current = "pi";
    resolvedRuntimeIdOverride.wasConfigured = false;

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
    await executor.execute(task as any);

    // pi/mock behavior is unchanged: initial session + 3 no-fn_task_done retries.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-PI-1",
      "Agent finished without calling fn_task_done (after 3 retries) — requeued to todo immediately (1/3)",
      undefined,
      expect.any(Object),
    );
  });
});
