/*
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * FUSI-064 Step 2 regression: a usage-limit/429 error during triage specification
 * must be classified BEFORE the ModelFallbackExhaustedError "Triage failed" branch,
 * must call usageLimitPauser.onUsageLimitHit (globalPause('rate-limit')), and must
 * NEVER persist status:"failed" on the task.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, Task, TaskDetail, Settings } from "@fusion/core";

const { mockReviewStep, mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {
    readonly primaryModel: string;
    readonly fallbackModel?: string;
    readonly triggerPoint: "session-creation" | "prompt-time";
    readonly attempts: number;
    readonly underlyingReason: string;

    constructor(input: { primaryModel: string; fallbackModel?: string; triggerPoint: "session-creation" | "prompt-time"; attempts: number; underlyingReason: string }) {
      const fallbackClause = input.fallbackModel ? `, fallback ${input.fallbackModel}` : ", no fallback configured";
      super(`Unable to select a usable model after ${input.attempts} attempts (primary ${input.primaryModel}${fallbackClause}, trigger: ${input.triggerPoint}): ${input.underlyingReason}`);
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

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
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
  id: "FN-USAGE-TRIAGE",
  description: "Test task description",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# FN-USAGE-TRIAGE - Test Task\n\nOriginal specification content.",
  attachments: [],
};

function createTriageTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-USAGE-TRIAGE",
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

describe("TriageProcessor.specifyTask — usage limit is never a terminal task failure (FUSI-064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies a 429/rate-limit error before ModelFallbackExhaustedError, pauses, and does not mark the task failed", async () => {
    const task = createTriageTask();
    const store = createMockStore({
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

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "triage",
      task.id,
      expect.stringContaining("rate_limit_error"),
    );
    expect(store.updateSettings).toHaveBeenCalledWith({
      globalPause: true,
      globalPauseReason: "rate-limit",
    });

    // Never persisted status:"failed" for the usage-limit condition.
    const updateTaskMock = store.updateTask as unknown as ReturnType<typeof vi.fn>;
    const failedCalls = updateTaskMock.mock.calls.filter(
      ([, patch]: [string, Record<string, unknown>]) => patch && patch.status === "failed",
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("still marks the task failed for a genuine (non-usage-limit) model-selection exhaustion", async () => {
    const task = createTriageTask({ id: "FN-USAGE-TRIAGE-2" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    const { ModelFallbackExhaustedError } = await import("../pi.js");
    mockCreateFnAgent.mockImplementationOnce(async () => {
      throw new ModelFallbackExhaustedError({
        primaryModel: "openai/gpt-4o",
        triggerPoint: "session-creation",
        attempts: 1,
        underlyingReason: "invalid api key",
      });
    });

    const processor = new TriageProcessor(store, "/tmp/root", { usageLimitPauser: pauser } as any);
    await processor.specifyTask(task);

    expect(onUsageLimitHitSpy).not.toHaveBeenCalled();
    const updateTaskMock = store.updateTask as unknown as ReturnType<typeof vi.fn>;
    const failedCalls = updateTaskMock.mock.calls.filter(
      ([, patch]: [string, Record<string, unknown>]) => patch && patch.status === "failed",
    );
    expect(failedCalls.length).toBeGreaterThan(0);
  });
});
