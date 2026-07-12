import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResolvedMcpServerDefinition } from "@fusion/core";

const { createFnAgentMock } = vi.hoisted(() => ({
  createFnAgentMock: vi.fn(async () => ({
    session: {
      prompt: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
  })),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: createFnAgentMock,
  promptWithFallback: vi.fn(async () => undefined),
  describeModel: vi.fn(() => "mock-model"),
}));

import { createResolvedAgentSession } from "../agent-session-helpers.js";

const mcpServers: ResolvedMcpServerDefinition[] = [
  {
    name: "docs",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: { MCP_TOKEN: "materialized-secret" },
  },
];

async function createLaneSession(sessionPurpose: "executor" | "reviewer" | "validation" | "merger" | "heartbeat") {
  return createResolvedAgentSession({
    sessionPurpose,
    cwd: "/tmp/fusion-test-worktree",
    systemPrompt: `You are the ${sessionPurpose} lane`,
    tools: "readonly",
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4",
    mcpServers,
  });
}

describe("MCP lane forwarding", () => {
  beforeEach(() => {
    createFnAgentMock.mockClear();
  });

  it.each([
    ["executor"],
    ["reviewer"],
    ["validation"],
    ["merger"],
    ["heartbeat"],
  ] as const)("forwards materialized MCP servers through the shared %s lane runtime seam", async (sessionPurpose) => {
    await createLaneSession(sessionPurpose);

    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers,
      systemPrompt: `You are the ${sessionPurpose} lane`,
    }));
  });

  it("passes mcpServers through the shared helper seam used by workflow-node and summarization callers", async () => {
    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/fusion-test-worktree",
      systemPrompt: "Workflow model node and summarization lanes share this helper.",
      tools: "readonly",
      defaultProvider: "anthropic",
      mcpServers,
      runtimeContext: { lane: "workflow-node+summarization" },
    });

    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers,
      runtimeContext: expect.objectContaining({ lane: "workflow-node+summarization" }),
    }));
  });

  it("does not send mock-provider sessions through the pi createFnAgent seam", async () => {
    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/fusion-test-worktree",
      systemPrompt: "Mock providers are MCP-incapable.",
      tools: "readonly",
      defaultProvider: "mock",
      defaultModelId: "scripted",
      mcpServers,
    });

    expect(createFnAgentMock).not.toHaveBeenCalled();
    expect(result.runtimeId).toBe("mock");
  });

  /*
   * FNXC:McpConfig 2026-07-12-18:20:
   * FUSI-080: `createResolvedAgentSession` is the shared lane helper used by chat.ts and
   * pr-conflict-resolver.ts (the two lanes that use it directly, rather than calling
   * createFnAgent inline). It must forward the FUSI-076 mcpSettingsStore/mcpServerScopeByName
   * options through to createFnAgent — verifying the AgentRuntimeOptions widening added in
   * agent-runtime.ts (Step 0 of FUSI-080) actually reaches the real session-creation call, not
   * just the type declaration.
   */
  describe("mcpSettingsStore + mcpServerScopeByName passthrough (FUSI-080)", () => {
    const fakeMcpSettingsStore = {
      getSettingsByScope: vi.fn(),
      getSecretsStore: vi.fn(),
      updateSettings: vi.fn(),
      updateGlobalSettings: vi.fn(),
    };
    const scopeByServerName = { docs: "project" as const };

    it("forwards mcpSettingsStore + mcpServerScopeByName to createFnAgent alongside mcpServers", async () => {
      await createResolvedAgentSession({
        sessionPurpose: "merger",
        cwd: "/tmp/fusion-test-worktree",
        systemPrompt: "chat/pr-conflict-resolver lanes share this helper.",
        tools: "readonly",
        defaultProvider: "anthropic",
        mcpServers,
        mcpSettingsStore: fakeMcpSettingsStore,
        mcpServerScopeByName: scopeByServerName,
      });

      expect(createFnAgentMock).toHaveBeenCalledTimes(1);
      expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
        mcpServers,
        mcpSettingsStore: fakeMcpSettingsStore,
        mcpServerScopeByName: scopeByServerName,
      }));
    });

    it("omits mcpSettingsStore/mcpServerScopeByName when the caller supplies neither (back-compat, warn-only preserved)", async () => {
      await createResolvedAgentSession({
        sessionPurpose: "merger",
        cwd: "/tmp/fusion-test-worktree",
        systemPrompt: "No store supplied.",
        tools: "readonly",
        defaultProvider: "anthropic",
        mcpServers,
      });

      expect(createFnAgentMock).toHaveBeenCalledTimes(1);
      const forwarded = createFnAgentMock.mock.calls[0]![0];
      expect(forwarded.mcpSettingsStore).toBeUndefined();
      expect(forwarded.mcpServerScopeByName).toBeUndefined();
    });
  });
});
