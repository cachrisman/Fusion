/**
 * FNXC:McpServer 2026-07-10-21:00:
 * Registry + smoke coverage for the Fusion operator MCP server. Uses a real
 * TaskStore/AgentStore rooted at a temp project dir (mirrors
 * packages/cli/src/__tests__/extension-workflow-tools.test.ts) instead of a
 * deep @fusion/core mock, and connects the server through the SDK's
 * InMemoryTransport pair so the test never spawns a subprocess or touches
 * stdio/network (fast, matches the "Do Not Add Slow Tests" standing rule).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, AgentStore } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_REGISTRY, redactSecretsDeep } from "../tools.js";
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

const FORBIDDEN_NAME_PATTERNS = [/release/i, /publish/i, /version[-_]?tag/i, /changeset/i, /_delete$/i, /delete_/i];

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

  it("never declares a release/publish/version-tag/changeset or *_delete tool", () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        expect(pattern.test(tool.name), `${tool.name} matched forbidden pattern ${pattern}`).toBe(false);
      }
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

  async function connectClient() {
    const mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
    return { client, mcpServer };
  }

  it("initializes and lists exactly the curated tool set over an in-memory transport", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = (tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        expect(names.some((name) => pattern.test(name))).toBe(false);
      }
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
});
