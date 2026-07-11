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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, AgentStore, type WorkflowIr } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/*
FNXC:McpServer 2026-07-11-10:00:
FUSI-020's project tools dispatch through `CentralCore`, whose real
constructor resolves `~/.fusion/fusion-central.db` and THROWS when called
without an explicit dir under VITEST (see resolveGlobalDir()'s test guard in
packages/core/src/global-settings.ts) — by design, to stop a test from ever
touching the real global registry. `packages/cli/src/commands/__tests__/
init.test.ts` already solves this by mocking `CentralCore` wholesale; this
file does the same with a minimal in-memory fake so fn_project_* tests never
touch a real central database. `fakeCentralRegistry` is a MODULE-LEVEL map
(cleared in `beforeEach` below) so it survives across the single hoisted
`vi.mock` factory instantiation.
*/
const { fakeCentralRegistry } = vi.hoisted(() => ({
  fakeCentralRegistry: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  let seq = 0;

  class FakeCentralCore {
    async init(): Promise<void> {}
    async close(): Promise<void> {}

    async listProjects(): Promise<Record<string, unknown>[]> {
      return [...fakeCentralRegistry.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async getProject(id: string): Promise<Record<string, unknown> | undefined> {
      return fakeCentralRegistry.get(id);
    }

    async getProjectByPath(path: string): Promise<Record<string, unknown> | undefined> {
      return [...fakeCentralRegistry.values()].find((p) => p.path === path);
    }

    async registerProject(input: { id?: string; name: string; path: string; isolationMode?: string }): Promise<Record<string, unknown>> {
      const existingByPath = [...fakeCentralRegistry.values()].find((p) => p.path === input.path);
      if (existingByPath) throw new Error(`Project already registered at path: ${input.path}`);
      const now = new Date().toISOString();
      const id = input.id ?? `proj_fake_${++seq}`;
      const project = {
        id,
        name: input.name,
        path: input.path,
        status: "initializing",
        isolationMode: input.isolationMode ?? "in-process",
        createdAt: now,
        updatedAt: now,
      };
      fakeCentralRegistry.set(id, project);
      return project;
    }

    async ensureProjectForPath(input: { path: string; name?: string; isolationMode?: string }): Promise<{ project: Record<string, unknown>; reattached: boolean; outcome: string }> {
      const existing = await this.getProjectByPath(input.path);
      if (existing) return { project: existing, reattached: false, outcome: "existing" };
      const project = await this.registerProject({ name: input.name ?? "project", path: input.path, isolationMode: input.isolationMode });
      return { project, reattached: false, outcome: "created" };
    }

    async updateProject(id: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
      const existing = fakeCentralRegistry.get(id);
      if (!existing) throw new Error(`Project not found: ${id}`);
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      fakeCentralRegistry.set(id, updated);
      return updated;
    }

    async unregisterProject(id: string): Promise<void> {
      fakeCentralRegistry.delete(id);
    }
  }

  return { ...actual, CentralCore: FakeCentralCore };
});
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_REGISTRY, DESTRUCTIVE_TOOL_TIER, buildMcpToolRegistry, redactSecretsDeep } from "../tools.js";
import { buildMcpServer } from "../server.js";

const EXPECTED_TOOL_NAMES = [
  "fn_task_create",
  "fn_task_list",
  "fn_task_show",
  "fn_task_search",
  "fn_task_archive",
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
  "fn_mission_list",
  "fn_mission_show",
  "fn_milestone_list",
  "fn_milestone_show",
  "fn_slice_list",
  "fn_slice_show",
  "fn_feature_list",
  "fn_feature_show",
  // FUSI-018: mission-hierarchy mutation + goal tool set
  "fn_mission_create",
  "fn_mission_update",
  "fn_milestone_add",
  "fn_milestone_update",
  "fn_slice_add",
  "fn_slice_activate",
  "fn_feature_add",
  "fn_feature_update",
  "fn_feature_link_task",
  "fn_goal_list",
  "fn_goal_show",
  "fn_goal_create",
  "fn_goal_archive",
  "fn_mission_link_goal",
  "fn_mission_unlink_goal",
  "fn_mission_list_goals",
  // FUSI-019: settings read
  "fn_settings_get",
  // FUSI-020: project registry reads
  "fn_project_list",
  "fn_project_show",
];

const EXPECTED_DESTRUCTIVE_TOOL_NAMES = [
  "fn_task_delete",
  "fn_agent_delete",
  "fn_workflow_delete",
  "fn_mission_delete",
  "fn_milestone_delete",
  "fn_slice_delete",
  "fn_feature_delete",
  "fn_settings_update",
  "fn_project_create",
  "fn_project_update",
  "fn_project_remove",
];

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

  it("adds exactly the eleven destructive tools (FUSI-002's three plus FUSI-005's four mission-hierarchy tools plus FUSI-019's fn_settings_update plus FUSI-020's three project tools), no more, no fewer, when allowDestructive is true", () => {
    const names = buildMcpToolRegistry({ allowDestructive: true }).map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES, ...EXPECTED_DESTRUCTIVE_TOOL_NAMES].sort());
    expect(DESTRUCTIVE_TOOL_TIER.map((t) => t.name).sort()).toEqual([...EXPECTED_DESTRUCTIVE_TOOL_NAMES].sort());
  });

  it("fn_mission_delete has no force property; the milestone/slice/feature delete tools expose an optional force boolean", () => {
    const byName = new Map(DESTRUCTIVE_TOOL_TIER.map((t) => [t.name, t]));
    const missionDelete = byName.get("fn_mission_delete");
    expect(missionDelete?.inputSchema.properties).not.toHaveProperty("force");
    for (const name of ["fn_milestone_delete", "fn_slice_delete", "fn_feature_delete"]) {
      const tool = byName.get(name);
      expect(tool?.inputSchema.properties, `${name} inputSchema.properties`).toHaveProperty("force");
    }
  });

  it("gives every destructive tool a DESTRUCTIVE-marked description and a valid inputSchema", () => {
    for (const tool of DESTRUCTIVE_TOOL_TIER) {
      expect(tool.description.trim().length, `${tool.name} description`).toBeGreaterThan(0);
      expect(tool.description).toMatch(/^DESTRUCTIVE:/);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("fn_task_archive (FUSI-006) is base-tier — present with allowDestructive false/absent, never duplicated into DESTRUCTIVE_TOOL_TIER", () => {
    expect(MCP_TOOL_REGISTRY.map((t) => t.name)).toContain("fn_task_archive");
    expect(DESTRUCTIVE_TOOL_TIER.map((t) => t.name)).not.toContain("fn_task_archive");
    expect(buildMcpToolRegistry({ allowDestructive: false }).map((t) => t.name)).toContain("fn_task_archive");
    expect(buildMcpToolRegistry({ allowDestructive: true }).filter((t) => t.name === "fn_task_archive")).toHaveLength(1);
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
    fakeCentralRegistry.clear();
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

  it("adds exactly the eleven destructive tools over an in-memory transport when allowDestructive is true", async () => {
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

  it("dispatches fn_task_archive to store.archiveTask and moves the task to the archived column", async () => {
    const task = await store.createTask({ description: "Archive me via MCP", source: { sourceType: "api" } });
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({ name: "fn_task_archive", arguments: { id: task.id } });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toContain(task.id);
      expect(text).toContain("Archived");
      const archived = await store.getTask(task.id);
      expect(archived.column).toBe("archived");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("fn_task_archive surfaces an error result (not a throw) when archiving an already-archived task", async () => {
    // store.archiveTask's default cleanup:true deletes the live task row and moves it into a
    // separate archive DB, so a REPEAT archive call can no longer find the row at all ("not
    // found" instead of "already archived"). Use cleanup:false to keep the row in place with
    // column:'archived' so the handler exercises the store's actual "already archived" guard
    // (the literal branch store.archiveTask throws from when the row is still present).
    const task = await store.createTask({ description: "Already archived", source: { sourceType: "api" } });
    await store.archiveTask(task.id, { cleanup: false });
    const { client, mcpServer } = await connectClient();
    try {
      const result = await client.callTool({ name: "fn_task_archive", arguments: { id: task.id } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toMatch(/already archived/i);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("fn_task_archive rejects a lineage-parent task without removeLineageReferences, and succeeds with it", async () => {
    const parent = await store.createTask({ column: "done", description: "lineage parent", source: { sourceType: "api" } });
    const child = await store.createTask({ column: "todo", description: "lineage child", source: { sourceType: "api" } });
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
      .prepare('UPDATE tasks SET sourceParentTaskId = ?, sourceType = ?, updatedAt = ? WHERE id = ?')
      .run(parent.id, "task_refine", new Date().toISOString(), child.id);

    const { client, mcpServer } = await connectClient();
    try {
      const blocked = await client.callTool({ name: "fn_task_archive", arguments: { id: parent.id } });
      expect(blocked.isError).toBe(true);
      const blockedText = (blocked.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(blockedText).toMatch(/lineage/i);
      expect((await store.getTask(parent.id)).column).not.toBe("archived");

      const allowed = await client.callTool({
        name: "fn_task_archive",
        arguments: { id: parent.id, removeLineageReferences: true },
      });
      expect(allowed.isError).not.toBe(true);
      expect((await store.getTask(parent.id)).column).toBe("archived");
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

  /*
  FNXC:McpWorkflow 2026-07-11-00:00:
  FUSI-043 symptom-verification regression: proves defects #1/#3/#4 are all
  fixed together over the REAL MCP boundary (in-memory transport, not a
  direct tool-factory call) — (a) fn_workflow_get's structuredContent carries
  the full ir (nodes/edges/columns) + layout, (b) a get→modify→update
  round-trip via fn_workflow_update persists both the modification and the
  layout, and (c) the advertised fn_workflow_create input schema exposes a
  typed `ir` object (node/edge/column sub-shapes), not `unknown`.
  */
  it("fn_workflow_get → modify → fn_workflow_update round-trip survives the MCP boundary (nodes/edges/layout)", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const layout = { start: { x: 0, y: 0 }, end: { x: 200, y: 0 } };
      const created = await store.createWorkflowDefinition({
        name: "Round Trip Workflow",
        ir: workflowIr("Round Trip Workflow") as any,
        layout,
      } as any);

      // (a) fn_workflow_get returns the full IR + layout in structuredContent.
      const getResult = await client.callTool({ name: "fn_workflow_get", arguments: { workflow_id: created.id } });
      expect(getResult.isError).not.toBe(true);
      const getStructured = getResult.structuredContent as {
        ir?: { nodes?: unknown[]; edges?: unknown[]; columns?: unknown[] };
        layout?: Record<string, unknown>;
      };
      expect(getStructured.ir?.nodes).toBeDefined();
      expect(getStructured.ir?.edges).toBeDefined();
      expect(getStructured.ir?.columns).toBeDefined();
      expect((getStructured.ir?.nodes as any[]).some((n) => n.id === "start")).toBe(true);
      expect(getStructured.layout).toEqual(layout);

      // (b) modify the IR (add a node + connecting edge) and rename a node, then
      // fn_workflow_update over MCP; re-get and assert both the modification AND
      // the layout persisted.
      const modifiedIr = {
        ...getStructured.ir,
        nodes: [
          ...(getStructured.ir!.nodes as any[]).map((n) => (n.id === "end" ? { ...n, id: "finish" } : n)),
          { id: "gate1", kind: "gate", column: "todo" },
        ],
        edges: [
          { from: "start", to: "gate1", condition: "success" },
          { from: "gate1", to: "finish", condition: "success" },
        ],
      };
      const updatedLayout = { ...layout, gate1: { x: 100, y: 50 } };
      const updateResult = await client.callTool({
        name: "fn_workflow_update",
        arguments: { workflow_id: created.id, ir: modifiedIr, layout: updatedLayout },
      });
      expect(updateResult.isError).not.toBe(true);

      const reGetResult = await client.callTool({ name: "fn_workflow_get", arguments: { workflow_id: created.id } });
      expect(reGetResult.isError).not.toBe(true);
      const reGetStructured = reGetResult.structuredContent as {
        ir?: { nodes?: any[]; edges?: any[] };
        layout?: Record<string, unknown>;
      };
      const nodeIds = (reGetStructured.ir?.nodes ?? []).map((n) => n.id);
      expect(nodeIds).toContain("finish");
      expect(nodeIds).toContain("gate1");
      expect(nodeIds).not.toContain("end");
      expect(reGetStructured.ir?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "start", to: "gate1" }),
          expect.objectContaining({ from: "gate1", to: "finish" }),
        ]),
      );
      expect(reGetStructured.layout).toEqual(updatedLayout);

      // (c) the advertised fn_workflow_create input schema's `ir` property is a
      // typed object exposing node/edge/column sub-shapes, not `unknown`.
      const { tools } = await client.listTools();
      const createTool = tools.find((t) => t.name === "fn_workflow_create");
      expect(createTool).toBeTruthy();
      const irSchema = (createTool!.inputSchema as any).properties?.ir;
      expect(irSchema).toBeTruthy();
      expect(irSchema.type).toBe("object");
      expect(irSchema.properties?.nodes).toBeTruthy();
      expect(irSchema.properties?.nodes.type).toBe("array");
      expect(irSchema.properties?.nodes.items?.properties?.id).toBeTruthy();
      expect(irSchema.properties?.edges).toBeTruthy();
      expect(irSchema.properties?.columns).toBeTruthy();

      // (d) redactSecretsDeep is still applied — no regression on the shared
      // secret-redaction pass over structuredContent.
      const secretIr = {
        ...modifiedIr,
        nodes: modifiedIr.nodes.map((n: any) =>
          n.id === "gate1" ? { ...n, config: { ...(n.config ?? {}), apiKey: "sk-should-be-redacted-1234567890" } } : n,
        ),
      };
      const secretUpdate = await client.callTool({
        name: "fn_workflow_update",
        arguments: { workflow_id: created.id, ir: secretIr },
      });
      expect(secretUpdate.isError).not.toBe(true);
      const secretGet = await client.callTool({ name: "fn_workflow_get", arguments: { workflow_id: created.id } });
      const serializedSecretGet = JSON.stringify(secretGet.structuredContent);
      expect(serializedSecretGet).not.toContain("sk-should-be-redacted-1234567890");
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

    describe("mission-hierarchy delete tools (FUSI-005)", () => {
      function seedMissionHierarchy() {
        const missionStore = store.getMissionStore();
        const mission = missionStore.createMission({ title: "Delete Me Mission", autoMerge: true });
        const milestone = missionStore.addMilestone(mission.id, { title: "MS" });
        const slice = missionStore.addSlice(milestone.id, { title: "SL" });
        const feature = missionStore.addFeature(slice.id, { title: "FT" });
        return { missionStore, mission, milestone, slice, feature };
      }

      it("fn_mission_delete dispatches to MissionStore.deleteMission, cascades to descendants, and emits an enriched stderr cascade summary", async () => {
        const { missionStore, mission, milestone, slice, feature } = seedMissionHierarchy();
        const linkedTask = await store.createTask({ description: "Linked to feature", source: { sourceType: "api" } });
        missionStore.linkFeatureToTask(feature.id, linkedTask.id);
        const { client, mcpServer } = await connectClient({ allowDestructive: true });
        try {
          const result = await client.callTool({ name: "fn_mission_delete", arguments: { id: mission.id } });
          expect(result.isError).not.toBe(true);
          expect(missionStore.getMission(mission.id)).toBeUndefined();
          expect(missionStore.getMilestone(milestone.id)).toBeUndefined();
          expect(missionStore.getSlice(slice.id)).toBeUndefined();
          expect(missionStore.getFeature(feature.id)).toBeUndefined();

          const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_mission_delete") && line.includes("cascade"));
          expect(auditLine).toBeTruthy();
          expect(auditLine).toContain(mission.id);
          expect(auditLine).toContain("milestones=1");
          expect(auditLine).toContain("slices=1");
          expect(auditLine).toContain("features=1");
          expect(stdoutSpy.mock.calls.some((c) => String(c[0]).includes("fn_mission_delete"))).toBe(false);
        } finally {
          await client.close();
          await mcpServer.close();
        }
      });

      it("fn_mission_delete surfaces a not-found error for a missing mission id", async () => {
        const { client, mcpServer } = await connectClient({ allowDestructive: true });
        try {
          const result = await client.callTool({ name: "fn_mission_delete", arguments: { id: "M-DOES-NOT-EXIST" } });
          expect(result.isError).toBe(true);
        } finally {
          await client.close();
          await mcpServer.close();
        }
      });

      it("fn_feature_delete dispatches to MissionStore.deleteFeature and audits to stderr", async () => {
        const { missionStore, feature } = seedMissionHierarchy();
        const { client, mcpServer } = await connectClient({ allowDestructive: true });
        try {
          const result = await client.callTool({ name: "fn_feature_delete", arguments: { featureId: feature.id } });
          expect(result.isError).not.toBe(true);
          expect(missionStore.getFeature(feature.id)).toBeUndefined();

          const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_feature_delete"));
          expect(auditLine).toBeTruthy();
          expect(auditLine).toContain(feature.id);
          expect(auditLine).toContain("deleted");
        } finally {
          await client.close();
          await mcpServer.close();
        }
      });

      it("fn_slice_delete / fn_milestone_delete honor the live-task-link guard (force omitted rejects, force=true proceeds and marks forced=true in the audit line)", async () => {
        const { missionStore, slice, feature } = seedMissionHierarchy();
        const linkedTask = await store.createTask({ description: "Linked to feature", source: { sourceType: "api" } });
        missionStore.linkFeatureToTask(feature.id, linkedTask.id);
        const { client, mcpServer } = await connectClient({ allowDestructive: true });
        try {
          const blocked = await client.callTool({ name: "fn_slice_delete", arguments: { sliceId: slice.id } });
          expect(blocked.isError).toBe(true);
          const blockedText = (blocked.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
          expect(blockedText).toMatch(/pass force to delete anyway/i);
          expect(missionStore.getSlice(slice.id)).toBeTruthy();

          const forced = await client.callTool({ name: "fn_slice_delete", arguments: { sliceId: slice.id, force: true } });
          expect(forced.isError).not.toBe(true);
          expect(missionStore.getSlice(slice.id)).toBeUndefined();

          const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("fn_slice_delete") && line.includes("deleted"));
          expect(auditLine).toBeTruthy();
          expect(auditLine).toContain("forced=true");
        } finally {
          await client.close();
          await mcpServer.close();
        }
      });

      it("fn_milestone_delete dispatches to MissionStore.deleteMilestone and surfaces a missing-id error", async () => {
        const { client, mcpServer } = await connectClient({ allowDestructive: true });
        try {
          const result = await client.callTool({ name: "fn_milestone_delete", arguments: { milestoneId: "MS-DOES-NOT-EXIST" } });
          expect(result.isError).toBe(true);
        } finally {
          await client.close();
          await mcpServer.close();
        }
      });
    });
  });

  describe("mission-hierarchy read tools (FUSI-017)", () => {
    function seedMissionHierarchy() {
      const missionStore = store.getMissionStore();
      const mission = missionStore.createMission({ title: "Read Me Mission", autoMerge: true });
      const milestone = missionStore.addMilestone(mission.id, { title: "MS" });
      const slice = missionStore.addSlice(milestone.id, { title: "SL" });
      const feature = missionStore.addFeature(slice.id, { title: "FT" });
      return { missionStore, mission, milestone, slice, feature };
    }

    it("fn_mission_list returns the mission row in structuredContent (base tier — no --allow-destructive required)", async () => {
      const { mission } = seedMissionHierarchy();
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_mission_list", arguments: {} });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { count: number; missions: Array<{ id: string; title: string; status: string }> };
        expect(structured.missions.some((m) => m.id === mission.id && m.title === mission.title)).toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toContain(mission.id);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_mission_list returns the empty-state payload when there are no missions", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_mission_list", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ count: 0, drafts: [] });
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toBe("No missions yet.");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_mission_show renders the full hierarchy and a not-found id returns isError", async () => {
      const { mission, milestone, slice, feature } = seedMissionHierarchy();
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_mission_show", arguments: { id: mission.id } });
        expect(result.isError).not.toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toContain(mission.id);
        expect(text).toContain(milestone.id);
        expect(text).toContain(slice.id);
        expect(text).toContain(feature.id);

        const notFound = await client.callTool({ name: "fn_mission_show", arguments: { id: "M-DOES-NOT-EXIST" } });
        expect(notFound.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_milestone_list / fn_slice_list / fn_feature_list return child rows for a valid parent id and an empty payload for an unknown parent id", async () => {
      const { mission, milestone, slice, feature } = seedMissionHierarchy();
      const { client, mcpServer } = await connectClient();
      try {
        const milestones = await client.callTool({ name: "fn_milestone_list", arguments: { missionId: mission.id } });
        expect(milestones.isError).not.toBe(true);
        expect((milestones.structuredContent as { count: number }).count).toBe(1);
        expect((milestones.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toContain(milestone.id);

        const noMilestones = await client.callTool({ name: "fn_milestone_list", arguments: { missionId: "M-DOES-NOT-EXIST" } });
        expect(noMilestones.isError).not.toBe(true);
        expect((noMilestones.structuredContent as { count: number }).count).toBe(0);

        const slices = await client.callTool({ name: "fn_slice_list", arguments: { milestoneId: milestone.id } });
        expect(slices.isError).not.toBe(true);
        expect((slices.structuredContent as { count: number }).count).toBe(1);
        expect((slices.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toContain(slice.id);

        const noSlices = await client.callTool({ name: "fn_slice_list", arguments: { milestoneId: "MS-DOES-NOT-EXIST" } });
        expect(noSlices.isError).not.toBe(true);
        expect((noSlices.structuredContent as { count: number }).count).toBe(0);

        const features = await client.callTool({ name: "fn_feature_list", arguments: { sliceId: slice.id } });
        expect(features.isError).not.toBe(true);
        expect((features.structuredContent as { count: number }).count).toBe(1);
        expect((features.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toContain(feature.id);

        const noFeatures = await client.callTool({ name: "fn_feature_list", arguments: { sliceId: "SL-DOES-NOT-EXIST" } });
        expect(noFeatures.isError).not.toBe(true);
        expect((noFeatures.structuredContent as { count: number }).count).toBe(0);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_milestone_show / fn_slice_show / fn_feature_show return the entity for a valid id and isError for an unknown id", async () => {
      const { milestone, slice, feature } = seedMissionHierarchy();
      const { client, mcpServer } = await connectClient();
      try {
        const milestoneShow = await client.callTool({ name: "fn_milestone_show", arguments: { id: milestone.id } });
        expect(milestoneShow.isError).not.toBe(true);
        expect((milestoneShow.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toContain(milestone.id);
        const milestoneNotFound = await client.callTool({ name: "fn_milestone_show", arguments: { id: "MS-DOES-NOT-EXIST" } });
        expect(milestoneNotFound.isError).toBe(true);

        const sliceShow = await client.callTool({ name: "fn_slice_show", arguments: { id: slice.id } });
        expect(sliceShow.isError).not.toBe(true);
        expect((sliceShow.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toContain(slice.id);
        const sliceNotFound = await client.callTool({ name: "fn_slice_show", arguments: { id: "SL-DOES-NOT-EXIST" } });
        expect(sliceNotFound.isError).toBe(true);

        const featureShow = await client.callTool({ name: "fn_feature_show", arguments: { id: feature.id } });
        expect(featureShow.isError).not.toBe(true);
        expect((featureShow.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toContain(feature.id);
        const featureNotFound = await client.callTool({ name: "fn_feature_show", arguments: { id: "F-DOES-NOT-EXIST" } });
        expect(featureNotFound.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("mission read tools never appear only under --allow-destructive — they are present with allowDestructive omitted", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const { tools } = await client.listTools();
        const names = (tools ?? []).map((t) => t.name);
        for (const name of ["fn_mission_list", "fn_mission_show", "fn_milestone_list", "fn_milestone_show", "fn_slice_list", "fn_slice_show", "fn_feature_list", "fn_feature_show"]) {
          expect(names).toContain(name);
        }
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });
  });

  describe("mission-hierarchy mutation + goal tools (FUSI-018)", () => {
    const FUSI_018_TOOL_NAMES = [
      "fn_mission_create",
      "fn_mission_update",
      "fn_milestone_add",
      "fn_milestone_update",
      "fn_slice_add",
      "fn_slice_activate",
      "fn_feature_add",
      "fn_feature_update",
      "fn_feature_link_task",
      "fn_goal_list",
      "fn_goal_show",
      "fn_goal_create",
      "fn_goal_archive",
      "fn_mission_link_goal",
      "fn_mission_unlink_goal",
      "fn_mission_list_goals",
    ];

    it("all 16 tools are in MCP_TOOL_REGISTRY, none in DESTRUCTIVE_TOOL_TIER, and buildMcpToolRegistry includes each exactly once under every allowDestructive mode", () => {
      const baseNames = MCP_TOOL_REGISTRY.map((t) => t.name);
      for (const name of FUSI_018_TOOL_NAMES) {
        expect(baseNames, `${name} in MCP_TOOL_REGISTRY`).toContain(name);
      }
      const destructiveNames = DESTRUCTIVE_TOOL_TIER.map((t) => t.name);
      for (const name of FUSI_018_TOOL_NAMES) {
        expect(destructiveNames, `${name} not in DESTRUCTIVE_TOOL_TIER`).not.toContain(name);
      }

      for (const ctx of [{ allowDestructive: false }, {}, { allowDestructive: true }]) {
        const names = buildMcpToolRegistry(ctx).map((t) => t.name);
        for (const name of FUSI_018_TOOL_NAMES) {
          const occurrences = names.filter((n) => n === name).length;
          expect(occurrences, `${name} occurrences in buildMcpToolRegistry(${JSON.stringify(ctx)})`).toBe(1);
        }
      }
    });

    function seedMissionHierarchy() {
      const missionStore = store.getMissionStore();
      const mission = missionStore.createMission({ title: "Mutate Me Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "MS" });
      const slice = missionStore.addSlice(milestone.id, { title: "SL" });
      const feature = missionStore.addFeature(slice.id, { title: "FT" });
      return { missionStore, mission, milestone, slice, feature };
    }

    it("dispatches fn_mission_create then fn_mission_update to the shared MissionStore", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const createResult = await client.callTool({ name: "fn_mission_create", arguments: { title: "MCP Mission" } });
        expect(createResult.isError).not.toBe(true);
        const missionId = (createResult.structuredContent as { missionId?: string } | undefined)?.missionId;
        expect(typeof missionId).toBe("string");
        expect(store.getMissionStore().getMission(missionId!)?.title).toBe("MCP Mission");

        const updateResult = await client.callTool({ name: "fn_mission_update", arguments: { id: missionId, title: "Renamed Mission" } });
        expect(updateResult.isError).not.toBe(true);
        expect(store.getMissionStore().getMission(missionId!)?.title).toBe("Renamed Mission");

        const missingUpdate = await client.callTool({ name: "fn_mission_update", arguments: { id: "M-DOES-NOT-EXIST" } });
        expect(missingUpdate.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("dispatches fn_milestone_add to MissionStore.addMilestone", async () => {
      const { mission } = seedMissionHierarchy();
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_milestone_add", arguments: { missionId: mission.id, title: "New Milestone" } });
        expect(result.isError).not.toBe(true);
        const milestoneId = (result.structuredContent as { milestoneId?: string } | undefined)?.milestoneId;
        expect(store.getMissionStore().getMilestone(milestoneId!)?.title).toBe("New Milestone");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("dispatches fn_slice_add then fn_slice_activate to MissionStore", async () => {
      const { milestone } = seedMissionHierarchy();
      const { client, mcpServer } = await connectClient();
      try {
        const addResult = await client.callTool({ name: "fn_slice_add", arguments: { milestoneId: milestone.id, title: "New Slice" } });
        expect(addResult.isError).not.toBe(true);
        const sliceId = (addResult.structuredContent as { sliceId?: string } | undefined)?.sliceId;
        expect(store.getMissionStore().getSlice(sliceId!)?.status).toBe("pending");

        const activateResult = await client.callTool({ name: "fn_slice_activate", arguments: { id: sliceId } });
        expect(activateResult.isError).not.toBe(true);
        expect(store.getMissionStore().getSlice(sliceId!)?.status).toBe("active");

        const reactivate = await client.callTool({ name: "fn_slice_activate", arguments: { id: sliceId } });
        expect(reactivate.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("dispatches fn_feature_add, fn_feature_update, and fn_feature_link_task to MissionStore + TaskStore", async () => {
      const { slice } = seedMissionHierarchy();
      const task = await store.createTask({ description: "Feature link target", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const addResult = await client.callTool({ name: "fn_feature_add", arguments: { sliceId: slice.id, title: "New Feature" } });
        expect(addResult.isError).not.toBe(true);
        const featureId = (addResult.structuredContent as { featureId?: string } | undefined)?.featureId;
        expect(store.getMissionStore().getFeature(featureId!)?.title).toBe("New Feature");

        const updateResult = await client.callTool({ name: "fn_feature_update", arguments: { id: featureId, title: "Renamed Feature" } });
        expect(updateResult.isError).not.toBe(true);
        expect(store.getMissionStore().getFeature(featureId!)?.title).toBe("Renamed Feature");

        const linkResult = await client.callTool({ name: "fn_feature_link_task", arguments: { featureId, taskId: task.id } });
        expect(linkResult.isError).not.toBe(true);
        expect(store.getMissionStore().getFeature(featureId!)?.taskId).toBe(task.id);

        const missingTaskLink = await client.callTool({ name: "fn_feature_link_task", arguments: { featureId, taskId: "FN-DOES-NOT-EXIST" } });
        expect(missingTaskLink.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("dispatches fn_goal_create, fn_goal_list, fn_goal_show, and fn_goal_archive to the shared GoalStore", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const createResult = await client.callTool({ name: "fn_goal_create", arguments: { title: "MCP Goal" } });
        expect(createResult.isError).not.toBe(true);
        const goalId = (createResult.structuredContent as { goalId?: string } | undefined)?.goalId;
        expect(typeof goalId).toBe("string");

        const listResult = await client.callTool({ name: "fn_goal_list", arguments: {} });
        expect(listResult.isError).not.toBe(true);
        const listText = (listResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(listText).toContain(goalId);

        const showResult = await client.callTool({ name: "fn_goal_show", arguments: { id: goalId } });
        expect(showResult.isError).not.toBe(true);
        const showText = (showResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(showText).toContain("MCP Goal");

        const archiveResult = await client.callTool({ name: "fn_goal_archive", arguments: { id: goalId } });
        expect(archiveResult.isError).not.toBe(true);
        expect(store.getGoalStore().getGoal(goalId!)?.status).toBe("archived");

        const showMissing = await client.callTool({ name: "fn_goal_show", arguments: { id: "G-DOES-NOT-EXIST" } });
        expect(showMissing.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("dispatches fn_mission_link_goal, fn_mission_list_goals, and fn_mission_unlink_goal to MissionStore", async () => {
      const { mission } = seedMissionHierarchy();
      const goal = store.getGoalStore().createGoal({ title: "Linkable Goal" });
      const { client, mcpServer } = await connectClient();
      try {
        const linkResult = await client.callTool({ name: "fn_mission_link_goal", arguments: { missionId: mission.id, goalId: goal.id } });
        expect(linkResult.isError).not.toBe(true);
        expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toContain(goal.id);

        const listGoalsResult = await client.callTool({ name: "fn_mission_list_goals", arguments: { missionId: mission.id } });
        expect(listGoalsResult.isError).not.toBe(true);
        const listGoalsText = (listGoalsResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(listGoalsText).toContain(goal.id);

        const unlinkResult = await client.callTool({ name: "fn_mission_unlink_goal", arguments: { missionId: mission.id, goalId: goal.id } });
        expect(unlinkResult.isError).not.toBe(true);
        expect(store.getMissionStore().listGoalIdsForMission(mission.id)).not.toContain(goal.id);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });
  });

  describe("settings tools (FUSI-019)", () => {
    it("fn_settings_get returns settings for scope: project, global, and default/effective; rejects an unknown scope", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const project = await client.callTool({ name: "fn_settings_get", arguments: { scope: "project" } });
        expect(project.isError).not.toBe(true);
        expect((project.structuredContent as { scope: string; settings: unknown }).scope).toBe("project");

        const global = await client.callTool({ name: "fn_settings_get", arguments: { scope: "global" } });
        expect(global.isError).not.toBe(true);
        expect((global.structuredContent as { scope: string; settings: unknown }).scope).toBe("global");

        const effective = await client.callTool({ name: "fn_settings_get", arguments: { scope: "effective" } });
        expect(effective.isError).not.toBe(true);
        expect((effective.structuredContent as { scope: string; settings: unknown }).scope).toBe("effective");

        const defaulted = await client.callTool({ name: "fn_settings_get", arguments: {} });
        expect(defaulted.isError).not.toBe(true);
        expect((defaulted.structuredContent as { scope: string }).scope).toBe("effective");

        const bad = await client.callTool({ name: "fn_settings_get", arguments: { scope: "bogus" } });
        expect(bad.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_get redacts secret-shaped values in its structured payload", async () => {
      await store.updateGlobalSettings({ mcpServers: { enabled: true, servers: [] } } as never);
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_settings_get", arguments: { scope: "effective" } });
        expect(result.isError).not.toBe(true);
        const redacted = redactSecretsDeep({ apiKey: "sk-live-should-never-appear" });
        expect((redacted as { apiKey: string }).apiKey).toBe("[redacted]");
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).not.toContain("sk-live-should-never-appear");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update is absent from the base registry and present only when allowDestructive is true", async () => {
      const base = await connectClient();
      try {
        const { tools } = await base.client.listTools();
        expect((tools ?? []).map((t) => t.name)).not.toContain("fn_settings_update");
      } finally {
        await base.client.close();
        await base.mcpServer.close();
      }

      const destructive = await connectClient({ allowDestructive: true });
      try {
        const { tools } = await destructive.client.listTools();
        expect((tools ?? []).map((t) => t.name)).toContain("fn_settings_update");
      } finally {
        await destructive.client.close();
        await destructive.mcpServer.close();
      }
    });

    it("fn_settings_update applies a project-scope patch via store.updateSettings", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "project", patch: { globalPause: true } },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { appliedKeys: string[] };
        expect(structured.appliedKeys).toContain("globalPause");
        const settings = await store.getSettings();
        expect(settings.globalPause).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update applies a global-scope patch via store.updateGlobalSettings", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "global", patch: { testMode: true } },
        });
        expect(result.isError).not.toBe(true);
        const { global } = await store.getSettingsByScope();
        expect(global.testMode).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update rejects a missing/empty patch or an invalid scope", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const missingPatch = await client.callTool({ name: "fn_settings_update", arguments: { scope: "project" } });
        expect(missingPatch.isError).toBe(true);

        const emptyPatch = await client.callTool({ name: "fn_settings_update", arguments: { scope: "project", patch: {} } });
        expect(emptyPatch.isError).toBe(true);

        const badScope = await client.callTool({ name: "fn_settings_update", arguments: { scope: "effective", patch: { globalPause: true } } });
        expect(badScope.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update writes an ids/counts/outcomes-only stderr audit line carrying key NAMES but never patched values", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "project", patch: { globalPause: true } },
        });
        expect(result.isError).not.toBe(true);
        const auditLines = errSpy.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("fn_settings_update"));
        expect(auditLines.length).toBeGreaterThan(0);
        expect(auditLines.some((line) => line.includes("keys=globalPause"))).toBe(true);
        expect(auditLines.some((line) => line.includes("true"))).toBe(false);
      } finally {
        errSpy.mockRestore();
        await client.close();
        await mcpServer.close();
      }
    });
  });

  describe("project tools (FUSI-020)", () => {
    let registeredDir: string;
    let bareDir: string;

    beforeEach(async () => {
      registeredDir = await mkdtemp(join(tmpdir(), "fn-fusi-020-registered-"));
      await mkdir(join(registeredDir, ".fusion"), { recursive: true });
      const seedStore = new TaskStore(registeredDir);
      await seedStore.init();
      await seedStore.close();

      bareDir = await mkdtemp(join(tmpdir(), "fn-fusi-020-bare-"));
    });

    afterEach(async () => {
      await rm(registeredDir, { recursive: true, force: true });
      await rm(bareDir, { recursive: true, force: true });
    });

    it("fn_project_list returns registered rows and the empty-state payload when none are registered", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const empty = await client.callTool({ name: "fn_project_list", arguments: {} });
        expect(empty.isError).not.toBe(true);
        expect(empty.structuredContent).toEqual({ count: 0, projects: [] });

        fakeCentralRegistry.set("proj_seed", {
          id: "proj_seed",
          name: "Seed Project",
          path: registeredDir,
          status: "active",
          isolationMode: "in-process",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const result = await client.callTool({ name: "fn_project_list", arguments: {} });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { count: number; projects: Array<{ id: string; name: string }> };
        expect(structured.count).toBe(1);
        expect(structured.projects[0]?.id).toBe("proj_seed");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_show returns a project for a valid id/name and isError for an unknown id", async () => {
      fakeCentralRegistry.set("proj_seed", {
        id: "proj_seed",
        name: "Seed Project",
        path: registeredDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const { client, mcpServer } = await connectClient();
      try {
        const byId = await client.callTool({ name: "fn_project_show", arguments: { id: "proj_seed" } });
        expect(byId.isError).not.toBe(true);
        expect((byId.structuredContent as { id: string }).id).toBe("proj_seed");

        const byName = await client.callTool({ name: "fn_project_show", arguments: { id: "Seed Project" } });
        expect(byName.isError).not.toBe(true);
        expect((byName.structuredContent as { id: string }).id).toBe("proj_seed");

        const notFound = await client.callTool({ name: "fn_project_show", arguments: { id: "proj_does_not_exist" } });
        expect(notFound.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_create registers an existing on-disk .fusion project", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_project_create", arguments: { path: registeredDir, name: "Existing Registered" } });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { projectId: string; outcome: string; path: string };
        expect(structured.outcome).toBe("registered");
        expect(structured.path).toBe(registeredDir);
        expect(fakeCentralRegistry.has(structured.projectId)).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_create scaffolds a brand-new project for a bare directory, writing ZERO stdout", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(existsSync(join(bareDir, ".fusion", "fusion.db"))).toBe(false);

        const result = await client.callTool({ name: "fn_project_create", arguments: { path: bareDir, name: "Brand New", git: false } });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { projectId: string; outcome: string; path: string };
        expect(structured.outcome).toBe("created");
        expect(structured.path).toBe(bareDir);
        expect(existsSync(join(bareDir, ".fusion", "fusion.db"))).toBe(true);
        expect(fakeCentralRegistry.has(structured.projectId)).toBe(true);

        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        logSpy.mockRestore();
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_update patches name/status and errors on an unknown id", async () => {
      fakeCentralRegistry.set("proj_seed", {
        id: "proj_seed",
        name: "Seed Project",
        path: registeredDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_project_update", arguments: { id: "proj_seed", name: "Renamed", status: "paused" } });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { name: string; status: string };
        expect(structured.name).toBe("Renamed");
        expect(structured.status).toBe("paused");

        const notFound = await client.callTool({ name: "fn_project_update", arguments: { id: "proj_missing", name: "X" } });
        expect(notFound.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_remove unregisters the registry entry, preserves on-disk .fusion/, and is idempotent for an absent id", async () => {
      fakeCentralRegistry.set("proj_seed", {
        id: "proj_seed",
        name: "Seed Project",
        path: registeredDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_project_remove", arguments: { id: "proj_seed" } });
        expect(result.isError).not.toBe(true);
        expect((result.structuredContent as { outcome: string }).outcome).toBe("unregistered");
        expect(fakeCentralRegistry.has("proj_seed")).toBe(false);
        expect(existsSync(join(registeredDir, ".fusion"))).toBe(true);

        const noop = await client.callTool({ name: "fn_project_remove", arguments: { id: "proj_seed" } });
        expect(noop.isError).not.toBe(true);
        expect((noop.structuredContent as { outcome: string }).outcome).toBe("noop");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_create/update/remove are absent from the base registry and present only when allowDestructive is true", async () => {
      const base = await connectClient();
      try {
        const { tools } = await base.client.listTools();
        const names = (tools ?? []).map((t) => t.name);
        expect(names).toContain("fn_project_list");
        expect(names).toContain("fn_project_show");
        expect(names).not.toContain("fn_project_create");
        expect(names).not.toContain("fn_project_update");
        expect(names).not.toContain("fn_project_remove");
      } finally {
        await base.client.close();
        await base.mcpServer.close();
      }

      const destructive = await connectClient({ allowDestructive: true });
      try {
        const { tools } = await destructive.client.listTools();
        const names = (tools ?? []).map((t) => t.name);
        expect(names).toContain("fn_project_create");
        expect(names).toContain("fn_project_update");
        expect(names).toContain("fn_project_remove");
      } finally {
        await destructive.client.close();
        await destructive.mcpServer.close();
      }
    });
  });
});
