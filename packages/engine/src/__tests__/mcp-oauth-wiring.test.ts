/**
 * FNXC:McpConfig 2026-07-12-01:00:
 * FUSI-077: Surface Enumeration coverage for the ten named engine lanes' MCP OAuth token-store wiring.
 * FUSI-076 built the settings-backed McpOAuthTokenStore persistence seam (createSettingsBackedMcpOAuthTokenStore /
 * buildMcpOAuthTokenStore) and the additive `scopeByServerName` field on `resolveMcpServersForStore`, but a
 * documented wiring-completeness failure left every real call path forwarding only `.servers` — the effective
 * `McpOAuthTokenStore` reaching `createFusionMcpOAuthProvider` stayed the warn-only no-op
 * (`createWarnOnlyMcpOAuthTokenStore`) for every real session. This suite proves a representative sample of the
 * named lanes now forward BOTH `mcpSettingsStore` and `mcpServerScopeByName` (not just `mcpServers`) into their
 * `createFnAgent`/`createResolvedAgentSession` call, so a non-interactive OAuth refresh persists rather than
 * silently living only in-memory for the current process. `pi.ts`'s own `createFnAgent -> connectMcpSessionTools`
 * forwarding, and the settings-backed-store-vs-warn-only fork inside `connectMcpSessionTools` itself, are already
 * covered by `pi.test.ts` ("FUSI-076: threads mcpOAuthTokenStore/mcpSettingsStore/mcpServerScopeByName...") and
 * `mcp-session-tools.test.ts` ("connectMcpSessionTools — real token store wiring (FUSI-076 Step 3)") respectively;
 * this file exists to close the *lane* gap FUSI-077 targets.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskStore } from "@fusion/core";

const { createFnAgentMock, createResolvedAgentSessionMock, promptWithFallbackMock } = vi.hoisted(() => ({
  createFnAgentMock: vi.fn(),
  createResolvedAgentSessionMock: vi.fn(),
  promptWithFallbackMock: vi.fn(async () => undefined),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: createFnAgentMock,
  promptWithFallback: promptWithFallbackMock,
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string) => model),
}));

vi.mock("../agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createResolvedAgentSession: createResolvedAgentSessionMock };
});

/** A minimal TaskStore fake with a single project-scope OAuth-auth MCP server, matching the
 * mcp-pr-response-forwarding.test.ts / mcp-session-tools.test.ts conventions so `resolveMcpServersForStore`
 * runs its REAL implementation end-to-end (not mocked) and returns a real, non-empty `scopeByServerName`. */
function fakeStoreWithOAuthServer(serverName = "docs-oauth"): TaskStore {
  return {
    async getSettingsByScope() {
      return {
        global: { mcpServers: { enabled: true, servers: [] } },
        project: {
          mcpServers: {
            enabled: true,
            servers: [
              {
                name: serverName,
                transport: "streamable-http",
                url: "https://mcp.example.test/stream",
                auth: {
                  type: "oauth",
                  authorizationServerUrl: "https://auth.example.test",
                  clientId: "client-1",
                  accessToken: { secretRef: "oauth-token", scope: "project" },
                },
              },
            ],
          },
        },
      };
    },
    async getSecretsStore() {
      return {
        async revealSecret(id: string) {
          return { key: id, plaintextValue: "materialized-oauth-secret" };
        },
      };
    },
    async listTasks() {
      return [];
    },
    getEvalStore() {
      return {
        listTaskResults() {
          return [];
        },
      };
    },
  } as unknown as TaskStore;
}

beforeEach(() => {
  createFnAgentMock.mockReset();
  createResolvedAgentSessionMock.mockReset();
  promptWithFallbackMock.mockClear();
});

describe("FUSI-077: engine-lane MCP OAuth wiring — createFnAgent-based lanes", () => {
  it("cron-runner.createAiPromptExecutor forwards mcpSettingsStore + mcpServerScopeByName", async () => {
    const { createAiPromptExecutor } = await import("../cron-runner.js");
    const store = fakeStoreWithOAuthServer("cron-oauth");
    createFnAgentMock.mockResolvedValueOnce({
      session: { dispose: vi.fn() },
    });

    const executor = await createAiPromptExecutor("/tmp/fusion-cron-test", store);
    await executor("Run scheduled automation");

    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    const callOptions = createFnAgentMock.mock.calls[0]?.[0];
    expect(callOptions.mcpSettingsStore).toBe(store);
    expect(callOptions.mcpServerScopeByName).toEqual({ "cron-oauth": "project" });
    expect(callOptions.mcpServers).toEqual([
      expect.objectContaining({ name: "cron-oauth" }),
    ]);
  });

  it("cron-runner.createAiPromptExecutor stays fail-soft (no store) — warn-only path preserved", async () => {
    const { createAiPromptExecutor } = await import("../cron-runner.js");
    createFnAgentMock.mockResolvedValueOnce({
      session: { dispose: vi.fn() },
    });

    const executor = await createAiPromptExecutor("/tmp/fusion-cron-test");
    await executor("Run scheduled automation");

    const callOptions = createFnAgentMock.mock.calls[0]?.[0];
    expect(callOptions.mcpSettingsStore).toBeUndefined();
    expect(callOptions.mcpServerScopeByName).toBeUndefined();
    expect(callOptions.mcpServers).toBeUndefined();
  });

  it("evaluator.HybridEvaluatorService forwards mcpSettingsStore + mcpServerScopeByName when runPrompt is not overridden", async () => {
    const { HybridEvaluatorService } = await import("../evaluator.js");
    const store = fakeStoreWithOAuthServer("eval-oauth");
    const evidence = [{ kind: "task", label: "status", value: "done", source: "task" }];
    const aiResponse = JSON.stringify({
      categories: {
        agentPerformance: { score: 80, rationale: "ok", evidence },
        taskOutcomeQuality: { score: 80, rationale: "ok", evidence },
        processCompliance: { score: 80, rationale: "ok", evidence },
      },
      overallRationale: "ok",
      followUpDrafts: [],
    });
    createFnAgentMock.mockImplementationOnce(async (options: { onText?: (delta: string) => void }) => {
      options.onText?.(aiResponse);
      return { session: { dispose: vi.fn() } };
    });

    const service = new HybridEvaluatorService({
      cwd: "/tmp/fusion-evaluator-test",
      store,
      collectEvidence: async () => ({ items: [] }) as never,
    });

    await service.evaluateTask(
      {
        id: "FN-9001",
        description: "desc",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
        prompt: "prompt",
      } as never,
      { runId: "ER-1", startedAt: "2026-07-12T00:00:00.000Z" },
      { taskEvaluationFollowUpPolicy: "none" },
    );

    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    const callOptions = createFnAgentMock.mock.calls[0]?.[0];
    expect(callOptions.mcpSettingsStore).toBe(store);
    expect(callOptions.mcpServerScopeByName).toEqual({ "eval-oauth": "project" });
  });

  it("pr-response-run-ops.makePrResponseAgentRunner forwards mcpSettingsStore + mcpServerScopeByName", async () => {
    const { makePrResponseAgentRunner } = await import("../pr-response-run-ops.js");
    const store = fakeStoreWithOAuthServer("pr-response-oauth");
    createResolvedAgentSessionMock.mockResolvedValueOnce({
      session: { dispose: vi.fn() },
    });

    const runner = makePrResponseAgentRunner(
      { defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" } as never,
      "FN-9002",
      "/tmp/fusion-pr-response-test",
      store,
    );
    await runner({
      prompt: "Resolve review threads",
      systemPrompt: "System",
      threads: [{ id: "thread-1" }],
    });

    expect(createResolvedAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionPurpose: "merger",
      mcpSettingsStore: store,
      mcpServerScopeByName: { "pr-response-oauth": "project" },
    }));
  });
});

describe("FUSI-077: engine-lane MCP OAuth wiring — createResolvedAgentSession-based lanes", () => {
  it("reviewer.reviewStep forwards mcpSettingsStore + mcpServerScopeByName", async () => {
    const { reviewStep } = await import("../reviewer.js");
    const store = fakeStoreWithOAuthServer("reviewer-oauth");
    Object.assign(store, {
      async getSettings() {
        return {};
      },
      async logEntry() {
        return undefined;
      },
    });
    createResolvedAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockImplementation((cb: (event: unknown) => void) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nok." },
          });
        }),
        dispose: vi.fn(),
      },
    });

    await reviewStep(
      "/tmp/fusion-reviewer-test",
      "FN-9003",
      1,
      "Test Step",
      "plan",
      "# prompt",
      undefined,
      { store },
    );

    expect(createResolvedAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionPurpose: "reviewer",
      mcpSettingsStore: store,
      mcpServerScopeByName: { "reviewer-oauth": "project" },
    }));
  });
});

describe("FUSI-077: agent-heartbeat.resolveHeartbeatMcpForAgent widening", () => {
  it("returns the full resolved object including scopeByServerName (not just servers)", async () => {
    const { resolveHeartbeatMcpForAgent } = await import("../agent-heartbeat.js");
    const store = fakeStoreWithOAuthServer("heartbeat-oauth");

    const resolved = await resolveHeartbeatMcpForAgent(store, "agent-1");

    expect(resolved.servers).toEqual([
      expect.objectContaining({ name: "heartbeat-oauth" }),
    ]);
    expect(resolved.scopeByServerName).toEqual({ "heartbeat-oauth": "project" });
  });

  it("stays fail-soft with an empty scopeByServerName when no store is supplied", async () => {
    const { resolveHeartbeatMcpForAgent } = await import("../agent-heartbeat.js");

    const resolved = await resolveHeartbeatMcpForAgent(undefined, "agent-1");

    expect(resolved).toEqual({ servers: [], errors: [], scopeByServerName: {} });
  });
});
