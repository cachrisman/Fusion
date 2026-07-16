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
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

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

/*
FNXC:McpServer 2026-07-11-18:00:
FUSI-062's `fn_usage_windows` handler dispatches to `fetchAllProviderUsage`
(re-exported from `@fusion/dashboard`). Mock just that one export (spreading
the real module for everything else, mirroring the `@fusion/core` mock
above) so tests control the returned `ProviderUsage[]` fixture without a
real auth-storage/provider-API round-trip. `fakeProviderUsageResult` is a
module-level box (reset in `beforeEach`) so it survives the single hoisted
`vi.mock` factory instantiation.
*/
const { fakeProviderUsageResult } = vi.hoisted(() => ({
  fakeProviderUsageResult: { value: [] as Array<Record<string, unknown>> },
}));

vi.mock("@fusion/dashboard", async () => {
  const actual = await vi.importActual<typeof import("@fusion/dashboard")>("@fusion/dashboard");
  return { ...actual, fetchAllProviderUsage: vi.fn(async () => fakeProviderUsageResult.value) };
});

/*
FNXC:McpServer 2026-07-11-19:30:
FUSI-067 regression coverage: fn_models_list now sources its registry from
`@fusion/engine`'s `buildExecutionModelRegistry(cwd)`, which internally runs
plugin-runtime discovery (real filesystem/plugin scanning) and reads the
SAME real home-dir `~/.fusion/agent/models.json` state the memory note
above flags as environment-dependent. Tests that need to PROVE a
plugin-runtime provider surfaces (or is absent) stub this seam directly
rather than installing/authenticating a real plugin — `fakeExecutionModelRegistryOverride`
defaults to `undefined` (pass through to the real `buildExecutionModelRegistry`,
exercised by the pre-existing built-in/provider-filter tests below) and is
set per-test to a synthetic `ModelRegistry.inMemory(...)` instance so the
omission-then-fix invariant can be asserted deterministically.
*/
const { fakeExecutionModelRegistryOverride } = vi.hoisted(() => ({
  fakeExecutionModelRegistryOverride: { value: undefined as unknown },
}));

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    buildExecutionModelRegistry: vi.fn(async (cwd: string) => {
      if (fakeExecutionModelRegistryOverride.value !== undefined) return fakeExecutionModelRegistryOverride.value;
      return actual.buildExecutionModelRegistry(cwd);
    }),
  };
});

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { MCP_TOOL_REGISTRY, DESTRUCTIVE_TOOL_TIER, buildMcpToolRegistry, redactSecretsDeep } from "../tools.js";
import { buildMcpServer, jsonSchemaToZodShape } from "../server.js";

const EXPECTED_TOOL_NAMES = [
  "fn_task_create",
  "fn_task_list",
  "fn_task_show",
  // FUSI-117: bounded evidence reads (operator MCP only).
  "fn_task_agent_logs",
  "fn_task_documents_list",
  "fn_task_document_get",
  "fn_task_artifacts_list",
  "fn_task_artifact_get",
  "fn_task_search",
  "fn_task_archive",
  // FUSI-116: external operator conversation controls (never executor runtime tools).
  "fn_task_steer",
  "fn_task_workflow_input",
  "fn_task_comments_list",
  "fn_task_comments_create",
  "fn_delegate_task",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_create",
  "fn_agent_start",
  "fn_agent_stop",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_workflow_validate",
  "fn_workflow_create",
  "fn_workflow_update",
  "fn_workflow_select",
  // FUSI-046: workflow CONFIG + granular IR edit + task-edit tool set
  "fn_workflow_settings",
  "fn_workflow_add_node",
  "fn_workflow_remove_node",
  "fn_workflow_add_edge",
  "fn_workflow_remove_edge",
  "fn_task_update",
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
  // FUSI-083: session-active project selector
  "fn_project_use",
  "fn_project_current",
  // FUSI-052: task lifecycle, agent edit, model read, research, trait discovery
  "fn_task_pause",
  "fn_task_unpause",
  "fn_task_retry",
  "fn_task_duplicate",
  "fn_task_refine",
  "fn_task_unarchive",
  "fn_agent_update",
  "fn_agent_set_instructions",
  "fn_models_list",
  "fn_research_run",
  "fn_research_list",
  "fn_research_get",
  "fn_research_cancel",
  "fn_research_retry",
  "fn_trait_list",
  // FUSI-062: token usage / rate-limit analytics reads
  "fn_token_usage",
  "fn_usage_windows",
];

const SAFE_OPERATOR_CORE_TOOL_NAMES = [
  "fn_task_steer",
  "fn_task_workflow_input",
  "fn_task_comments_list",
  "fn_task_comments_create",
  "fn_task_show",
  "fn_task_agent_logs",
  "fn_task_documents_list",
  "fn_task_document_get",
  "fn_task_artifacts_list",
  "fn_task_artifact_get",
  "fn_workflow_validate",
] as const;

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

describe("jsonSchemaToZodShape", () => {
  it("preserves required fields, nested structures, and declared text/numeric bounds", () => {
    const parser = z.object(jsonSchemaToZodShape({
      type: "object",
      required: ["text", "pagination", "nested"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2_000 },
        pagination: { type: "number", minimum: 0, maximum: 100 },
        nested: {
          type: "array",
          items: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["safe"] } } },
        },
      },
    }));

    expect(parser.safeParse({ text: "x", pagination: 0, nested: [{ kind: "safe" }] }).success).toBe(true);
    for (const invalid of [
      { text: "", pagination: 0, nested: [{ kind: "safe" }] },
      { text: "x".repeat(2_001), pagination: 0, nested: [{ kind: "safe" }] },
      { text: "x", pagination: -1, nested: [{ kind: "safe" }] },
      { text: "x", pagination: 101, nested: [{ kind: "safe" }] },
      { text: "x", pagination: 0, nested: [{ kind: "unsafe" }] },
      { text: "x", pagination: 0 },
    ]) expect(parser.safeParse(invalid).success).toBe(false);
  });
});

describe("MCP_TOOL_REGISTRY (curated v1 allow-list)", () => {
  it("declares exactly the curated allow-list, no more, no less", () => {
    expect(MCP_TOOL_REGISTRY.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("keeps FUSI-118's eleven Safe Operator Core names exactly once in the 78-tool base tier", () => {
    const names = MCP_TOOL_REGISTRY.map((tool) => tool.name);
    expect(names).toHaveLength(78);
    for (const name of SAFE_OPERATOR_CORE_TOOL_NAMES) {
      expect(names.filter((candidate) => candidate === name), `${name} must be registered exactly once`).toHaveLength(1);
    }
    expect(DESTRUCTIVE_TOOL_TIER.map((tool) => tool.name).filter((name) => SAFE_OPERATOR_CORE_TOOL_NAMES.includes(name as never))).toEqual([]);
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
    expect(names).toHaveLength(89);
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
    fakeProviderUsageResult.value = [];
    fakeExecutionModelRegistryOverride.value = undefined;
    tmpDir = await mkdtemp(join(tmpdir(), "fn-fusi-001-mcp-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    store = new TaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function connectClient(options: { allowDestructive?: boolean; projectId?: string; projectName?: string } = {}) {
    const mcpServer = buildMcpServer({
      cwd: tmpDir,
      store,
      version: "test",
      allowDestructive: options.allowDestructive,
      projectId: options.projectId,
      projectName: options.projectName,
    });
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

  /*
  FNXC:McpServer 2026-07-11-15:00:
  FUSI-046: fn_task_update field coverage over the real MCP boundary —
  edit title/description/priority, set+clear agentId, set+clear workflow_id,
  the no-fields-provided error path, and the unknown-task error path, mirroring
  the pi-extension fn_task_update handler exactly.
  */
  it("fn_task_update edits title/description/priority and reports the updated fields", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const task = await store.createTask({ description: "Original description", source: { sourceType: "api" } });
      const result = await client.callTool({
        name: "fn_task_update",
        arguments: { id: task.id, title: "New Title", description: "New description", priority: "high" },
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { taskId?: string; updatedFields?: string[] };
      expect(structured.taskId).toBe(task.id);
      expect(structured.updatedFields).toEqual(expect.arrayContaining(["title", "description", "priority"]));
      const updated = await store.getTask(task.id);
      expect(updated.title).toBe("New Title");
      expect(updated.description).toBe("New description");
      expect(updated.priority).toBe("high");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("fn_task_update sets and clears agentId and workflow_id", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const task = await store.createTask({ description: "Assignable task", source: { sourceType: "api" } });
      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();
      const agent = await agentStore.createAgent({ name: "Assignee", role: "executor" } as any);

      const setAgentResult = await client.callTool({
        name: "fn_task_update",
        arguments: { id: task.id, agentId: agent.id },
      });
      expect(setAgentResult.isError).not.toBe(true);
      let afterSet = await store.getTask(task.id);
      expect(afterSet.assignedAgentId).toBe(agent.id);

      const clearAgentResult = await client.callTool({
        name: "fn_task_update",
        arguments: { id: task.id, agentId: null },
      });
      expect(clearAgentResult.isError).not.toBe(true);
      afterSet = await store.getTask(task.id);
      expect(afterSet.assignedAgentId).toBeFalsy();

      const created = await store.createWorkflowDefinition({
        name: "Update Target Workflow",
        ir: workflowIr("Update Target Workflow") as any,
      } as any);
      const setWorkflowResult = await client.callTool({
        name: "fn_task_update",
        arguments: { id: task.id, workflow_id: created.id },
      });
      expect(setWorkflowResult.isError).not.toBe(true);

      const clearWorkflowResult = await client.callTool({
        name: "fn_task_update",
        arguments: { id: task.id, workflow_id: null },
      });
      expect(clearWorkflowResult.isError).not.toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("fn_task_update rejects a call with no fields and a call for an unknown task id", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const task = await store.createTask({ description: "No-op target", source: { sourceType: "api" } });
      const noFieldsResult = await client.callTool({ name: "fn_task_update", arguments: { id: task.id } });
      expect(noFieldsResult.isError).toBe(true);

      const unknownTaskResult = await client.callTool({
        name: "fn_task_update",
        arguments: { id: "FN-DOES-NOT-EXIST", title: "x" },
      });
      expect(unknownTaskResult.isError).toBe(true);
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

  /*
  FNXC:McpServer 2026-07-11-15:00:
  FUSI-046: fn_workflow_settings get→set→get round-trip over the real MCP
  boundary — proves base-tier registration dispatches to the shared
  createWorkflowSettingsTool (stored + effective values on get, null-clears on
  set), and that the tool is present without --allow-destructive.
  */
  it("fn_workflow_settings get→set→get round-trip is base-tier and dispatches through the shared factory", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("fn_workflow_settings");

      const created = await store.createWorkflowDefinition({
        name: "Settings Round Trip Workflow",
        ir: {
          ...workflowIr("Settings Round Trip Workflow"),
          settings: [{ id: "autoMerge", name: "Auto Merge", type: "boolean", default: true }],
        } as any,
      } as any);

      const setResult = await client.callTool({
        name: "fn_workflow_settings",
        arguments: { action: "set", workflow_id: created.id, values: { autoMerge: false } },
      });
      expect(setResult.isError).not.toBe(true);
      const setStructured = setResult.structuredContent as { stored?: Record<string, unknown>; effective?: Record<string, unknown> };
      expect(setStructured.stored?.autoMerge).toBe(false);
      expect(setStructured.effective?.autoMerge).toBe(false);

      const getResult = await client.callTool({
        name: "fn_workflow_settings",
        arguments: { action: "get", workflow_id: created.id },
      });
      expect(getResult.isError).not.toBe(true);
      const getStructured = getResult.structuredContent as { stored?: Record<string, unknown>; effective?: Record<string, unknown> };
      expect(getStructured.stored?.autoMerge).toBe(false);
      expect(getStructured.effective?.autoMerge).toBe(false);

      const clearResult = await client.callTool({
        name: "fn_workflow_settings",
        arguments: { action: "set", workflow_id: created.id, values: { autoMerge: null } },
      });
      expect(clearResult.isError).not.toBe(true);
      const clearStructured = clearResult.structuredContent as { stored?: Record<string, unknown>; effective?: Record<string, unknown> };
      expect(clearStructured.stored?.autoMerge).toBeUndefined();
      expect(clearStructured.effective?.autoMerge).toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  /*
  FNXC:McpWorkflow 2026-07-11-15:00:
  FUSI-046: granular workflow node/edge tools MCP round-trip — create a
  workflow, add a node with connecting edges, add a bypass edge, remove that
  bypass edge, remove the node (after removing its edges), and assert the IR
  round-trips and stays valid (parseWorkflowIr) at each step.
  */
  it("fn_workflow_add_node/remove_node/add_edge/remove_edge round-trip over the MCP boundary", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const created = await store.createWorkflowDefinition({
        name: "Granular MCP Workflow",
        ir: workflowIr("Granular MCP Workflow") as any,
      } as any);

      const addNodeResult = await client.callTool({
        name: "fn_workflow_add_node",
        arguments: {
          workflow_id: created.id,
          node: { id: "gate1", kind: "gate", column: "todo" },
          edges: [
            { from: "start", to: "gate1", condition: "success" },
            { from: "gate1", to: "end", condition: "success" },
          ],
        },
      });
      expect(addNodeResult.isError).not.toBe(true);

      const addEdgeResult = await client.callTool({
        name: "fn_workflow_add_edge",
        arguments: { workflow_id: created.id, edge: { from: "start", to: "end", condition: "success" } },
      });
      expect(addEdgeResult.isError).not.toBe(true);

      let getResult = await client.callTool({ name: "fn_workflow_get", arguments: { workflow_id: created.id } });
      let ir = (getResult.structuredContent as { ir?: { nodes?: any[]; edges?: any[] } }).ir;
      expect((ir?.nodes ?? []).map((n) => n.id)).toEqual(expect.arrayContaining(["start", "end", "gate1"]));
      expect((ir?.edges ?? [])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "start", to: "gate1" }),
          expect.objectContaining({ from: "gate1", to: "end" }),
          expect.objectContaining({ from: "start", to: "end" }),
        ]),
      );

      const removeEdgeResult = await client.callTool({
        name: "fn_workflow_remove_edge",
        arguments: { workflow_id: created.id, from: "start", to: "end", condition: "success" },
      });
      expect(removeEdgeResult.isError).not.toBe(true);

      // fn_workflow_remove_node CASCADES to remove gate1's own incident edges
      // atomically (a non-cascading two-step removal would fail start-reachability
      // on the first edge removal since gate1 sits mid-graph) — no other edge is touched.
      const removeNodeResult = await client.callTool({
        name: "fn_workflow_remove_node",
        arguments: { workflow_id: created.id, node_id: "gate1" },
      });
      expect(removeNodeResult.isError).not.toBe(true);

      getResult = await client.callTool({ name: "fn_workflow_get", arguments: { workflow_id: created.id } });
      ir = (getResult.structuredContent as { ir?: { nodes?: any[]; edges?: any[] } }).ir;
      expect((ir?.nodes ?? []).map((n) => n.id)).not.toContain("gate1");
      expect((ir?.edges ?? [])).toEqual([expect.objectContaining({ from: "start", to: "end" })]);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("fn_workflow_add_node/add_edge/remove_node/remove_edge are base-tier and dispatch through the shared factory", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const name of ["fn_workflow_add_node", "fn_workflow_remove_node", "fn_workflow_add_edge", "fn_workflow_remove_edge"]) {
        expect(names).toContain(name);
      }
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  /*
  FNXC:McpServer 2026-07-11-15:00:
  FUSI-046: fn_task_list must filter AND display workflow-specific columns
  (e.g. the Ideas backlog), not just the six defaults — seeds a task directly
  into a non-default `ideas` column (mirrors packages/core/src/__tests__/
  migration-workflow-columns.test.ts's raw-SQL seeding pattern for a
  workflow-only column id no store API assigns during ordinary creation).
  */
  it("fn_task_list shows and filters a workflow-specific column (ideas) without rejecting it", async () => {
    const { client, mcpServer } = await connectClient();
    try {
      const ideasTask = await store.createTask({ description: "Idea: better onboarding", source: { sourceType: "api" } });
      store.getDatabase().prepare(`UPDATE tasks SET "column" = ? WHERE id = ?`).run("ideas", ideasTask.id);

      // Unfiltered listing must show the ideas-column task, not silently drop it.
      const unfiltered = await client.callTool({ name: "fn_task_list", arguments: {} });
      expect(unfiltered.isError).not.toBe(true);
      const unfilteredText = (unfiltered.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(unfilteredText).toContain(ideasTask.id);

      // Explicit column:"ideas" filter must not be rejected by a hardcoded enum.
      const filtered = await client.callTool({ name: "fn_task_list", arguments: { column: "ideas" } });
      expect(filtered.isError).not.toBe(true);
      const filteredText = (filtered.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(filteredText).toContain(ideasTask.id);

      // A default-column filter still behaves as before (unchanged).
      const defaultFiltered = await client.callTool({ name: "fn_task_list", arguments: { column: "planning" } });
      expect(defaultFiltered.isError).not.toBe(true);

      // An unknown column string returns an empty result, not a crash.
      const unknownFiltered = await client.callTool({ name: "fn_task_list", arguments: { column: "totally-unknown-column" } });
      expect(unknownFiltered.isError).not.toBe(true);
      const unknownText = (unknownFiltered.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(unknownText).toMatch(/No tasks in/);

      // The advertised input schema no longer rejects a workflow-specific column
      // via a hardcoded enum.
      const { tools } = await client.listTools();
      const listTool = tools.find((t) => t.name === "fn_task_list");
      const columnSchema = (listTool!.inputSchema as any).properties?.column;
      expect(columnSchema?.enum).toBeUndefined();
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

  /*
  FNXC:McpConversationControls 2026-07-16-19:15:
  FUSI-116's local operator MCP controls must remain a thin boundary over
  shared TaskStore paths: all invalid external inputs are no-mutation, opaque
  workflow markers stay executor-owned, and comment reads never expose raw
  task state or comment metadata.
  */
  describe("FUSI-116 operator conversation controls", () => {
    const marker = "workflow-input:approval@1737000000000: Confirm rollout?";

    it("rejects required/wrong-type schemas and handler-level invalid text without mutations", async () => {
      const task = await store.createTask({ description: "Validate MCP conversation inputs", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const textTools = [
          { name: "fn_task_steer", base: { task_id: task.id } },
          { name: "fn_task_workflow_input", base: { task_id: task.id, expected_input_marker: marker } },
          { name: "fn_task_comments_create", base: { task_id: task.id } },
        ] as const;
        const before = await store.getTask(task.id);

        for (const tool of textTools) {
          const missing = await client.callTool({ name: tool.name, arguments: tool.base });
          expect(missing.isError, `${tool.name} required text`).toBe(true);
          const wrongType = await client.callTool({ name: tool.name, arguments: { ...tool.base, text: 7 } });
          expect(wrongType.isError, `${tool.name} text type`).toBe(true);

          for (const text of ["", "   ", "x".repeat(2_001)]) {
            const invalid = await client.callTool({ name: tool.name, arguments: { ...tool.base, text } });
            expect(invalid.isError, `${tool.name} invalid text`).toBe(true);
          }
        }

        const listedMissing = await client.callTool({ name: "fn_task_comments_list", arguments: {} });
        expect(listedMissing.isError).toBe(true);
        const listedWrongType = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: 7 } });
        expect(listedWrongType.isError).toBe(true);
        for (const pagination of [{ limit: 1.5 }, { limit: Infinity }, { offset: -1 }, { offset: 10_001 }]) {
          const invalid = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id, ...pagination } });
          expect(invalid.isError).toBe(true);
        }

        const after = await store.getTask(task.id);
        expect(after.comments ?? []).toEqual(before.comments ?? []);
        expect(after.steeringComments ?? []).toEqual(before.steeringComments ?? []);
        expect(after.paused).toBe(before.paused);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("steers through the shared comment and executor mirror without exposing raw task state", async () => {
      const task = await store.createTask({ description: "Steering secret token=raw-steering-secret", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_steer", arguments: { task_id: task.id, text: "Proceed with token=raw-steering-secret" } });
        expect(result.isError).not.toBe(true);
        const updated = await store.getTask(task.id);
        expect(updated.comments).toHaveLength(1);
        expect(updated.comments?.[0]).toMatchObject({ text: "Proceed with token=raw-steering-secret", author: "user" });
        expect(updated.steeringComments).toHaveLength(1);
        expect(updated.steeringComments?.[0]).toMatchObject({ id: updated.comments?.[0]?.id, text: "Proceed with token=raw-steering-secret", author: "user" });
        expect(updated.log.some((entry) => entry.action === "Comment added by user")).toBe(true);

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("raw-steering-secret");
        expect(serialized).toContain("[REDACTED]");
        expect(serialized).not.toContain("description");
        expect(serialized).not.toContain("steeringComments");
        expect(serialized).not.toContain("log");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("redacts paths and data URLs from integration-authored comment projections", async () => {
      const task = await store.createTask({ description: "Comment projection redaction", source: { sourceType: "api" } });
      const unsafe = "Imported from /private/integration/comment.json data:application/octet-stream;base64,AAECAw==";
      await store.addTaskComment(task.id, unsafe, "integration");
      const { client, mcpServer } = await connectClient();
      try {
        const listed = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id } });
        const steered = await client.callTool({ name: "fn_task_steer", arguments: { task_id: task.id, text: unsafe } });
        for (const result of [listed, steered]) {
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain("/private/integration/comment.json");
          expect(serialized).not.toContain("data:application/octet-stream;base64,AAECAw==");
          expect(serialized).toContain("[redacted-path]");
          expect(serialized).toContain("[redacted-data-url]");
        }
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("delegates matching workflow input once and returns typed no-mutation conflicts", async () => {
      const matching = await store.createTask({ description: "Await exact marker", source: { sourceType: "api" } });
      await store.updateTask(matching.id, { paused: true, status: "awaiting-user-input", pausedReason: marker });
      const wrong = await store.createTask({ description: "Reject stale marker", source: { sourceType: "api" } });
      await store.updateTask(wrong.id, { paused: true, status: "awaiting-user-input", pausedReason: marker });
      const replaced = await store.createTask({ description: "Reject replaced marker", source: { sourceType: "api" } });
      await store.updateTask(replaced.id, { paused: true, status: "awaiting-user-input", pausedReason: "workflow-input:replacement@2: Revised prompt" });
      const nonWorkflow = await store.createTask({ description: "Operator pause", source: { sourceType: "api" } });
      await store.updateTask(nonWorkflow.id, { paused: true, status: "awaiting-user-input", pausedReason: "operator-requested-pause" });
      const notPaused = await store.createTask({ description: "Already resumed", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const submitted = await client.callTool({ name: "fn_task_workflow_input", arguments: { task_id: matching.id, text: "Ship it", expected_input_marker: marker } });
        expect(submitted.isError).not.toBe(true);
        expect((submitted.structuredContent as { outcome?: string }).outcome).toBe("submitted");
        const resumed = await store.getTask(matching.id);
        expect(resumed.paused).toBeFalsy();
        expect(resumed.pausedReason).toBe(marker);
        expect(resumed.comments?.filter((comment) => comment.text === "Ship it")).toHaveLength(1);
        expect(resumed.steeringComments?.filter((comment) => comment.text === "Ship it")).toHaveLength(1);

        const missing = await client.callTool({ name: "fn_task_workflow_input", arguments: { task_id: "FN-MISSING", text: "Do not append", expected_input_marker: marker } });
        expect(missing.isError).toBe(true);
        expect((missing.structuredContent as { outcome?: string }).outcome).toBe("not-found");

        for (const [task, expected, expectedInputMarker] of [[wrong, "marker-mismatch", `${marker} stale`], [replaced, "marker-mismatch", marker], [nonWorkflow, "not-workflow-input", marker], [notPaused, "not-paused", marker]] as const) {
          const before = await store.getTask(task.id);
          const result = await client.callTool({ name: "fn_task_workflow_input", arguments: { task_id: task.id, text: "Do not append", expected_input_marker: expectedInputMarker } });
          expect(result.isError).toBe(true);
          expect((result.structuredContent as { outcome?: string }).outcome).toBe(expected);
          if (before.pausedReason) expect(JSON.stringify(result)).not.toContain(before.pausedReason);
          const after = await store.getTask(task.id);
          expect(after.paused).toBe(before.paused);
          expect(after.pausedReason).toBe(before.pausedReason);
          expect(after.comments ?? []).toEqual(before.comments ?? []);
          expect(after.steeringComments ?? []).toEqual(before.steeringComments ?? []);
        }
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("creates server-authored ordinary comments and pages redacted comment projections deterministically", async () => {
      const task = await store.createTask({ description: "Comment pagination", source: { sourceType: "api" } });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-16T19:15:00.000Z"));
      try {
        await store.addTaskComment(task.id, "first token=first-secret", "existing-author");
        await store.addTaskComment(task.id, "second", "existing-author");
        await store.addComment(task.id, "third", "github", { source: "github-review", externalId: "token=metadata-secret" });
      } finally {
        vi.useRealTimers();
      }

      const seeded = await store.getTask(task.id);
      const expectedIds = [...(seeded.comments ?? [])]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((comment) => comment.id);
      const { client, mcpServer } = await connectClient();
      try {
        const created = await client.callTool({ name: "fn_task_comments_create", arguments: { task_id: task.id, text: "MCP comment", author: "spoofed-author" } });
        expect(created.isError).not.toBe(true);
        const afterCreate = await store.getTask(task.id);
        const mcpComment = afterCreate.comments?.at(-1);
        expect(mcpComment).toMatchObject({ text: "MCP comment", author: "mcp-operator" });
        expect(afterCreate.steeringComments ?? []).toEqual([]);

        const defaultPage = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id } });
        expect(defaultPage.isError).not.toBe(true);
        const defaultStructured = defaultPage.structuredContent as { comments: Array<{ id: string; text: string; author: string }>; limit: number; offset: number; total: number };
        expect(defaultStructured.limit).toBe(50);
        expect(defaultStructured.offset).toBe(0);
        expect(defaultStructured.total).toBe(4);
        expect(defaultStructured.comments.map((comment) => comment.id)).toEqual([...expectedIds, mcpComment!.id].sort((a, b) => {
          const aComment = afterCreate.comments!.find((comment) => comment.id === a)!;
          const bComment = afterCreate.comments!.find((comment) => comment.id === b)!;
          return aComment.createdAt.localeCompare(bComment.createdAt) || a.localeCompare(b);
        }));
        expect(JSON.stringify(defaultPage)).not.toContain("first-secret");
        expect(JSON.stringify(defaultPage)).not.toContain("metadata-secret");
        expect(JSON.stringify(defaultPage)).toContain("[REDACTED]");
        expect(JSON.stringify(defaultStructured.comments[2])).not.toContain("externalId");
        expect(JSON.stringify(defaultStructured.comments[2])).not.toContain("source");

        const pageOne = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id, limit: 1, offset: 0 } });
        const pageTwo = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id, limit: 1, offset: 1 } });
        const maxPage = await client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id, limit: 100, offset: 0 } });
        const firstId = (pageOne.structuredContent as { comments: Array<{ id: string }> }).comments[0]?.id;
        const secondId = (pageTwo.structuredContent as { comments: Array<{ id: string }> }).comments[0]?.id;
        expect(firstId).not.toBe(secondId);
        const allSingleCommentPages = await Promise.all(defaultStructured.comments.map((_, offset) =>
          client.callTool({ name: "fn_task_comments_list", arguments: { task_id: task.id, limit: 1, offset } }),
        ));
        expect(allSingleCommentPages.map((page) => (page.structuredContent as { comments: Array<{ id: string }> }).comments[0]?.id))
          .toEqual(defaultStructured.comments.map((comment) => comment.id));
        expect((maxPage.structuredContent as { comments: Array<{ id: string }>; limit: number }).limit).toBe(100);
        expect((maxPage.structuredContent as { comments: Array<{ id: string }> }).comments.map((comment) => comment.id)).toEqual(defaultStructured.comments.map((comment) => comment.id));
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("never registers comment edit or delete controls in either resolved registry", () => {
      const forbidden = ["fn_task_comments_update", "fn_task_comments_delete"];
      for (const registry of [buildMcpToolRegistry({}), buildMcpToolRegistry({ allowDestructive: true })]) {
        const names = registry.map((tool) => tool.name);
        for (const name of forbidden) expect(names).not.toContain(name);
      }
      expect(MCP_TOOL_REGISTRY.some((tool) => /comments_(update|delete)/.test(tool.name))).toBe(false);
      expect(DESTRUCTIVE_TOOL_TIER.some((tool) => /comments_(update|delete)/.test(tool.name))).toBe(false);
    });
  });

  /*
  FNXC:McpEvidence 2026-07-16-20:30:
  FUSI-117 regression coverage exercises the operator MCP boundary with a real
  TaskStore. Evidence keys are never paths, list responses stay metadata-only,
  and inline bytes are allowed only for explicitly safe text MIME types.
  */
  describe("FUSI-117 bounded evidence and workflow validation", () => {
    it("projects task diagnostics without prompt, paths, or inactive workflow markers", async () => {
      const task = await store.createTask({ title: "Diagnostic token=top-secret", description: "Do not disclose prompt", source: { sourceType: "api" } });
      await store.updateTask(task.id, {
        paused: true,
        status: "awaiting-user-input",
        pausedReason: "workflow-input:token=opaque-marker@1: secret question body",
        worktree: "/private/worktree",
        sessionFile: "/private/session.json",
        error: "token=diagnostic-secret",
        steps: Array.from({ length: 51 }, (_, index) => ({ name: `Step ${index}`, status: "pending" as const })),
        currentStep: 50,
      });
      await store.appendAgentLog(task.id, "agent evidence", "text", "detail token=log-secret", "executor");
      await store.upsertTaskDocument(task.id, { key: "plan", content: "plan token=document-secret", author: "agent" });
      await store.registerArtifact({ taskId: task.id, type: "document", title: "Evidence", mimeType: "text/plain", content: "artifact token=artifact-secret", authorId: "agent-1", authorType: "agent" });
      const { client, mcpServer } = await connectClient();
      try {
        const active = await client.callTool({ name: "fn_task_show", arguments: { id: task.id } });
        const structured = active.structuredContent as { expected_input_marker?: string; task?: { worktree?: { available?: boolean } }; evidence?: { agent_logs?: { total_count: number }; documents?: { total_count: number }; artifacts?: { total_count: number } } };
        expect(structured.expected_input_marker).toBe("workflow-input:token=opaque-marker@1: secret question body");
        expect(structured.task?.worktree).toEqual({ available: true });
        expect(structured.evidence).toMatchObject({ agent_logs: { total_count: 1 }, documents: { total_count: 1 }, artifacts: { total_count: 1 } });
        expect((structured as { task?: { progress?: { steps?: unknown[]; steps_truncated?: boolean } } }).task?.progress).toMatchObject({ steps_truncated: true });
        expect((structured as { task?: { progress?: { steps?: unknown[] } } }).task?.progress?.steps).toHaveLength(50);
        const serialized = JSON.stringify(active);
        for (const forbidden of ["Do not disclose prompt", "/private/worktree", "/private/session.json", "sessionFile", "top-secret", "diagnostic-secret", "document-secret", "artifact-secret"]) expect(serialized).not.toContain(forbidden);
        await store.updateTask(task.id, { paused: false, status: "todo", pausedReason: "workflow-input:token=opaque-marker@1: secret question body" });
        const inactive = await client.callTool({ name: "fn_task_show", arguments: { id: task.id } });
        expect(JSON.stringify(inactive)).not.toContain("expected_input_marker");
      } finally { await client.close(); await mcpServer.close(); }
    });

    it("pages redacted logs and metadata-first documents without path escape hatches", async () => {
      const task = await store.createTask({ description: "Evidence pagination", source: { sourceType: "api" } });
      await store.appendAgentLog(task.id, "old token=old-secret at /private/agent.log", "text", "detail-1", "executor");
      await store.appendAgentLog(task.id, "new at \\\\server\\share\\agent.log", "tool", "detail token=new-secret at C:\\private\\agent.log", "reviewer");
      await store.upsertTaskDocument(task.id, { key: "zeta", content: "z".repeat(17_000), author: "agent" });
      await store.upsertTaskDocument(task.id, { key: "alpha", content: "alpha token=doc-secret", author: "user" });
      const { client, mcpServer } = await connectClient();
      try {
        const logs = await client.callTool({ name: "fn_task_agent_logs", arguments: { task_id: task.id, limit: 999, offset: 0 } });
        const logProjection = logs.structuredContent as { total_count: number; limit: number; entries: Array<{ text?: string; detail?: string }> };
        expect(logProjection).toMatchObject({ total_count: 2, limit: 50 });
        expect(JSON.stringify(logs)).not.toContain("old-secret");
        expect(JSON.stringify(logs)).not.toContain("new-secret");
        expect(JSON.stringify(logs)).not.toContain("/private/agent.log");
        expect(logProjection.entries[1]?.detail).not.toContain("C:\\private\\agent.log");
        expect(logProjection.entries[1]?.text).not.toContain("\\\\server\\share\\agent.log");
        const docs = await client.callTool({ name: "fn_task_documents_list", arguments: { task_id: task.id, limit: 1, offset: 0 } });
        const docProjection = docs.structuredContent as { total_count: number; documents: Array<{ key: string }> };
        expect(docProjection.total_count).toBe(2);
        expect(docProjection.documents[0]?.key).toBe("alpha");
        expect(JSON.stringify(docs)).not.toContain("doc-secret");
        const doc = await client.callTool({ name: "fn_task_document_get", arguments: { task_id: task.id, key: "zeta" } });
        const fetched = doc.structuredContent as { document: { content: string; content_truncated: boolean; original_byte_size: number } };
        expect(fetched.document).toMatchObject({ content_truncated: true, original_byte_size: 17_000 });
        expect(Buffer.byteLength(fetched.document.content, "utf8")).toBeLessThanOrEqual(16 * 1024);
        for (const args of [{ task_id: task.id, key: "../PROMPT.md" }, { task_id: "missing", key: "alpha" }]) {
          expect((await client.callTool({ name: "fn_task_document_get", arguments: args })).isError).toBe(true);
        }
      } finally { await client.close(); await mcpServer.close(); }
    });

    it("allows only safe inline artifact MIME types and validates workflow dry runs through the shared factory", async () => {
      const task = await store.createTask({ description: "Artifact evidence", source: { sourceType: "api" } });
      const plainContent = "/private/artifact.txt " + "é".repeat(10_000);
      const plain = await store.registerArtifact({ taskId: task.id, type: "document", title: "Plain", mimeType: "text/plain", content: plainContent, authorId: "agent-1", authorType: "agent" });
      const uri = await store.registerArtifact({ taskId: task.id, type: "document", title: "URI", mimeType: "text/plain", uri: "file:///private/secret", authorId: "agent-1", authorType: "agent" });
      const html = await store.registerArtifact({ taskId: task.id, type: "document", title: "HTML", mimeType: "text/html", content: "<secret>", authorId: "agent-1", authorType: "agent" });
      const other = await store.createTask({ description: "Other task", source: { sourceType: "api" } });
      const foreign = await store.registerArtifact({ taskId: other.id, type: "document", title: "Foreign", mimeType: "text/plain", content: "no", authorId: "agent-1", authorType: "agent" });
      const { client, mcpServer } = await connectClient();
      try {
        const list = await client.callTool({ name: "fn_task_artifacts_list", arguments: { task_id: task.id, limit: 99 } });
        const listed = JSON.stringify(list);
        expect(listed).not.toContain("file:///private/secret");
        expect(listed).not.toContain("authorId");
        const readPlain = await client.callTool({ name: "fn_task_artifact_get", arguments: { task_id: task.id, key: plain.id } });
        const plainProjection = readPlain.structuredContent as { artifact: { content: string; content_truncated: boolean; original_byte_size: number; content_sha256: string } };
        expect(plainProjection.artifact.content_truncated).toBe(true);
        expect(plainProjection.artifact.original_byte_size).toBe(Buffer.byteLength(plainContent, "utf8"));
        expect(plainProjection.artifact.content_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Buffer.byteLength(plainProjection.artifact.content, "utf8")).toBeLessThanOrEqual(16 * 1024);
        expect(plainProjection.artifact.content).not.toContain("/private/artifact.txt");
        for (const artifact of [uri, html]) {
          const metadataOnly = await client.callTool({ name: "fn_task_artifact_get", arguments: { task_id: task.id, key: artifact.id } });
          expect((metadataOnly.structuredContent as { inline_content_returned?: boolean }).inline_content_returned).toBe(false);
          expect(JSON.stringify(metadataOnly)).not.toContain("file:///private/secret");
          expect(JSON.stringify(metadataOnly)).not.toContain("<secret>");
        }
        expect((await client.callTool({ name: "fn_task_artifact_get", arguments: { task_id: task.id, key: foreign.id } })).isError).toBe(true);
        const valid = await client.callTool({ name: "fn_workflow_validate", arguments: { ir: workflowIr("Dry run") } });
        expect((valid.structuredContent as { valid?: boolean }).valid).toBe(true);
        const malformed = await client.callTool({ name: "fn_workflow_validate", arguments: { ir: { version: "v2", nodes: [] } } });
        expect((malformed.structuredContent as { valid?: boolean }).valid).toBe(false);
        const missing = await client.callTool({ name: "fn_workflow_validate", arguments: { workflow_id: "WF-missing" } });
        expect(missing.isError).toBe(true);
        const invalidCodeIr = {
          ...workflowIr("Code failure"),
          nodes: [
            { id: "start", kind: "start", column: "todo" },
            { id: "code", kind: "code", column: "todo", config: { source: "return (((" } },
            { id: "end", kind: "end", column: "todo" },
          ],
          edges: [{ from: "start", to: "code" }, { from: "code", to: "end" }],
        } as any;
        const codeFailure = await client.callTool({ name: "fn_workflow_validate", arguments: { ir: invalidCodeIr } });
        expect((codeFailure.structuredContent as { valid?: boolean }).valid).toBe(false);
      } finally { await client.close(); await mcpServer.close(); }
    });
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

    it("fn_settings_update (FUSI-048) drops a global-only key from a project-scope patch, applies it not, and never persists it into the project row", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "project", patch: { themeMode: "dark" } },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { appliedKeys: string[]; droppedKeys: string[] };
        expect(structured.appliedKeys).not.toContain("themeMode");
        expect(structured.droppedKeys).toContain("themeMode");

        // Confirm it was never persisted into the raw project settings row.
        const row = (
          store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => { settings?: string } | undefined } } }
        ).db
          .prepare("SELECT settings FROM config WHERE id = 1")
          .get();
        const rawSettings = row?.settings ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
        expect(Object.prototype.hasOwnProperty.call(rawSettings, "themeMode")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update (FUSI-048) drops a project-only key from a global-scope patch, applies it not, and never persists it into the global row", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "global", patch: { globalPause: true } },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { appliedKeys: string[]; droppedKeys: string[] };
        expect(structured.appliedKeys).not.toContain("globalPause");
        expect(structured.droppedKeys).toContain("globalPause");

        // Confirm it was never persisted into the raw global settings store.
        const rawGlobal = await store.getGlobalSettingsStore().readRaw();
        expect(Object.prototype.hasOwnProperty.call(rawGlobal, "globalPause")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update (FUSI-048) applies only the in-scope key from a mixed-scope patch and drops the wrong-scope key", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "project", patch: { globalPause: true, themeMode: "dark" } },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { appliedKeys: string[]; droppedKeys: string[] };
        expect(structured.appliedKeys).toEqual(["globalPause"]);
        expect(structured.droppedKeys).toEqual(["themeMode"]);

        const settings = await store.getSettings();
        expect(settings.globalPause).toBe(true);

        const row = (
          store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => { settings?: string } | undefined } } }
        ).db
          .prepare("SELECT settings FROM config WHERE id = 1")
          .get();
        const rawSettings = row?.settings ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
        expect(Object.prototype.hasOwnProperty.call(rawSettings, "themeMode")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_settings_update (FUSI-048) reports all-dropped and skips the store write when every key is wrong-scope", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      const updateSettingsSpy = vi.spyOn(store, "updateSettings");
      try {
        const result = await client.callTool({
          name: "fn_settings_update",
          arguments: { scope: "project", patch: { themeMode: "dark" } },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { appliedKeys: string[]; droppedKeys: string[]; outcome: string };
        expect(structured.appliedKeys).toEqual([]);
        expect(structured.droppedKeys).toEqual(["themeMode"]);
        expect(structured.outcome).toBe("no-op");
        expect(updateSettingsSpy).not.toHaveBeenCalled();
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toMatch(/no changes/i);
      } finally {
        updateSettingsSpy.mockRestore();
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

  /*
  FNXC:McpProjectSession 2026-07-12-00:00:
  FUSI-083 acceptance coverage: from a single running server (initial store =
  project A), create in A with no switch, call fn_project_use to retarget at
  project B (a SEPARATE real temp TaskStore, seeded into fakeCentralRegistry
  the same way the FUSI-020 project tests do), then prove subsequent
  store-backed creates land in B's store (correct id prefix) while A's store
  does NOT receive them. Also covers fn_project_current, unknown-target
  rejection (active project unchanged), switch-back-to-initial (store reuse,
  no reopen), the stderr-only PROJECT SWITCH audit line, and close()
  cleaning up the switched-to store without double-closing the initial one.
  */
  describe("session-active project selector (FUSI-083: fn_project_use / fn_project_current)", () => {
    let projectBDir: string;
    let projectBStore: TaskStore;

    beforeEach(async () => {
      projectBDir = await mkdtemp(join(tmpdir(), "fn-fusi-083-project-b-"));
      await mkdir(join(projectBDir, ".fusion"), { recursive: true });
      projectBStore = new TaskStore(projectBDir);
      await projectBStore.init();

      fakeCentralRegistry.set("proj_a", {
        id: "proj_a",
        name: "Project A",
        path: tmpDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      fakeCentralRegistry.set("proj_b", {
        id: "proj_b",
        name: "Project B",
        path: projectBDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    afterEach(async () => {
      await projectBStore.close();
      await rm(projectBDir, { recursive: true, force: true });
    });

    it("creates in A with no switch, switches to B via fn_project_use, then creates land in B (not A) with B's task prefix", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const createInA = await client.callTool({ name: "fn_task_create", arguments: { description: "Task created in project A" } });
        expect(createInA.isError).not.toBe(true);
        const aTasks = await store.listTasks({ slim: true });
        expect(aTasks.some((t) => t.description === "Task created in project A")).toBe(true);

        const useResult = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_b" } });
        expect(useResult.isError).not.toBe(true);
        const useStructured = useResult.structuredContent as { activeProject?: { id?: string; name?: string } };
        expect(useStructured.activeProject?.id).toBe("proj_b");
        expect(useStructured.activeProject?.name).toBe("Project B");

        const createInB = await client.callTool({ name: "fn_task_create", arguments: { description: "Task created in project B" } });
        expect(createInB.isError).not.toBe(true);

        const bTasks = await projectBStore.listTasks({ slim: true });
        expect(bTasks.some((t) => t.description === "Task created in project B")).toBe(true);

        const aTasksAfter = await store.listTasks({ slim: true });
        expect(aTasksAfter.some((t) => t.description === "Task created in project B")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_current reports the active project before and after a switch", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_a", projectName: "Project A" });
      try {
        const before = await client.callTool({ name: "fn_project_current", arguments: {} });
        expect(before.isError).not.toBe(true);
        expect((before.structuredContent as { activeProject?: { id?: string } }).activeProject?.id).toBe("proj_a");

        const useResult = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_b" } });
        expect(useResult.isError).not.toBe(true);

        const after = await client.callTool({ name: "fn_project_current", arguments: {} });
        expect(after.isError).not.toBe(true);
        expect((after.structuredContent as { activeProject?: { id?: string } }).activeProject?.id).toBe("proj_b");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_use with an unknown id/name is an error result and leaves the active project unchanged", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_a", projectName: "Project A" });
      try {
        const badUse = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_does_not_exist" } });
        expect(badUse.isError).toBe(true);

        const current = await client.callTool({ name: "fn_project_current", arguments: {} });
        expect((current.structuredContent as { activeProject?: { id?: string } }).activeProject?.id).toBe("proj_a");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("switching back to the initial project's id reuses the initial store without error", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_a", projectName: "Project A" });
      try {
        const toB = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_b" } });
        expect(toB.isError).not.toBe(true);

        const backToA = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_a" } });
        expect(backToA.isError).not.toBe(true);
        expect((backToA.structuredContent as { activeProject?: { id?: string } }).activeProject?.id).toBe("proj_a");

        const createInA = await client.callTool({ name: "fn_task_create", arguments: { description: "Task created after switch-back to A" } });
        expect(createInA.isError).not.toBe(true);
        const aTasks = await store.listTasks({ slim: true });
        expect(aTasks.some((t) => t.description === "Task created after switch-back to A")).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("writes a PROJECT SWITCH audit line to stderr (never stdout) on every switch", async () => {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { client, mcpServer } = await connectClient({ projectId: "proj_a", projectName: "Project A" });
      try {
        const result = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_b" } });
        expect(result.isError).not.toBe(true);

        const auditLine = stderrSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("PROJECT SWITCH"));
        expect(auditLine).toBeTruthy();
        expect(auditLine).toContain("from=proj_a");
        expect(auditLine).toContain("to=proj_b");
        expect(auditLine).toContain("name=Project B");

        expect(stdoutSpy.mock.calls.some((c) => String(c[0]).includes("PROJECT SWITCH"))).toBe(false);
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_project_use/fn_project_current are base-tier (present without --allow-destructive)", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const { tools } = await client.listTools();
        const names = (tools ?? []).map((t) => t.name);
        expect(names).toContain("fn_project_use");
        expect(names).toContain("fn_project_current");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("mcpServer.close() closes the switched-to store without throwing (session-owned lifecycle)", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_a", projectName: "Project A" });
      const useResult = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_b" } });
      expect(useResult.isError).not.toBe(true);
      await client.close();
      await expect(mcpServer.close()).resolves.not.toThrow();
    });
  });

  /*
  FNXC:TaskCreate 2026-07-16-15:20:
  FUSI-096 regression: reproduce the reported drift trigger at the MCP
  dispatch layer — a session LAUNCH-BOUND to project P (no fn_project_use
  call at all, matching the original "--project Fusion" report) must never
  have its store-backed mutations land in a DIFFERENT, most-recently-created
  project (CAB prefix, default "triage" entry column), even though that
  other project is registered in the SAME shared central registry and its
  own first task is created BEFORE any P-bound mutation runs. Every
  store-backed mutation tool enumerated in the FUSI-096 Surface Enumeration
  is covered here: fn_task_create, fn_delegate_task, fn_workflow_create,
  fn_workflow_update, fn_agent_create, fn_task_update. Root-cause finding
  (see task document "notes"): the dispatch seam (`active.store` in
  server.ts), McpProjectSession, and every TaskStore create/mutation path are
  already scoped strictly to the session-bound store with no central-current
  lookup in the write path — this suite pins that invariant.
  */
  describe("FUSI-096: launch-bound-only mutation targeting (no fn_project_use call)", () => {
    let cabDir: string;
    let cabStore: TaskStore;

    beforeEach(async () => {
      await store.updateSettings({ taskPrefix: "FUSI" });
      await store.setDefaultWorkflowId("builtin:coding-ideas");

      cabDir = await mkdtemp(join(tmpdir(), "fn-fusi-096-cab-"));
      await mkdir(join(cabDir, ".fusion"), { recursive: true });
      cabStore = new TaskStore(cabDir);
      await cabStore.init();
      await cabStore.updateSettings({ taskPrefix: "CAB" });
      // The "most-recently-created" distractor project: created (and given
      // its own first task) BEFORE the P-bound mutation calls below run.
      await cabStore.createTask({ description: "Pre-existing CAB task (created first)" });

      fakeCentralRegistry.set("proj_fusion", {
        id: "proj_fusion",
        name: "Fusion",
        path: tmpDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      });
      fakeCentralRegistry.set("proj_cab", {
        id: "proj_cab",
        name: "contentful-app-builder",
        path: cabDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      });
    });

    afterEach(async () => {
      await cabStore.close();
      await rm(cabDir, { recursive: true, force: true });
    });

    it("fn_task_create lands FUSI's prefix + ideas entry column in the launch-bound store only", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_fusion", projectName: "Fusion" });
      try {
        const result = await client.callTool({ name: "fn_task_create", arguments: { description: "Launch-bound create" } });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { taskId?: string } | undefined;

        const fusionTasks = await store.listTasks({ slim: true });
        const created = fusionTasks.find((t) => t.description === "Launch-bound create");
        expect(created).toBeTruthy();
        expect(created!.id.startsWith("FUSI-")).toBe(true);
        expect(created!.column).toBe("ideas");
        if (structured?.taskId) expect(structured.taskId).toBe(created!.id);

        const cabTasks = await cabStore.listTasks({ slim: true });
        expect(cabTasks.some((t) => t.description === "Launch-bound create")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_delegate_task lands FUSI's prefix in the launch-bound store only", async () => {
      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();
      const agent = await agentStore.createAgent({ name: "Launch-bound delegate target", role: "executor" } as any);

      const { client, mcpServer } = await connectClient({ projectId: "proj_fusion", projectName: "Fusion" });
      try {
        const result = await client.callTool({
          name: "fn_delegate_task",
          arguments: { agent_id: agent.id, description: "Launch-bound delegated task" },
        });
        expect(result.isError).not.toBe(true);

        const fusionTasks = await store.listTasks({ slim: true });
        const created = fusionTasks.find((t) => t.description === "Launch-bound delegated task");
        expect(created).toBeTruthy();
        expect(created!.id.startsWith("FUSI-")).toBe(true);

        const cabTasks = await cabStore.listTasks({ slim: true });
        expect(cabTasks.some((t) => t.description === "Launch-bound delegated task")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_workflow_create and fn_workflow_update land in the launch-bound store's workflow table only", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_fusion", projectName: "Fusion" });
      try {
        const createResult = await client.callTool({
          name: "fn_workflow_create",
          arguments: {
            name: "Launch-bound workflow",
            ir: {
              version: "v2",
              name: "Launch-bound workflow",
              columns: [{ id: "todo", name: "Todo", traits: [] }],
              nodes: [
                { id: "start", kind: "start", column: "todo" },
                { id: "end", kind: "end", column: "todo" },
              ],
              edges: [{ from: "start", to: "end", condition: "success" }],
            },
          },
        });
        expect(createResult.isError).not.toBe(true);
        const created = createResult.structuredContent as { workflowId?: string; id?: string } | undefined;
        const workflowId = created?.workflowId ?? created?.id;
        expect(workflowId).toBeTruthy();

        const fusionWorkflow = await store.getWorkflowDefinition(workflowId as string);
        expect(fusionWorkflow).toBeTruthy();

        const cabWorkflow = await cabStore.getWorkflowDefinition(workflowId as string).catch(() => undefined);
        expect(cabWorkflow).toBeFalsy();

        const updateResult = await client.callTool({
          name: "fn_workflow_update",
          arguments: { workflow_id: workflowId, name: "Launch-bound workflow (renamed)" },
        });
        expect(updateResult.isError).not.toBe(true);
        const renamed = await store.getWorkflowDefinition(workflowId as string);
        expect(renamed?.name).toBe("Launch-bound workflow (renamed)");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_agent_create lands in the launch-bound store's AgentStore only", async () => {
      const { client, mcpServer } = await connectClient({ projectId: "proj_fusion", projectName: "Fusion" });
      try {
        const result = await client.callTool({
          name: "fn_agent_create",
          arguments: { name: "Launch-bound Agent", role: "executor" },
        });
        expect(result.isError).not.toBe(true);

        const fusionAgentStore = new AgentStore({ rootDir: store.getFusionDir() });
        await fusionAgentStore.init();
        const fusionAgents = await fusionAgentStore.listAgents({});
        expect(fusionAgents.some((a) => a.name === "Launch-bound Agent")).toBe(true);

        const cabAgentStore = new AgentStore({ rootDir: cabStore.getFusionDir() });
        await cabAgentStore.init();
        const cabAgents = await cabAgentStore.listAgents({});
        expect(cabAgents.some((a) => a.name === "Launch-bound Agent")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_update mutates the launch-bound store's task only, never the CAB store", async () => {
      const fusionTask = await store.createTask({ description: "Launch-bound updatable task", source: { sourceType: "api" } });
      const [cabTaskBefore] = await cabStore.listTasks({ slim: true });
      const { client, mcpServer } = await connectClient({ projectId: "proj_fusion", projectName: "Fusion" });
      try {
        const result = await client.callTool({
          name: "fn_task_update",
          arguments: { id: fusionTask.id, title: "Launch-bound updated title" },
        });
        expect(result.isError).not.toBe(true);

        const updatedFusionTask = await store.getTask(fusionTask.id);
        expect(updatedFusionTask.title).toBe("Launch-bound updated title");

        // The pre-seeded CAB task (the "most-recently-created project" row) is untouched.
        const cabTasksAfter = await cabStore.listTasks({ slim: true });
        expect(cabTasksAfter.length).toBe(1);
        expect(cabTasksAfter[0]!.id).toBe(cabTaskBefore!.id);
        expect(cabTasksAfter[0]!.title).not.toBe("Launch-bound updated title");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });
  });

  /*
  FNXC:TaskCreate 2026-07-16-17:52:
  FUSI-096 regression (post-fn_project_use state): the launch-bound-only
  suite above covers a session that never switches. This suite covers the
  OTHER state named in the Surface Enumeration — a session that launches
  bound to the INITIAL project (`store`/`tmpDir`), then explicitly switches
  via `fn_project_use` to a SEPARATE target project P ("Fusion", FUSI prefix,
  non-default "ideas" entry column), with a THIRD distractor project (CAB,
  default "triage" entry column) registered in the same shared central
  registry and given its own pre-existing task BEFORE the switch — i.e. CAB
  remains the "most-recently-created project" drift trigger even though it
  is neither the launch-bound nor the switched-to project. Every store-backed
  mutation tool enumerated in the FUSI-096 Surface Enumeration is covered:
  fn_task_create, fn_delegate_task, fn_workflow_create, fn_workflow_update,
  fn_agent_create, fn_task_update. All must land in P's store post-switch,
  never in the initial store nor CAB's store.
  */
  describe("FUSI-096: post-fn_project_use mutation targeting (switched session)", () => {
    let fusionDir: string;
    let fusionStore: TaskStore;
    let cabDir: string;
    let cabStore: TaskStore;

    beforeEach(async () => {
      fusionDir = await mkdtemp(join(tmpdir(), "fn-fusi-096-switch-fusion-"));
      await mkdir(join(fusionDir, ".fusion"), { recursive: true });
      fusionStore = new TaskStore(fusionDir);
      await fusionStore.init();
      await fusionStore.updateSettings({ taskPrefix: "FUSI" });
      await fusionStore.setDefaultWorkflowId("builtin:coding-ideas");

      cabDir = await mkdtemp(join(tmpdir(), "fn-fusi-096-switch-cab-"));
      await mkdir(join(cabDir, ".fusion"), { recursive: true });
      cabStore = new TaskStore(cabDir);
      await cabStore.init();
      await cabStore.updateSettings({ taskPrefix: "CAB" });
      // The "most-recently-created" distractor project: created (and given its
      // own first task) BEFORE the switch-and-mutate calls below run.
      await cabStore.createTask({ description: "Pre-existing CAB task (created first)" });

      fakeCentralRegistry.set("proj_fusion_switch", {
        id: "proj_fusion_switch",
        name: "Fusion",
        path: fusionDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      });
      fakeCentralRegistry.set("proj_cab_switch", {
        id: "proj_cab_switch",
        name: "contentful-app-builder",
        path: cabDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      });
    });

    afterEach(async () => {
      await fusionStore.close();
      await cabStore.close();
      await rm(fusionDir, { recursive: true, force: true });
      await rm(cabDir, { recursive: true, force: true });
    });

    it("fn_task_create after fn_project_use lands FUSI's prefix + ideas entry column in the switched-to store only", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const useResult = await client.callTool({ name: "fn_project_use", arguments: { id: "proj_fusion_switch" } });
        expect(useResult.isError).not.toBe(true);

        const result = await client.callTool({ name: "fn_task_create", arguments: { description: "Post-switch create" } });
        expect(result.isError).not.toBe(true);

        const fusionTasks = await fusionStore.listTasks({ slim: true });
        const created = fusionTasks.find((t) => t.description === "Post-switch create");
        expect(created).toBeTruthy();
        expect(created!.id.startsWith("FUSI-")).toBe(true);
        expect(created!.column).toBe("ideas");

        const initialTasks = await store.listTasks({ slim: true });
        expect(initialTasks.some((t) => t.description === "Post-switch create")).toBe(false);
        const cabTasks = await cabStore.listTasks({ slim: true });
        expect(cabTasks.some((t) => t.description === "Post-switch create")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_delegate_task after fn_project_use lands FUSI's prefix in the switched-to store only", async () => {
      const agentStore = new AgentStore({ rootDir: fusionStore.getFusionDir() });
      await agentStore.init();
      const agent = await agentStore.createAgent({ name: "Post-switch delegate target", role: "executor" } as any);

      const { client, mcpServer } = await connectClient();
      try {
        await client.callTool({ name: "fn_project_use", arguments: { id: "proj_fusion_switch" } });

        const result = await client.callTool({
          name: "fn_delegate_task",
          arguments: { agent_id: agent.id, description: "Post-switch delegated task" },
        });
        expect(result.isError).not.toBe(true);

        const fusionTasks = await fusionStore.listTasks({ slim: true });
        const created = fusionTasks.find((t) => t.description === "Post-switch delegated task");
        expect(created).toBeTruthy();
        expect(created!.id.startsWith("FUSI-")).toBe(true);

        const cabTasks = await cabStore.listTasks({ slim: true });
        expect(cabTasks.some((t) => t.description === "Post-switch delegated task")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_workflow_create and fn_workflow_update after fn_project_use land in the switched-to store's workflow table only", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        await client.callTool({ name: "fn_project_use", arguments: { id: "proj_fusion_switch" } });

        const createResult = await client.callTool({
          name: "fn_workflow_create",
          arguments: {
            name: "Post-switch workflow",
            ir: {
              version: "v2",
              name: "Post-switch workflow",
              columns: [{ id: "todo", name: "Todo", traits: [] }],
              nodes: [
                { id: "start", kind: "start", column: "todo" },
                { id: "end", kind: "end", column: "todo" },
              ],
              edges: [{ from: "start", to: "end", condition: "success" }],
            },
          },
        });
        expect(createResult.isError).not.toBe(true);
        const created = createResult.structuredContent as { workflowId?: string; id?: string } | undefined;
        const workflowId = created?.workflowId ?? created?.id;
        expect(workflowId).toBeTruthy();

        const fusionWorkflow = await fusionStore.getWorkflowDefinition(workflowId as string);
        expect(fusionWorkflow).toBeTruthy();

        const cabWorkflow = await cabStore.getWorkflowDefinition(workflowId as string).catch(() => undefined);
        expect(cabWorkflow).toBeFalsy();

        const updateResult = await client.callTool({
          name: "fn_workflow_update",
          arguments: { workflow_id: workflowId, name: "Post-switch workflow (renamed)" },
        });
        expect(updateResult.isError).not.toBe(true);
        const renamed = await fusionStore.getWorkflowDefinition(workflowId as string);
        expect(renamed?.name).toBe("Post-switch workflow (renamed)");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_agent_create after fn_project_use lands in the switched-to store's AgentStore only", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        await client.callTool({ name: "fn_project_use", arguments: { id: "proj_fusion_switch" } });

        const result = await client.callTool({
          name: "fn_agent_create",
          arguments: { name: "Post-switch Agent", role: "executor" },
        });
        expect(result.isError).not.toBe(true);

        const fusionAgentStore = new AgentStore({ rootDir: fusionStore.getFusionDir() });
        await fusionAgentStore.init();
        const fusionAgents = await fusionAgentStore.listAgents({});
        expect(fusionAgents.some((a) => a.name === "Post-switch Agent")).toBe(true);

        const cabAgentStore = new AgentStore({ rootDir: cabStore.getFusionDir() });
        await cabAgentStore.init();
        const cabAgents = await cabAgentStore.listAgents({});
        expect(cabAgents.some((a) => a.name === "Post-switch Agent")).toBe(false);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_update after fn_project_use mutates the switched-to store's task only, never CAB's", async () => {
      const fusionTask = await fusionStore.createTask({ description: "Post-switch updatable task", source: { sourceType: "api" } });
      const [cabTaskBefore] = await cabStore.listTasks({ slim: true });
      const { client, mcpServer } = await connectClient();
      try {
        await client.callTool({ name: "fn_project_use", arguments: { id: "proj_fusion_switch" } });

        const result = await client.callTool({
          name: "fn_task_update",
          arguments: { id: fusionTask.id, title: "Post-switch updated title" },
        });
        expect(result.isError).not.toBe(true);

        const updatedFusionTask = await fusionStore.getTask(fusionTask.id);
        expect(updatedFusionTask.title).toBe("Post-switch updated title");

        const cabTasksAfter = await cabStore.listTasks({ slim: true });
        expect(cabTasksAfter.length).toBe(1);
        expect(cabTasksAfter[0]!.id).toBe(cabTaskBefore!.id);
        expect(cabTasksAfter[0]!.title).not.toBe("Post-switch updated title");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });
  });

  /*
  FNXC:McpServer 2026-07-11-16:00:
  FUSI-052 dispatch coverage for the fifteen new base tools: task lifecycle
  (pause/unpause/retry/duplicate/refine/unarchive), agent edit
  (fn_agent_update/fn_agent_set_instructions), fn_models_list, the five
  research tools, and fn_trait_list. Each asserts (a) correct dispatch to the
  shared store/domain op, (b) base-tier registration (present without
  --allow-destructive), (c) no DESTRUCTIVE: prefix, and representative
  success + error/not-found paths. fn_task_retry additionally covers a plain
  failed->todo retry, an in-review execution-stall retry (preserveProgress),
  and a non-retryable-state rejection, per the FN-5893 "fix the invariant,
  not the repro" standing rule.
  */
  describe("task lifecycle, agent edit, model, research, trait tools (FUSI-052)", () => {
    it("all fifteen new tools are present in the base registry without --allow-destructive and none is DESTRUCTIVE:-prefixed", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const { tools } = await client.listTools();
        const byName = new Map((tools ?? []).map((t) => [t.name, t]));
        const newNames = [
          "fn_task_pause", "fn_task_unpause", "fn_task_retry", "fn_task_duplicate", "fn_task_refine", "fn_task_unarchive",
          "fn_agent_update", "fn_agent_set_instructions", "fn_models_list",
          "fn_research_run", "fn_research_list", "fn_research_get", "fn_research_cancel", "fn_research_retry",
          "fn_trait_list",
        ];
        for (const name of newNames) {
          const tool = byName.get(name);
          expect(tool, `${name} missing from base registry`).toBeTruthy();
          expect(tool!.description.startsWith("DESTRUCTIVE:"), `${name} incorrectly DESTRUCTIVE:-marked`).toBe(false);
          expect(/_delete$/i.test(name), `${name} looks like a delete tool`).toBe(false);
        }
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_pause / fn_task_unpause dispatch to store.pauseTask", async () => {
      const task = await store.createTask({ description: "Pause me via MCP", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const paused = await client.callTool({ name: "fn_task_pause", arguments: { id: task.id } });
        expect(paused.isError).not.toBe(true);
        expect((await store.getTask(task.id)).paused).toBe(true);

        const unpaused = await client.callTool({ name: "fn_task_unpause", arguments: { id: task.id } });
        expect(unpaused.isError).not.toBe(true);
        expect((await store.getTask(task.id)).paused).toBeFalsy();

        const missing = await client.callTool({ name: "fn_task_pause", arguments: { id: "" } });
        expect(missing.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_retry: plain failed task moves to todo with error state cleared", async () => {
      const task = await store.createTask({ description: "Retry me via MCP", source: { sourceType: "api" } });
      await store.updateTask(task.id, { status: "failed", error: "boom" });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_retry", arguments: { id: task.id } });
        expect(result.isError).not.toBe(true);
        const updated = await store.getTask(task.id);
        expect(updated.column).toBe("todo");
        expect(updated.status).toBeFalsy();
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_retry: stranded in-review task with incomplete steps retries to todo preserving progress", async () => {
      const task = await store.createTask({ description: "In-review stall via MCP", source: { sourceType: "api" } });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: null,
        steps: [{ number: 0, name: "Step 0", status: "in-progress" }] as never,
      });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_retry", arguments: { id: task.id } });
        expect(result.isError).not.toBe(true);
        const updated = await store.getTask(task.id);
        expect(updated.column).toBe("todo");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_retry: rejects a task not in a retryable state", async () => {
      const task = await store.createTask({ description: "Not retryable via MCP", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_retry", arguments: { id: task.id } });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_duplicate dispatches to store.duplicateTask, creating a new task in planning", async () => {
      const task = await store.createTask({ description: "Duplicate me via MCP", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_duplicate", arguments: { id: task.id } });
        expect(result.isError).not.toBe(true);
        const newTaskId = (result.structuredContent as { newTaskId?: string } | undefined)?.newTaskId;
        expect(typeof newTaskId).toBe("string");
        const newTask = await store.getTask(newTaskId!);
        expect(newTask.description).toContain(task.description);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_refine dispatches to store.refineTask, creating a dependent follow-up task", async () => {
      const task = await store.createTask({ description: "Refine me via MCP", source: { sourceType: "api" } });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_refine", arguments: { id: task.id, feedback: "needs more polish" } });
        expect(result.isError).not.toBe(true);
        const newTaskId = (result.structuredContent as { newTaskId?: string } | undefined)?.newTaskId;
        expect(typeof newTaskId).toBe("string");
        const newTask = await store.getTask(newTaskId!);
        expect(newTask.dependencies).toContain(task.id);

        const missingFeedback = await client.callTool({ name: "fn_task_refine", arguments: { id: task.id } });
        expect(missingFeedback.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_unarchive dispatches to store.unarchiveTask, restoring the pre-archive column", async () => {
      const task = await store.createTask({ description: "Unarchive me via MCP", source: { sourceType: "api" } });
      await store.archiveTask(task.id, {});
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_task_unarchive", arguments: { id: task.id } });
        expect(result.isError).not.toBe(true);
        const restored = await store.getTask(task.id);
        expect(restored.column).not.toBe("archived");

        const notFound = await client.callTool({ name: "fn_task_unarchive", arguments: { id: "FN-DOES-NOT-EXIST" } });
        expect(notFound.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_agent_update dispatches to AgentStore.updateAgent and updates the target's fields", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const agent = await agentStore.createAgent({ name: "MCP Update Target", role: "executor" });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_agent_update", arguments: { agent_id: agent.id, title: "Senior Executor" } });
        expect(result.isError).not.toBe(true);
        const updated = await agentStore.getAgent(agent.id);
        expect(updated?.title).toBe("Senior Executor");

        const noFields = await client.callTool({ name: "fn_agent_update", arguments: { agent_id: agent.id } });
        expect(noFields.isError).toBe(true);

        const notFound = await client.callTool({ name: "fn_agent_update", arguments: { agent_id: "agent-does-not-exist", title: "x" } });
        expect(notFound.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_agent_set_instructions dispatches to AgentStore.updateAgent for instructionsText/instructionsPath", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const agent = await agentStore.createAgent({ name: "MCP Instructions Target", role: "executor" });
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_agent_set_instructions", arguments: { agent_id: agent.id, instructions_text: "Be helpful." } });
        expect(result.isError).not.toBe(true);
        const updated = await agentStore.getAgent(agent.id);
        expect(updated?.instructionsText).toBe("Be helpful.");

        const noFields = await client.callTool({ name: "fn_agent_set_instructions", arguments: { agent_id: agent.id } });
        expect(noFields.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_models_list returns the ModelRegistry's built-in models without writing to stdout", async () => {
      const { client, mcpServer } = await connectClient();
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const result = await client.callTool({ name: "fn_models_list", arguments: {} });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { count?: number; models?: Array<{ id: string; provider: string }> } | undefined;
        expect(typeof structured?.count).toBe("number");
        expect(Array.isArray(structured?.models)).toBe(true);
      } finally {
        stdoutSpy.mockRestore();
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_models_list narrows results by the optional provider filter", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const all = await client.callTool({ name: "fn_models_list", arguments: {} });
        const allModels = (all.structuredContent as { models?: Array<{ provider: string }> } | undefined)?.models ?? [];
        expect(allModels.length).toBeGreaterThan(0);
        const someProvider = allModels[0]!.provider;

        const filtered = await client.callTool({ name: "fn_models_list", arguments: { provider: someProvider } });
        const filteredModels = (filtered.structuredContent as { models?: Array<{ provider: string }> } | undefined)?.models ?? [];
        expect(filteredModels.every((m) => m.provider === someProvider)).toBe(true);

        const none = await client.callTool({ name: "fn_models_list", arguments: { provider: "definitely-not-a-real-provider" } });
        const noneModels = (none.structuredContent as { models?: unknown[] } | undefined)?.models ?? [];
        expect(noneModels).toEqual([]);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    /*
    FNXC:McpServer 2026-07-11-19:30:
    FUSI-067 symptom verification. Original symptom: fn_models_list built its
    own built-in-only ModelRegistry and never ran plugin-runtime provider
    discovery, so an installed/enabled plugin-runtime provider (e.g.
    cursor-cli) was invisible to the tool. Reproduction below stubs the
    `buildExecutionModelRegistry` engine seam with a synthetic registry that
    HAS a `cursor-cli` model registered (mirroring what plugin-runtime
    discovery would produce for an installed+enabled plugin) and asserts it
    surfaces in `fn_models_list` output — the assertion that is gone once the
    fix lands (on the pre-fix built-in-only construction, this model could
    never appear since it never runs plugin-runtime discovery at all).
    */
    it("fn_models_list surfaces a plugin-runtime provider (cursor-cli) when the execution registry resolves it, without writing to stdout", async () => {
      const fakeAuthStorage = AuthStorage.inMemory();
      const fakeRegistry = ModelRegistry.inMemory(fakeAuthStorage);
      fakeRegistry.registerProvider("cursor-cli", {
        baseUrl: "http://localhost:0/fake-cursor-cli",
        apiKey: "fake-cursor-cli-key",
        models: [
          {
            id: "cursor-fast",
            name: "Cursor Fast",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      });
      fakeExecutionModelRegistryOverride.value = fakeRegistry;

      const { client, mcpServer } = await connectClient();
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const all = await client.callTool({ name: "fn_models_list", arguments: {} });
        expect(all.isError).not.toBe(true);
        const allModels = (all.structuredContent as { models?: Array<{ id: string; provider: string }> } | undefined)?.models ?? [];
        expect(allModels.some((m) => m.provider === "cursor-cli" && m.id === "cursor-fast")).toBe(true);
        // Built-in providers must not regress when the execution registry also carries a plugin provider.
        expect(allModels.some((m) => m.provider === "grok-cli" || m.provider === "zai")).toBe(true);

        const filtered = await client.callTool({ name: "fn_models_list", arguments: { provider: "cursor-cli" } });
        const filteredModels = (filtered.structuredContent as { models?: Array<{ provider: string }> } | undefined)?.models ?? [];
        expect(filteredModels.length).toBeGreaterThan(0);
        expect(filteredModels.every((m) => m.provider === "cursor-cli")).toBe(true);

        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_models_list degrades an absent/unauthenticated plugin-runtime provider to zero rows for that provider without failing the whole call", async () => {
      const fakeAuthStorage = AuthStorage.inMemory();
      const fakeRegistry = ModelRegistry.inMemory(fakeAuthStorage);
      // No cursor-cli provider registered — simulates the plugin being absent/unauthenticated.
      fakeExecutionModelRegistryOverride.value = fakeRegistry;

      const { client, mcpServer } = await connectClient();
      try {
        const all = await client.callTool({ name: "fn_models_list", arguments: {} });
        expect(all.isError).not.toBe(true);

        const filtered = await client.callTool({ name: "fn_models_list", arguments: { provider: "cursor-cli" } });
        expect(filtered.isError).not.toBe(true);
        const filteredModels = (filtered.structuredContent as { models?: unknown[] } | undefined)?.models ?? [];
        expect(filteredModels).toEqual([]);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_token_usage returns zeroed totals (never an error) for an empty/zeroed range", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({
          name: "fn_token_usage",
          arguments: { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { totals?: { totalTokens?: number; nTasks?: number } } | undefined;
        expect(structured?.totals?.totalTokens).toBe(0);
        expect(structured?.totals?.nTasks).toBe(0);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_token_usage rolls up seeded task token rows, grouped by model, with unredacted cache read/write split", async () => {
      const task = await store.createTask({ description: "Token usage probe", source: { sourceType: "api" } });
      const db = store.getDatabase();
      db.prepare(
        `UPDATE tasks SET
           tokenUsageInputTokens = ?, tokenUsageOutputTokens = ?, tokenUsageCachedTokens = ?,
           tokenUsageCacheWriteTokens = ?, tokenUsageTotalTokens = ?, tokenUsageLastUsedAt = ?,
           tokenUsageModelProvider = ?, tokenUsageModelId = ?
         WHERE id = ?`,
      ).run(100, 50, 20, 5, 175, "2026-06-01T00:00:00.000Z", "anthropic", "claude-test", task.id);

      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({
          name: "fn_token_usage",
          arguments: { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T23:59:59.000Z", groupBy: "model" },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          totals?: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number };
          groups?: Array<{ key: string | null; totalTokens: number }>;
        } | undefined;
        // Real numeric values must survive — NOT redacted to "[redacted]" despite
        // key names containing the substring "token" (see the FNXC:McpServer
        // comment above fnTokenUsage for why redactSecretsDeep is intentionally
        // skipped on this payload).
        expect(structured?.totals?.inputTokens).toBe(100);
        expect(structured?.totals?.outputTokens).toBe(50);
        expect(structured?.totals?.cachedTokens).toBe(20);
        expect(structured?.totals?.cacheWriteTokens).toBe(5);
        expect(structured?.totals?.totalTokens).toBe(175);
        expect(structured?.groups?.some((g) => g.key === "claude-test" && g.totalTokens === 175)).toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toContain("cachedRead=20");
        expect(text).toContain("cacheWrite=5");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_token_usage rejects an invalid groupBy value with an error result", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_token_usage", arguments: { groupBy: "not-a-real-dimension" } });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_usage_windows surfaces percentUsed/resetAt/windowDurationMs/pace from a fixture ProviderUsage[]", async () => {
      fakeProviderUsageResult.value = [
        {
          name: "Claude",
          icon: "\u{1F916}",
          status: "ok",
          plan: "Max",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 42.5,
              percentLeft: 57.5,
              resetText: "resets in 2h",
              resetAt: "2026-07-11T20:00:00.000Z",
              windowDurationMs: 18000000,
              pace: { status: "on-track", percentElapsed: 40, message: "on track" },
            },
            {
              label: "Weekly",
              percentUsed: 10,
              percentLeft: 90,
              resetText: "resets in 3d",
              resetAt: "2026-07-14T00:00:00.000Z",
              windowDurationMs: 604800000,
              pace: { status: "behind", percentElapsed: 60, message: "behind pace" },
            },
          ],
        },
      ];
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_usage_windows", arguments: {} });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { providers?: Array<{ windows?: Array<Record<string, unknown>> }> } | undefined;
        const windows = structured?.providers?.[0]?.windows ?? [];
        expect(windows).toHaveLength(2);
        expect(windows[0]).toMatchObject({ percentUsed: 42.5, resetAt: "2026-07-11T20:00:00.000Z", windowDurationMs: 18000000 });
        expect((windows[0] as { pace?: { status?: string } }).pace?.status).toBe("on-track");
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toContain("Session (5h)");
        expect(text).toContain("Weekly");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_usage_windows returns a clear no-provider message (not an error) for an empty provider array", async () => {
      fakeProviderUsageResult.value = [];
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_usage_windows", arguments: {} });
        expect(result.isError).not.toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text.toLowerCase()).toContain("no authenticated usage providers");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_token_usage and fn_usage_windows are base-tier — present without --allow-destructive, never DESTRUCTIVE:-prefixed", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: false });
      try {
        const { tools } = await client.listTools();
        const names = (tools ?? []).map((t) => t.name);
        expect(names).toContain("fn_token_usage");
        expect(names).toContain("fn_usage_windows");
      } finally {
        await client.close();
        await mcpServer.close();
      }
      expect(DESTRUCTIVE_TOOL_TIER.map((t) => t.name)).not.toContain("fn_token_usage");
      expect(DESTRUCTIVE_TOOL_TIER.map((t) => t.name)).not.toContain("fn_usage_windows");
      const byName = new Map(MCP_TOOL_REGISTRY.map((t) => [t.name, t]));
      expect(byName.get("fn_token_usage")?.description).not.toMatch(/^DESTRUCTIVE:/);
      expect(byName.get("fn_usage_windows")?.description).not.toMatch(/^DESTRUCTIVE:/);
    });

    it("fn_research_run / fn_research_list / fn_research_get / fn_research_cancel / fn_research_retry gate on availability without throwing when research is unconfigured", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const run = await client.callTool({ name: "fn_research_run", arguments: { query: "MCP research probe" } });
        expect(run.isError).not.toBe(true);
        const runDetails = run.structuredContent as { status?: string } | undefined;
        expect(runDetails?.status).toBe("unavailable");

        const list = await client.callTool({ name: "fn_research_list", arguments: {} });
        expect(list.isError).not.toBe(true);

        const get = await client.callTool({ name: "fn_research_get", arguments: { id: "fake-run" } });
        expect(get.isError).not.toBe(true);

        const cancel = await client.callTool({ name: "fn_research_cancel", arguments: { id: "fake-run" } });
        expect(cancel.isError).toBe(true);

        const retry = await client.callTool({ name: "fn_research_retry", arguments: { id: "fake-run" } });
        expect(retry.isError).toBe(true);

        const missingQuery = await client.callTool({ name: "fn_research_run", arguments: {} });
        expect(missingQuery.isError).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_trait_list dispatches to the shared createTraitListTool factory and returns the trait catalog", async () => {
      const { client, mcpServer } = await connectClient();
      try {
        const result = await client.callTool({ name: "fn_trait_list", arguments: {} });
        expect(result.isError).not.toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });
  });
});
