/*
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * FUSI-064 Step 4 — Symptom Verification rollup.
 *
 * Original symptom: a 429 `rate_limit_error` during triage/execution/merge
 * rendered a red "Task Failed"/"FAILED" with raw provider JSON and a manual
 * Retry button; no auto-resume after the limit reset.
 *
 * Exact reproduction: an AI lane's primary model (and, in the distinct-
 * fallback case, its configured fallback too) returns a 429 `rate_limit_error`
 * at prompt-time. This suite uses the FUSI-063 canonical scripted string
 * (`rate_limit_error: Rate limit exceeded`), which `isUsageLimitError`
 * classifies.
 *
 * Assertion it is gone: per lane, the task is NOT marked `failed`,
 * `globalPause`/`globalPauseReason:'rate-limit'` is set, and (self-healing
 * suite) auto-unpause clears the pause without manual intervention.
 *
 * This file asserts the triage lane directly. The other lanes' equivalent
 * assertions are intentionally kept in their own files rather than merged
 * here, because each already owns a large, lane-specific `vi.mock("../pi.js")
 * / vi.mock("../reviewer.js") / vi.mock("../rate-limit-retry.js")` harness
 * that would conflict (duplicate hoisted module mocks) if combined into one
 * file:
 *   - executor lane: `executor-usage-limit-not-terminal.test.ts`
 *     (TaskExecutor.execute() 429 → pause, todo+preserveResumeState, never failed)
 *   - merger lane (incl. the "primary AND distinct fallback both 429" case):
 *     the "aiMergeTask — usage limit detection" describe block in
 *     `merger-merge-details.test.ts`, extended by this same task (FUSI-064)
 *   - pi.ts model-selection seam (session-creation + prompt-time, with and
 *     without a distinct fallback): `pi-fallback-usage-limit.test.ts`
 *   - self-healing auto-unpause-after-reset re-drive:
 *     `self-healing-rate-limit-redrive.test.ts`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, Task, TaskDetail, Settings } from "@fusion/core";

// ── Triage lane ─────────────────────────────────────────────────────────

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../reviewer.js", () => ({ reviewStep: vi.fn() }));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {
    readonly primaryModel: string;
    readonly fallbackModel?: string;
    readonly triggerPoint: "session-creation" | "prompt-time";
    readonly attempts: number;
    readonly underlyingReason: string;
    constructor(input: { primaryModel: string; fallbackModel?: string; triggerPoint: "session-creation" | "prompt-time"; attempts: number; underlyingReason: string }) {
      super(`Unable to select a usable model after ${input.attempts} attempts: ${input.underlyingReason}`);
      this.name = "ModelFallbackExhaustedError";
      this.primaryModel = input.primaryModel;
      this.fallbackModel = input.fallbackModel;
      this.triggerPoint = input.triggerPoint;
      this.attempts = input.attempts;
      this.underlyingReason = input.underlyingReason;
    }
  }
  return {
    ModelFallbackExhaustedError,
    createFnAgent: mockCreateFnAgent,
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: mockPromptWithFallback,
  };
});

vi.mock("../rate-limit-retry.js", () => ({
  withRateLimitRetry: (fn: () => Promise<any>) => fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original), {});
});

import { TriageProcessor } from "../triage.js";
import { UsageLimitPauser } from "../usage-limit-detector.js";

function createTriageMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true,
    } as Settings),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

const mockTaskDetail: TaskDetail = {
  id: "FN-SYMPTOM-TRIAGE",
  description: "Test task description",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# FN-SYMPTOM-TRIAGE\n\nOriginal specification content.",
  attachments: [],
};

function createTriageTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-SYMPTOM-TRIAGE",
    description: "Triage task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Symptom Verification — 429 rate_limit_error is never a terminal task failure (FUSI-064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[triage] a scripted 429 rate_limit_error pauses (globalPause:'rate-limit') and does not fail the task", async () => {
    const task = createTriageTask();
    const store = createTriageMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockPromptWithFallback.mockRejectedValueOnce(new Error("rate_limit_error: Rate limit exceeded"));
    mockCreateFnAgent.mockImplementationOnce(async () => ({
      session: {
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
      },
    }));

    const processor = new TriageProcessor(store, "/tmp/root", { usageLimitPauser: pauser } as any);
    await processor.specifyTask(task);

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith("triage", task.id, expect.stringContaining("rate_limit_error"));
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true, globalPauseReason: "rate-limit" });

    const updateTaskMock = store.updateTask as unknown as ReturnType<typeof vi.fn>;
    const failedCalls = updateTaskMock.mock.calls.filter(([, patch]: [string, Record<string, unknown>]) => patch?.status === "failed");
    expect(failedCalls).toHaveLength(0);
  });
});
