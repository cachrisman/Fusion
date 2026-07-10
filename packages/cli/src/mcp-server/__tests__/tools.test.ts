/**
 * FNXC:McpServer 2026-07-10-21:00:
 * Registry + smoke coverage for the Fusion operator MCP server. Uses a real
 * TaskStore/AgentStore rooted at a temp project dir (mirrors
 * packages/cli/src/__tests__/extension-workflow-tools.test.ts) instead of a
 * deep @fusion/core mock, and connects the server through the SDK's
 * InMemoryTransport pair so the test never spawns a subprocess or touches
 * stdio/network (fast, matches the "Do Not Add Slow Tests" standing rule).
 *
 * FNXC:McpServer 2026-07-10-22:10:
 * FUSI-002 extends this suite with the flag-gated destructive tier:
 * `buildMcpToolRegistry({ allowDestructive })` must be the ONLY place the
 * base v1 set and the destructive tier are combined, `fn mcp serve` without
 * `--allow-destructive` must keep the exact FUSI-001 tool set, and every
 * destructive dispatch must reuse the SAME @fusion/core operation the
 * pi-extension handler uses (never duplicated validation) while emitting a
 * stderr-only audit line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, AgentStore, type WorkflowIr } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_REGISTRY, DESTRUCTIVE_TOOL_TIER, buildMcpToolRegistry, redactSecretsDeep } from "../tools.js";
import { buildMcpServer } from "../server.js";

const EXPECTED_TOOL_NAMES = [
  "fn_task_create",
  "fn_task_list",
  "fn_task_show",
  "fn_task_search",
  "fn_delegate_task",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_create",
  "fn_agent_start",
  "fn_agent_stop",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_workflow_create",
  "fn_workflow_update",
  "fn_workflow_select",
];

const EXPECTED_DESTRUCTIVE_TOOL_NAMES = ["fn_task_delete", "fn_agent_delete", "fn_workflow_delete"];

const FORBIDDEN_NAME_PATTERNS = [/release/i, /publish/i, /version[-_]?tag/i, /changeset/i];

function workflowIr(name: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  } as WorkflowIr;
}

describe("MCP_TOOL_REGISTRY (curated v1 allow-list)", () => {
  it("declares exactly the curated allow-list, no more, no less", () => {
    expect(MCP_TOOL_REGISTRY.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("gives every tool a non-empty description and a valid object JSON-Schema inputSchema", () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(tool.description.trim().length, `${tool.name} description`).toBeGreaterThan(0);
      expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe("object");
      if (tool.inputSchema.required) {
        expect(Array.isArray(tool.inputSchema.required), `${tool.name} inputSchema.required`).toBe(true);
      }
      if (tool.inputSchema.properties) {
        expect(typeof tool.inputSchema.properties, `${tool.name} inputSchema.properties`).toBe("object");
      }
    }
  });

  it("never declares a release/publish/version-tag/changeset tool, and never declares a *_delete tool in the base set", () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        expect(pattern.test(tool.name), `${tool.name} matched forbidden pattern ${pattern}`).toBe(false);
      }
      expect(/_delete$/i.test(tool.name), `${tool.name} looks like a delete tool but is in the base set`).toBe(false);
    }
  });
});

describe("buildMcpToolRegistry (FUSI-002 destructive gate)", () => {
  it("omits the destructive tier and matches the base v1 set exactly when allowDestructive is false/absent", () => {
    expect(buildMcpToolRegistry({ allowDestructive: false }).map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(buildMcpToolRegistry({}).map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("adds exactly the three destructive tools, no more, no fewer, when allowDestructive is true", () => {
    const names = buildMcpToolRegistry({ allowDestructive: true }).map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES, ...EXPECTED_DESTRUCTIVE_TOOL_NAMES].sort());
    expect(DESTRUCTIVE_TOOL_TIER.map((t) => t.name).sort()).toEqual([...EXPECTED_DESTRUCTIVE_TOOL_NAMES].sort());
  });

  it("gives every destructive tool a DESTRUCTIVE-marked description and a valid inputSchema", () => {
    for (const tool of DESTRUCTIVE_TOOL_TIER) {
      expect(tool.description.trim().length, `${tool.name} description`).toBeGreaterThan(0);
      expect(tool.description).toMatch(/^DESTRUCTIVE:/);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("redactSecretsDeep", () => {
  it("redacts secret-shaped keys at any depth without mutating non-secret data", () => {
    const input = {
      taskId: "FN-001",
      apiKey: "sk-live-abcdef",
      nested: { token: "ghp_abc123", ok: "keep-me" },
      list: [{ password: "hunter2" }, { fine: "value" }],
    };
    const redacted = redactSecretsDeep(input);
    expect(redacted.apiKey).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).ok).toBe("keep-me");
    expect((redacted.list[0] as Record<string, unknown>).password).toBe("[redacted]");
    expect((redacted.list[1] as Record<string, unknown>).fine).toBe("value");
    expect(redacted.taskId).toBe("FN-001");
  });
});

describe("fn mcp serve — in-memory server smoke test", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fn-fusi-001-mcp-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    store = new TaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function connectClient(options: { allowDestructive?: boolean } = {}) {
    const mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: options.allowDestructive });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
    return { client, mcpServer };
  }

  it("initializes and lists exactly the curated tool set over an in-memory transport when allowDestructive is omitted", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = (tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        expect(names.some((name) => pattern.test(name))).toBe(false);
      }
      for (const destructiveName of EXPECTED_DESTRUCTIVE_TOOL_NAMES) {
        expect(names).not.toContain(destructiveName);
      }
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("adds exactly the three destructive tools over an in-memory transport when allowDestructive is true", async () => {
    const { client, mcpServer } = await connectClient({ allowDestructive: true });
    try {
      const { tools } = await client.listTools();
      const names = (tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOL_NAMES, ...EXPECTED_DESTRUCTIVE_TOOL_NAMES].sort());
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("dispatches fn_task_create to the shared TaskStore.createTask operation", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({ name: "fn_task_create", arguments: { description: "MCP-created task" } });
      expect(result.isError).not.toBe(true);
      const tasks = await store.listTasks({ slim: true });
      expect(tasks.some((t) => t.description === "MCP-created task")).toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("dispatches fn_task_list and reflects tasks created via the shared store", async () => {
    await store.createTask({ description: "Pre-seeded task", source: { sourceType: "api" } });
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({ name: "fn_task_list", arguments: {} });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toContain("Pre-seeded task");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("dispatches fn_task_search against TaskStore.searchTasks", async () => {
    await store.createTask({ description: "Findable via search unique-token-xyz", source: { sourceType: "api" } });
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({ name: "fn_task_search", arguments: { query: "unique-token-xyz" } });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toContain("unique-token-xyz");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("dispatches fn_agent_create/fn_list_agents/fn_agent_stop/fn_agent_start against the shared AgentStore", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const createResult = await client.callTool({
        name: "fn_agent_create",
        arguments: { name: "MCP Test Agent", role: "executor" },
      });
      expect(createResult.isError).not.toBe(true);

      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const agents = await agentStore.listAgents({});
      const created = agents.find((a) => a.name === "MCP Test Agent");
      expect(created).toBeTruthy();

      const listResult = await client.callTool({ name: "fn_list_agents", arguments: {} });
      expect(listResult.isError).not.toBe(true);
      const listText = (listResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(listText).toContain("MCP Test Agent");

      const stopResult = await client.callTool({ name: "fn_agent_stop", arguments: { id: created!.id } });
      expect(stopResult.isError).not.toBe(true);
      const stopped = await agentStore.getAgent(created!.id);
      expect(stopped?.state).toBe("paused");

      const startResult = await client.callTool({ name: "fn_agent_start", arguments: { id: created!.id } });
      expect(startResult.isError).not.toBe(true);
      const started = await agentStore.getAgent(created!.id);
      expect(started?.state).toBe("active");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("dispatches fn_workflow_list through the same @fusion/engine authoring tools the pi extension uses", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({ name: "fn_workflow_list", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("never surfaces a raw secret-shaped value in a tool result", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({
        name: "fn_agent_create",
        arguments: { name: "Secret Probe Agent", role: "executor", instructions_text: "irrelevant" },
      });
      const serialized = JSON.stringify(result);
      // No literal-looking secret markers should ever appear in a response.
      expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
      expect(serialized).not.toMatch(/ghp_[a-zA-Z0-9]{10,}/);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("does not expose fn_task_delete/fn_agent_delete/fn_workflow_delete for a call when allowDestructive is omitted", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      for (const name of EXPECTED_DESTRUCTIVE_TOOL_NAMES) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toMatch(/not found/i);
      }
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  describe("destructive tier dispatch (allowDestructive: true)", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it("fn_task_delete dispatches to store.deleteTask and audits to stderr, never stdout", async () => {
      const task = await store.createTask({ description: "Delete me via MCP", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_task_delete", arguments: { id: task.id } });
        expect(result.isError).not.toBe(true);
        await expect(store.getTask(task.id)).rejects.toThrow();

        expect(stderrSpy).toHaveBeenCalled();
        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_task_delete"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain(task.id);
        expect(auditLine).toContain("deleted");
        expect(stdoutSpy.mock.calls.some((c) => String(c[0]).includes("fn_task_delete"))).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_delete surfaces a not-found error for a missing task id without throwing across the wire", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_task_delete", arguments: { id: "FN-DOES-NOT-EXIST" } });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_workflow_delete deletes a custom workflow via the shared store operation and audits to stderr", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const createResult = await client.callTool({
          name: "fn_workflow_create",
          arguments: { name: "Deletable Custom Workflow", ir: workflowIr("Deletable Custom Workflow") },
        });
        expect(createResult.isError).not.toBe(true);
        const workflowId = (createResult.structuredContent as { workflowId?: string } | undefined)?.workflowId
          ?? JSON.parse(JSON.stringify((createResult as { structuredContent?: unknown }).structuredContent ?? {})).workflowId;
        expect(typeof workflowId).toBe("string");

        const deleteResult = await client.callTool({ name: "fn_workflow_delete", arguments: { workflow_id: workflowId } });
        expect(deleteResult.isError).not.toBe(true);

        const remaining = await store.listWorkflowDefinitions();
        expect(remaining.some((w) => w.id === workflowId)).toBe(false);

        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_workflow_delete"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain("deleted");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_workflow_delete rejects deleting a protected built-in workflow and does not delete it", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_workflow_delete", arguments: { workflow_id: "builtin:coding" } });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toMatch(/built-?in/i);

        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_workflow_delete"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain("error");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_agent_delete dispatches to AgentStore.deleteAgent (allow branch) and audits to stderr", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
        await agentStore.init();
        const created = await agentStore.createAgent({ name: "Agent To Delete", role: "executor" });

        const result = await client.callTool({ name: "fn_agent_delete", arguments: { agent_id: created.id } });
        expect(result.isError).not.toBe(true);

        const afterDelete = await agentStore.getAgent(created.id);
        expect(afterDelete).toBeNull();

        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_agent_delete"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain(created.id);
        expect(auditLine).toContain("deleted");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_agent_delete honors a require-approval policy decision without deleting the agent", async () => {
      vi.resetModules();
      vi.doMock("@fusion/core", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@fusion/core")>();
        return {
          ...actual,
          resolveAgentProvisioningPolicy: vi.fn().mockReturnValue({
            decision: "require-approval",
            reason: "test forced require-approval",
            matchedRule: "approval-mode-always",
            effectiveMode: "always",
          }),
        };
      });
      const { buildMcpServer: mockedBuildMcpServer } = await import("../server.js");

      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const created = await agentStore.createAgent({ name: "Approval Gated Agent", role: "executor" });

      const mcpServer = mockedBuildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: true });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
      try {
        const result = await client.callTool({ name: "fn_agent_delete", arguments: { agent_id: created.id } });
        expect(result.isError).not.toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toMatch(/approval required/i);

        const stillThere = await agentStore.getAgent(created.id);
        expect(stillThere).toBeTruthy();

        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_agent_delete"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain("pending_approval");
      } finally {
        await client.close();
        await mcpServer.close();
        vi.doUnmock("@fusion/core");
        vi.resetModules();
      }
    });

    it("fn_agent_delete honors a deny policy decision without deleting the agent", async () => {
      vi.resetModules();
      vi.doMock("@fusion/core", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@fusion/core")>();
        return {
          ...actual,
          resolveAgentProvisioningPolicy: vi.fn().mockReturnValue({
            decision: "deny",
            reason: "test forced deny",
            matchedRule: "approval-mode-never",
            effectiveMode: "never",
          }),
        };
      });
      const { buildMcpServer: mockedBuildMcpServer } = await import("../server.js");

      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const created = await agentStore.createAgent({ name: "Denied Delete Agent", role: "executor" });

      const mcpServer = mockedBuildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: true });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
      try {
        const result = await client.callTool({ name: "fn_agent_delete", arguments: { agent_id: created.id } });
        expect(result.isError).not.toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toMatch(/denied/i);

        const stillThere = await agentStore.getAgent(created.id);
        expect(stillThere).toBeTruthy();

        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_agent_delete"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain("denied");
      } finally {
        await client.close();
        await mcpServer.close();
        vi.doUnmock("@fusion/core");
        vi.resetModules();
      }
    });
  });
});
