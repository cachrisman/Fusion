/*
 * FNXC:RateLimitResume 2026-07-11-00:00:
 * FUSI-064 Step 1 regression: a usage-limit/429 underlying error at the pi.ts
 * model-selection fallback seam (session-creation and prompt-time, both with
 * and without a distinct configured fallback) must NEVER be wrapped in a
 * terminal ModelFallbackExhaustedError. Every lane's isUsageLimitError(err.message)
 * classifier depends on seeing the raw usage-limit error, not a wrapped
 * "Unable to select a usable model..." message. A genuine non-usage-limit
 * model-selection failure (e.g. auth-tier incompatibility) must still produce
 * the terminal, operator-actionable ModelFallbackExhaustedError.
 */
import { describe, it, expect, vi } from "vitest";
import { createFnAgent } from "../pi.js";
import { createAgentSession, ModelRegistry, type AgentSession } from "@earendil-works/pi-coding-agent";
import { isUsageLimitError } from "../usage-limit-detector.js";

vi.mock("../skill-resolver.js", () => ({
  resolveSessionSkills: vi.fn(),
  createSkillsOverrideFromSelection: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({
      getCredentials: vi.fn().mockResolvedValue({}),
    })),
  },
  createAgentSession: vi.fn(async () => ({
    session: {
      model: { provider: "test", id: "test" },
      subscribe: vi.fn(),
      prompt: vi.fn(),
      sessionFile: undefined,
    },
  })),
  createCodingTools: vi.fn(() => []),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: vi.fn(() => ({ name: "read" })),
  createBashTool: vi.fn(() => ({ name: "bash" })),
  createEditTool: vi.fn(() => ({ name: "edit" })),
  createWriteTool: vi.fn(() => ({ name: "write" })),
  createGrepTool: vi.fn(() => ({ name: "grep" })),
  createFindTool: vi.fn(() => ({ name: "find" })),
  createLsTool: vi.fn(() => ({ name: "ls" })),
  createExtensionRuntime: vi.fn(),
  DefaultResourceLoader: vi.fn().mockImplementation(function () {
    return {
      reload: vi.fn().mockResolvedValue(undefined),
      skillsOverride: undefined,
    };
  }),
  DefaultPackageManager: vi.fn(),
  discoverAndLoadExtensions: vi.fn().mockResolvedValue({ errors: [], runtime: { pendingProviderRegistrations: [] } }),
  getAgentDir: vi.fn(() => "/test/agent-dir"),
  ModelRegistry: Object.assign(
    vi.fn().mockImplementation(() => ({
      find: vi.fn().mockReturnValue({ provider: "test", id: "test-model" }),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    })),
    {
      create: vi.fn().mockReturnValue({
        find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
        getAll: vi.fn().mockReturnValue([]),
        registerProvider: vi.fn(),
        refresh: vi.fn(),
      }),
    },
  ),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    model: { provider: "test", id: "test-model" },
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    sessionFile: undefined,
    state: { errorMessage: "", messages: [] },
    ...overrides,
  } as unknown as AgentSession;
}

describe("pi.ts fallback seam — usage-limit never becomes ModelFallbackExhaustedError", () => {
  it("re-throws a raw usage-limit error at session-creation when the distinct fallback ALSO 429s", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockRejectedValueOnce(new Error("rate_limit_error: Rate limit exceeded"));

    await expect(
      createFnAgent({
        cwd: "/test/project",
        systemPrompt: "Test usage-limit session-creation",
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        fallbackProvider: "anthropic",
        fallbackModelId: "claude-3-5-haiku-20241022",
        taskId: "FN-USAGE-1",
      }),
    ).rejects.toMatchObject({
      message: "rate_limit_error: Rate limit exceeded",
    });

    // Must NOT be the terminal ModelFallbackExhaustedError
    await expect(
      createFnAgent({
        cwd: "/test/project",
        systemPrompt: "Test usage-limit session-creation 2",
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        fallbackProvider: "anthropic",
        fallbackModelId: "claude-3-5-haiku-20241022",
        taskId: "FN-USAGE-1b",
      }).catch((err: unknown) => err),
    ).resolves.not.toMatchObject({ name: "ModelFallbackExhaustedError" });
  });

  it("re-throws a raw usage-limit error at prompt-time when the distinct fallback ALSO 429s", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    vi.mocked(ModelRegistry.create).mockReturnValueOnce({
      find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    } as any);

    const primarySession = makeSession({
      model: { provider: "openai", id: "gpt-4o" } as any,
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
    });
    const fallbackSession = makeSession({
      model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" } as any,
      prompt: vi.fn().mockRejectedValue(new Error("overloaded_error: Overloaded")),
    });

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test usage-limit prompt-time",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-3-5-haiku-20241022",
      taskId: "FN-USAGE-2",
    });

    const err = await (session as any).promptWithFallback("prompt text").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("ModelFallbackExhaustedError");
    expect(isUsageLimitError((err as Error).message)).toBe(true);
    expect((err as Error).message).toBe("overloaded_error: Overloaded");
  });

  it("re-throws a raw usage-limit error at prompt-time when no distinct fallback is configured", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    vi.mocked(ModelRegistry.create).mockReturnValueOnce({
      find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    } as any);

    const primarySession = makeSession({
      model: { provider: "openai", id: "gpt-4o" } as any,
      prompt: vi.fn().mockRejectedValue(new Error("quota exceeded for this billing period")),
    });

    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockResolvedValueOnce({ session: primarySession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test usage-limit prompt-time no-fallback",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4o", // same as primary => no distinct fallback
      taskId: "FN-USAGE-3",
    });

    const err = await (session as any).promptWithFallback("prompt text").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("ModelFallbackExhaustedError");
    expect((err as Error).message).toBe("quota exceeded for this billing period");
  });

  it("still produces the terminal ModelFallbackExhaustedError for a genuine non-usage-limit model-selection failure", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    vi.mocked(ModelRegistry.create).mockReturnValueOnce({
      find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    } as any);

    const primarySession = makeSession({
      model: { provider: "openai", id: "gpt-4o" } as any,
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
    });
    const fallbackSession = makeSession({
      model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" } as any,
      prompt: vi.fn().mockRejectedValue(new Error("401 invalid api key for fallback")),
    });

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test genuine model-selection exhaustion",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-3-5-haiku-20241022",
      taskId: "FN-USAGE-4",
    });

    await expect((session as any).promptWithFallback("prompt text")).rejects.toMatchObject({
      name: "ModelFallbackExhaustedError",
      attempts: 2,
      primaryModel: "openai/gpt-4o",
      fallbackModel: "anthropic/claude-3-5-haiku-20241022",
      triggerPoint: "prompt-time",
    });
  });
});
