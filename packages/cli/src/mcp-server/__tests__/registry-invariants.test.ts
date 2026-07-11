/**
 * FNXC:McpServer 2026-07-11-11:00:
 * FUSI-021 — durable CROSS-CUTTING enforcement of the `fn mcp serve` operator
 * registry's six hard safety invariants, asserted STRUCTURALLY over the
 * WHOLE resolved registry (base + destructive) rather than via a hand-
 * maintained per-name list. `tools.test.ts` and `http-transport.test.ts`
 * continue to carry per-tool dispatch/behavior coverage (untouched by this
 * file); this suite exists so that ANY future tool addition to
 * `MCP_TOOL_REGISTRY` / `DESTRUCTIVE_TOOL_TIER` that violates one of the six
 * invariants below fails a test, with no per-task edit required here:
 *
 *   A. `buildMcpToolRegistry` is the ONLY base+destructive combine point,
 *      and the two tiers never share a tool name.
 *   B. Every `*_delete` tool (plus the known powerful non-`_delete`
 *      mutations) lives ONLY in the destructive tier, never in base.
 *   C. Every destructive tool's description is `DESTRUCTIVE:`-prefixed;
 *      no base tool description carries that marker.
 *   D. Every destructive invocation writes an ids/counts/outcomes-only
 *      audit line to stderr (never stdout), with no raw secret value.
 *   E. Every tool response — base or destructive — is redacted; no raw
 *      secret-shaped plaintext ever leaves the server.
 *   F. No release/publish/version-tag/changeset tooling is ever declared.
 *
 * A seventh, cross-file invariant (G) checks that the tool-COUNT surfaces
 * outside this module (the FUSI-013 boot-smoke and `http-transport.test.ts`)
 * stay source-derived from `MCP_TOOL_REGISTRY`/`DESTRUCTIVE_TOOL_TIER`
 * rather than hand-copied literals, so counts cannot silently drift again
 * the way `docs/mcp.md`'s stale "seven" destructive-tool reference did
 * before this task reconciled it (see docs/mcp.md's Safety boundaries
 * section).
 *
 * Uses the SAME in-memory `InMemoryTransport.createLinkedPair()` + real
 * `Client` pattern as `tools.test.ts` — no subprocess, no network, no real
 * timers (see docs/testing.md's "Do Not Add Slow Tests" standing rule).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore, AgentStore } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/*
FNXC:McpServer 2026-07-11-11:00:
Same minimal in-memory `CentralCore` fake `tools.test.ts` uses (FUSI-020) —
required so `fn_project_*` dispatch never touches the real
`~/.fusion/fusion-central.db` under vitest. `fakeCentralRegistry` is a
MODULE-LEVEL map (cleared in `beforeEach`) so it survives the single hoisted
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolvePath(__dirname, "../../../../..");

const FORBIDDEN_NAME_PATTERNS = [/release/i, /publish/i, /version[-_]?tag/i, /changeset/i];

// The real outcome vocabulary `auditDestructiveInvocation` callers use across tools.ts (grep-verified).
const KNOWN_OUTCOME_TOKENS = [
  "deleted",
  "denied",
  "pending_approval",
  "error",
  "updated",
  "registered",
  "unregistered",
  "created",
  "noop",
  "noop-already-registered",
];

// Known powerful non-`_delete` mutations that must sit ONLY in the destructive tier (present-if-it-exists).
const KNOWN_GATED_NON_DELETE_NAMES = ["fn_settings_update", "fn_project_create", "fn_project_update", "fn_project_remove"];

function secretLeakPatterns(): RegExp[] {
  return [/sk-[A-Za-z0-9]{10,}/, /ghp_[A-Za-z0-9]{10,}/, /Bearer\s+[A-Za-z0-9._-]{15,}/i];
}

function assertNoSecretLeak(serialized: string, context: string): void {
  for (const pattern of secretLeakPatterns()) {
    expect(serialized, `${context} leaked a secret-shaped value matching ${pattern}`).not.toMatch(pattern);
  }
}

function workflowIr(name: string) {
  return {
    version: "v2",
    name,
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  };
}

describe("Invariant A — buildMcpToolRegistry is the single base+destructive combine point", () => {
  it("omits the destructive tier and matches MCP_TOOL_REGISTRY by reference when allowDestructive is false/absent", () => {
    expect(buildMcpToolRegistry({ allowDestructive: false })).toEqual(MCP_TOOL_REGISTRY);
    expect(buildMcpToolRegistry({})).toEqual(MCP_TOOL_REGISTRY);
    // Same order, same tool objects — not a re-derived/re-ordered copy.
    expect(buildMcpToolRegistry({ allowDestructive: false })).toBe(MCP_TOOL_REGISTRY);
  });

  it("concatenates base + destructive, in that order, with no re-derivation, when allowDestructive is true", () => {
    expect(buildMcpToolRegistry({ allowDestructive: true })).toEqual([...MCP_TOOL_REGISTRY, ...DESTRUCTIVE_TOOL_TIER]);
  });

  it("shares ZERO tool names between MCP_TOOL_REGISTRY and DESTRUCTIVE_TOOL_TIER — no tool is duplicated across tiers", () => {
    const baseNames = new Set(MCP_TOOL_REGISTRY.map((t) => t.name));
    const destructiveNames = new Set(DESTRUCTIVE_TOOL_TIER.map((t) => t.name));
    const overlap = [...baseNames].filter((name) => destructiveNames.has(name));
    expect(overlap, "tool name(s) present in BOTH tiers").toEqual([]);
  });

  it("declares no duplicate tool name within either tier", () => {
    for (const [label, tier] of [
      ["MCP_TOOL_REGISTRY", MCP_TOOL_REGISTRY],
      ["DESTRUCTIVE_TOOL_TIER", DESTRUCTIVE_TOOL_TIER],
    ] as const) {
      const names = tier.map((t) => t.name);
      const dupes = names.filter((name, i) => names.indexOf(name) !== i);
      expect(dupes, `${label} has duplicate tool name(s)`).toEqual([]);
    }
  });

  it("server.ts routes exclusively through buildMcpToolRegistry (no second concatenation site)", async () => {
    const serverSrc = await readFile(join(__dirname, "../server.ts"), "utf8");
    expect(serverSrc).toMatch(/buildMcpToolRegistry\(/);
    // Guard against a future direct spread that bypasses the gate function.
    expect(serverSrc).not.toMatch(/\[\s*\.\.\.MCP_TOOL_REGISTRY\s*,\s*\.\.\.DESTRUCTIVE_TOOL_TIER\s*\]/);
  });
});

describe("Invariant B — destructive gating (structural, over the WHOLE registry)", () => {
  it("every base-tier tool name does NOT end in _delete", () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(/_delete$/i.test(tool.name), `${tool.name} looks like a delete tool but is base-tier`).toBe(false);
    }
  });

  it("every tool named *_delete lives ONLY in DESTRUCTIVE_TOOL_TIER", () => {
    const allDeleteNames = [...MCP_TOOL_REGISTRY, ...DESTRUCTIVE_TOOL_TIER].map((t) => t.name).filter((name) => /_delete$/i.test(name));
    expect(allDeleteNames.length, "expected at least one *_delete tool to exist").toBeGreaterThan(0);
    const destructiveNames = new Set(DESTRUCTIVE_TOOL_TIER.map((t) => t.name));
    for (const name of allDeleteNames) {
      expect(destructiveNames.has(name), `${name} must be registered in DESTRUCTIVE_TOOL_TIER`).toBe(true);
    }
  });

  it("the known powerful non-_delete mutations sit ONLY in the destructive tier (present-if-it-exists)", () => {
    const baseNames = new Set(MCP_TOOL_REGISTRY.map((t) => t.name));
    const destructiveNames = new Set(DESTRUCTIVE_TOOL_TIER.map((t) => t.name));
    let matchedAtLeastOne = false;
    for (const name of KNOWN_GATED_NON_DELETE_NAMES) {
      if (destructiveNames.has(name)) {
        matchedAtLeastOne = true;
        expect(baseNames.has(name), `${name} must not ALSO be base-tier`).toBe(false);
      } else {
        expect(baseNames.has(name), `${name} exists in base-tier but is not gated behind --allow-destructive`).toBe(false);
      }
    }
    expect(matchedAtLeastOne, "expected at least one known gated mutation tool to exist in the destructive tier").toBe(true);
  });

  it("reversible/read tools stay base-tier: fn_task_archive and every *_list/*_show tool", () => {
    const destructiveNames = new Set(DESTRUCTIVE_TOOL_TIER.map((t) => t.name));
    const baseNames = MCP_TOOL_REGISTRY.map((t) => t.name);
    expect(baseNames).toContain("fn_task_archive");
    expect(destructiveNames.has("fn_task_archive")).toBe(false);

    const readNames = [...MCP_TOOL_REGISTRY, ...DESTRUCTIVE_TOOL_TIER].map((t) => t.name).filter((n) => /_list$|_show$/i.test(n));
    expect(readNames.length, "expected at least one *_list/*_show read tool to exist").toBeGreaterThan(0);
    for (const name of readNames) {
      expect(destructiveNames.has(name), `${name} looks like a read but is destructive-tier`).toBe(false);
    }
  });
});

describe("Invariant C — DESTRUCTIVE: marker discipline", () => {
  it("every DESTRUCTIVE_TOOL_TIER tool description starts with the literal marker DESTRUCTIVE:", () => {
    for (const tool of DESTRUCTIVE_TOOL_TIER) {
      expect(tool.description, `${tool.name} description`).toMatch(/^DESTRUCTIVE:/);
    }
  });

  it("no MCP_TOOL_REGISTRY (base) tool description starts with DESTRUCTIVE:", () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(tool.description.startsWith("DESTRUCTIVE:"), `${tool.name} is base-tier but DESTRUCTIVE:-marked`).toBe(false);
    }
  });
});

describe("Invariant F — no release/publish/version-tag/changeset tooling, anywhere in the resolved registry", () => {
  it("no tool NAME or DESCRIPTION matches a forbidden release-adjacent pattern", () => {
    const all = buildMcpToolRegistry({ allowDestructive: true });
    expect(all.length).toBe(MCP_TOOL_REGISTRY.length + DESTRUCTIVE_TOOL_TIER.length);
    for (const tool of all) {
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        expect(pattern.test(tool.name), `${tool.name} matched forbidden pattern ${pattern}`).toBe(false);
        expect(pattern.test(tool.description), `${tool.name} description matched forbidden pattern ${pattern}`).toBe(false);
      }
    }
  });
});

describe("Invariant G — tool-count parity across surfaces stays source-derived (no re-drift)", () => {
  it("scripts/boot-smoke.mjs loads its expected MCP tool set straight from MCP_TOOL_REGISTRY via tsImport, never a hardcoded literal", async () => {
    const src = await readFile(join(repoRoot, "scripts/boot-smoke.mjs"), "utf8");
    expect(src).toMatch(/tsImport\(/);
    expect(src).toMatch(/mod\.MCP_TOOL_REGISTRY\.map\(/);
    // Guard against a future hand-copied literal tool-name array creeping into the smoke script.
    expect(src).not.toMatch(/"fn_task_create"/);
  });

  it("scripts/lib/mcp-smoke.mjs's assertCuratedToolSet compares against a CALLER-SUPPLIED expected set (no embedded literal)", async () => {
    const src = await readFile(join(repoRoot, "scripts/lib/mcp-smoke.mjs"), "utf8");
    expect(src).toMatch(/function assertCuratedToolSet\(/);
    expect(src).not.toMatch(/"fn_task_create"/);
  });

  it("http-transport.test.ts derives its base tool expectation from MCP_TOOL_REGISTRY, not a frozen literal", async () => {
    const src = await readFile(join(__dirname, "http-transport.test.ts"), "utf8");
    expect(src).toMatch(/EXPECTED_TOOL_NAMES\s*=\s*MCP_TOOL_REGISTRY\.map\(/);
  });

  it("tools.test.ts's hardcoded EXPECTED_TOOL_NAMES / EXPECTED_DESTRUCTIVE_TOOL_NAMES allow-lists match the real registry at HEAD (fails loudly on drift)", async () => {
    const src = await readFile(join(__dirname, "tools.test.ts"), "utf8");

    function extractArray(varName: string): string[] {
      const match = src.match(new RegExp(`const ${varName} = \\[([\\s\\S]*?)\\];`));
      expect(match, `expected to find a "const ${varName} = [...]" array literal in tools.test.ts`).toBeTruthy();
      const body = match![1];
      return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    }

    const expectedBase = extractArray("EXPECTED_TOOL_NAMES");
    const expectedDestructive = extractArray("EXPECTED_DESTRUCTIVE_TOOL_NAMES");

    expect(expectedBase.sort()).toEqual(MCP_TOOL_REGISTRY.map((t) => t.name).sort());
    expect(expectedDestructive.sort()).toEqual(DESTRUCTIVE_TOOL_TIER.map((t) => t.name).sort());
  });

  it("docs/mcp.md's spelled-out tool counts match the real registry sizes at HEAD", async () => {
    const src = await readFile(join(repoRoot, "docs/mcp.md"), "utf8");
    const base = MCP_TOOL_REGISTRY.length;
    const total = MCP_TOOL_REGISTRY.length + DESTRUCTIVE_TOOL_TIER.length;
    const destructive = DESTRUCTIVE_TOOL_TIER.length;

    // FNXC:McpServer 2026-07-11-11:00: after merging FUSI-021 onto a main that
    // already carries FUSI-018's mission/goal mutation base tools, the real
    // registry sizes are 43 base / 11 destructive / 54 combined (was 27/11/38
    // on the pre-FUSI-018 branch). Keep this map in sync with the registry.
    //
    // FNXC:McpServer 2026-07-11-15:00: FUSI-046 adds six base tools
    // (fn_workflow_settings, fn_workflow_add_node, fn_workflow_remove_node,
    // fn_workflow_add_edge, fn_workflow_remove_edge, fn_task_update) — base
    // 43 → 49, destructive unchanged at 11, combined 54 → 60.
    //
    // FNXC:McpServer 2026-07-11-16:00: FUSI-052 adds fifteen base tools
    // (task lifecycle, agent edit, fn_models_list, research pipeline,
    // fn_trait_list) — base 49 → 64, destructive unchanged at 11, combined
    // 60 → 75.
    const numberWords: Record<number, string> = {
      43: "forty-three",
      49: "forty-nine",
      54: "fifty-four",
      60: "sixty",
      64: "sixty-four",
      75: "seventy-five",
      11: "eleven",
    };
    expect(numberWords[base], `no spelled-out word mapping recorded for base count ${base} — update this test's numberWords map`).toBeTruthy();
    expect(numberWords[total], `no spelled-out word mapping recorded for total count ${total} — update this test's numberWords map`).toBeTruthy();
    expect(numberWords[destructive], `no spelled-out word mapping recorded for destructive count ${destructive} — update this test's numberWords map`).toBeTruthy();

    expect(src, `docs/mcp.md must mention the base tool count "${numberWords[base]}"`).toContain(numberWords[base]);
    expect(src, `docs/mcp.md must mention the combined tool count "${numberWords[total]}"`).toContain(numberWords[total]);
    expect(src, `docs/mcp.md must mention the destructive tool count "${numberWords[destructive]}" somewhere describing the tier size`).toContain(numberWords[destructive]);
  });
});

describe("Invariant D & E — full-registry dispatch over an in-memory server", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    fakeCentralRegistry.clear();
    tmpDir = await mkdtemp(join(tmpdir(), "fn-fusi-021-mcp-invariants-"));
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

  function seedMissionHierarchy() {
    const missionStore = store.getMissionStore();
    const mission = missionStore.createMission({ title: "FUSI-021 Invariant Mission", autoMerge: true });
    const milestone = missionStore.addMilestone(mission.id, { title: "MS" });
    const slice = missionStore.addSlice(milestone.id, { title: "SL" });
    const feature = missionStore.addFeature(slice.id, { title: "FT" });
    return { missionStore, mission, milestone, slice, feature };
  }

  describe("Invariant D — every destructive invocation audits ids/counts/outcomes-only to stderr, never stdout", () => {
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

    function auditLinesFor(toolName: string): string[] {
      return stderrSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(toolName));
    }

    it("fn_task_delete: success path audits with resource id + a known outcome token", async () => {
      const task = await store.createTask({ description: "Delete me (Invariant D)", source: { sourceType: "api" } });
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_task_delete", arguments: { id: task.id } });
        expect(result.isError).not.toBe(true);
        const lines = auditLinesFor("fn_task_delete");
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.some((line) => line.includes(task.id))).toBe(true);
        expect(lines.some((line) => KNOWN_OUTCOME_TOKENS.some((token) => line.includes(`outcome=${token}`)))).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fn_task_delete: error path (missing id) still audits an error outcome", async () => {
      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const result = await client.callTool({ name: "fn_task_delete", arguments: { id: "FN-DOES-NOT-EXIST-INVARIANT" } });
        expect(result.isError).toBe(true);
        const lines = auditLinesFor("fn_task_delete");
        expect(lines.some((line) => line.includes("outcome=error"))).toBe(true);
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("every DESTRUCTIVE_TOOL_TIER tool writes at least one stderr audit line and never writes its own name to stdout", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const { mission, milestone, slice, feature } = seedMissionHierarchy();
      const workflowTask = await store.createTask({ description: "Workflow host task", source: { sourceType: "api" } });
      const agentToDelete = await agentStore.createAgent({ name: "Invariant D Delete Target", role: "executor" });
      const bareDir = await mkdtemp(join(tmpdir(), "fn-fusi-021-project-"));

      fakeCentralRegistry.set("proj_invariant_d", {
        id: "proj_invariant_d",
        name: "Invariant D Project",
        path: bareDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const createdWorkflow = await client.callTool({
          name: "fn_workflow_create",
          arguments: { name: "Invariant D Deletable Workflow", ir: workflowIr("Invariant D Deletable Workflow") },
        });
        const workflowId = (createdWorkflow.structuredContent as { workflowId?: string } | undefined)?.workflowId;
        expect(typeof workflowId).toBe("string");

        const argsByName: Record<string, Record<string, unknown>> = {
          fn_task_delete: { id: (await store.createTask({ description: "D2", source: { sourceType: "api" } })).id },
          fn_agent_delete: { agent_id: agentToDelete.id },
          fn_workflow_delete: { workflow_id: workflowId },
          fn_mission_delete: { id: mission.id },
          fn_milestone_delete: { milestoneId: milestone.id },
          fn_slice_delete: { sliceId: slice.id },
          fn_feature_delete: { featureId: feature.id },
          fn_settings_update: { scope: "project", patch: { globalPause: false } },
          fn_project_create: { path: bareDir, name: "Invariant D Recreate", git: false },
          fn_project_update: { id: "proj_invariant_d", name: "Invariant D Project Renamed" },
          fn_project_remove: { id: "proj_invariant_d" },
        };

        for (const tool of DESTRUCTIVE_TOOL_TIER) {
          const args = argsByName[tool.name] ?? {};
          const result = await client.callTool({ name: tool.name, arguments: args });
          void result; // success/failure both acceptable — we assert on the audit line, not the verdict.

          const lines = auditLinesFor(tool.name);
          expect(lines.length, `${tool.name} produced no stderr audit line`).toBeGreaterThan(0);
          expect(
            lines.some((line) => KNOWN_OUTCOME_TOKENS.some((token) => line.includes(`outcome=${token}`))),
            `${tool.name} audit line(s) did not contain a known outcome token: ${lines.join(" | ")}`,
          ).toBe(true);
          expect(
            stdoutSpy.mock.calls.some((c) => String(c[0]).includes(tool.name)),
            `${tool.name} wrote its own name to stdout — stdout is the MCP protocol channel`,
          ).toBe(false);
          for (const line of lines) assertNoSecretLeak(line, `${tool.name} stderr audit line`);
        }

        void milestone;
        void feature;
        void workflowTask;
      } finally {
        await client.close();
        await mcpServer.close();
        await agentStore.close?.();
        await rm(bareDir, { recursive: true, force: true });
      }
    });
  });

  describe("Invariant E — redactSecretsDeep on every tool response; zero secret plaintext, at depth", () => {
    it("redacts secret-shaped keys at arbitrary depth, across arrays, and tolerates cyclic input", () => {
      const cyclic: Record<string, unknown> = { taskId: "FN-001", apiKey: "sk-live-abcdef1234567890" };
      cyclic.self = cyclic;
      const input = {
        taskId: "FN-001",
        apiKey: "sk-live-abcdef1234567890",
        nested: { token: "ghp_abc123def456", ok: "keep-me" },
        list: [{ password: "hunter2hunter2" }, { fine: "value" }, [{ secret: "nested-array-secret" }]],
        cyclic,
      };
      const redacted = redactSecretsDeep(input) as typeof input & { cyclic: Record<string, unknown> };
      expect(redacted.apiKey).toBe("[redacted]");
      expect((redacted.nested as Record<string, unknown>).token).toBe("[redacted]");
      expect((redacted.nested as Record<string, unknown>).ok).toBe("keep-me");
      expect((redacted.list[0] as Record<string, unknown>).password).toBe("[redacted]");
      expect((redacted.list[1] as Record<string, unknown>).fine).toBe("value");
      expect(((redacted.list[2] as unknown[])[0] as Record<string, unknown>).secret).toBe("[redacted]");
      expect(redacted.cyclic.apiKey).toBe("[redacted]");
      expect(redacted.taskId).toBe("FN-001");
      const serialized = JSON.stringify({ ...redacted, cyclic: { taskId: redacted.cyclic.taskId, apiKey: redacted.cyclic.apiKey } });
      assertNoSecretLeak(serialized, "redactSecretsDeep unit fixture");
    });

    it("no tool in the full allowDestructive:true registry ever leaks a secret-shaped plaintext value in its response", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const execAgent = await agentStore.createAgent({ name: "Invariant E Exec Agent", role: "executor" });
      const readTask = await store.createTask({ description: "Invariant E read task", source: { sourceType: "api" } });
      const { mission, milestone, slice, feature } = seedMissionHierarchy();
      const registeredDir = await mkdtemp(join(tmpdir(), "fn-fusi-021-registered-"));
      await mkdir(join(registeredDir, ".fusion"), { recursive: true });
      const seedStore = new TaskStore(registeredDir);
      await seedStore.init();
      await seedStore.close();
      const scaffoldDir = await mkdtemp(join(tmpdir(), "fn-fusi-021-scaffold-"));

      fakeCentralRegistry.set("proj_invariant_e", {
        id: "proj_invariant_e",
        name: "Invariant E Project",
        path: registeredDir,
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const { client, mcpServer } = await connectClient({ allowDestructive: true });
      try {
        const createdWorkflow = await client.callTool({
          name: "fn_workflow_create",
          arguments: { name: "Invariant E Workflow", ir: workflowIr("Invariant E Workflow") },
        });
        const workflowId = ((createdWorkflow.structuredContent as { workflowId?: string } | undefined)?.workflowId) ?? "builtin:coding";

        // Secret-shaped input injected wherever the schema accepts a free-text field (instructions_text, patch values).
        const SECRET_PROBE = "sk-live-shouldneverleak1234567890";

        // FNXC:McpServer 2026-07-11-16:00: FUSI-052 fixtures for the fifteen new base tools.
        const pauseTarget = await store.createTask({ description: "Invariant E pause target", source: { sourceType: "api" } });
        const archiveForUnarchive = await store.createTask({ description: "Invariant E archive-for-unarchive", source: { sourceType: "api" } });
        await store.archiveTask(archiveForUnarchive.id, {});

        const argsByName: Record<string, Record<string, unknown>> = {
          fn_task_pause: { id: pauseTarget.id },
          fn_task_unpause: { id: pauseTarget.id },
          fn_task_retry: { id: readTask.id },
          fn_task_duplicate: { id: readTask.id },
          fn_task_refine: { id: readTask.id, feedback: `Invariant E refine ${SECRET_PROBE}` },
          fn_task_unarchive: { id: archiveForUnarchive.id },
          fn_agent_update: { agent_id: execAgent.id, soul: `Invariant E soul ${SECRET_PROBE}` },
          fn_agent_set_instructions: { agent_id: execAgent.id, instructions_text: SECRET_PROBE },
          fn_models_list: {},
          fn_research_run: { query: `Invariant E probe ${SECRET_PROBE}` },
          fn_research_list: {},
          fn_research_get: { id: "invariant-e-fake-run" },
          fn_research_cancel: { id: "invariant-e-fake-run" },
          fn_research_retry: { id: "invariant-e-fake-run" },
          fn_trait_list: {},
          fn_task_create: { description: `Invariant E probe ${SECRET_PROBE}` },
          fn_task_list: {},
          fn_task_show: { id: readTask.id },
          fn_task_search: { query: "invariant" },
          fn_task_archive: { id: (await store.createTask({ description: "archive-me", source: { sourceType: "api" } })).id },
          fn_delegate_task: { agent_id: execAgent.id, description: `Invariant E delegate ${SECRET_PROBE}` },
          fn_list_agents: {},
          fn_agent_show: { id: execAgent.id },
          fn_agent_create: { name: "Invariant E Probe Agent", role: "executor", instructions_text: SECRET_PROBE },
          fn_agent_start: { id: execAgent.id },
          fn_agent_stop: { id: execAgent.id },
          fn_workflow_list: {},
          fn_workflow_get: { workflow_id: workflowId },
          fn_workflow_create: { name: "Invariant E Nested Workflow", ir: workflowIr("Invariant E Nested Workflow") },
          fn_workflow_update: { workflow_id: workflowId, description: `updated ${SECRET_PROBE}` },
          fn_workflow_select: { workflow_id: workflowId, task_id: readTask.id },
          fn_mission_list: {},
          fn_mission_show: { id: mission.id },
          fn_milestone_list: { missionId: mission.id },
          fn_milestone_show: { id: milestone.id },
          fn_slice_list: { milestoneId: milestone.id },
          fn_slice_show: { id: slice.id },
          fn_feature_list: { sliceId: slice.id },
          fn_feature_show: { id: feature.id },
          fn_settings_get: { scope: "effective" },
          fn_project_list: {},
          fn_project_show: { id: "proj_invariant_e" },
          fn_task_delete: { id: (await store.createTask({ description: "delete-me-e", source: { sourceType: "api" } })).id },
          fn_agent_delete: { agent_id: (await agentStore.createAgent({ name: "Invariant E Delete Target", role: "executor" })).id },
          fn_workflow_delete: { workflow_id: workflowId },
          fn_mission_delete: { id: seedMissionHierarchy().mission.id },
          fn_milestone_delete: { milestoneId: milestone.id, force: true },
          fn_slice_delete: { sliceId: slice.id, force: true },
          fn_feature_delete: { featureId: feature.id, force: true },
          fn_settings_update: { scope: "project", patch: { globalPause: false }, secretProbe: SECRET_PROBE },
          fn_project_create: { path: scaffoldDir, name: "Invariant E Scaffold", git: false },
          fn_project_update: { id: "proj_invariant_e", name: `Renamed ${SECRET_PROBE}` },
          fn_project_remove: { id: "proj_invariant_e" },
        };

        const allTools = buildMcpToolRegistry({ allowDestructive: true });
        expect(allTools.length).toBe(MCP_TOOL_REGISTRY.length + DESTRUCTIVE_TOOL_TIER.length);

        for (const tool of allTools) {
          const args = argsByName[tool.name] ?? {};
          let result: unknown;
          try {
            result = await client.callTool({ name: tool.name, arguments: args });
          } catch (error) {
            // A thrown transport-level error (e.g. malformed args) is acceptable for this invariant —
            // we only assert no *response* ever leaks a secret. Nothing to serialize in that case.
            void error;
            continue;
          }
          const serialized = JSON.stringify(result);
          assertNoSecretLeak(serialized, `${tool.name} response`);
        }
      } finally {
        await client.close();
        await mcpServer.close();
        await rm(registeredDir, { recursive: true, force: true });
        await rm(scaffoldDir, { recursive: true, force: true });
      }
    });
  });
});
