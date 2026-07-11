/**
 * Curated Fusion operator MCP tool registry — the SINGLE source of truth for
 * every tool `fn mcp serve` exposes to an external MCP client (Claude Desktop
 * / Claude Code).
 *
 * FNXC:McpServer 2026-07-10-21:00:
 * Fusion is normally an MCP *client* (packages/engine/src/mcp-session-tools.ts
 * connects out to third-party MCP servers and forwards their tools into AI
 * lanes). This module is the inversion: Fusion becomes an MCP *server* so an
 * operator's own MCP client (Claude Desktop / Claude Code) can drive the
 * Fusion board directly over local stdio. `fn mcp serve` is the only entry
 * point that constructs this registry — it is never reachable over HTTP.
 *
 * FNXC:McpServer 2026-07-10-21:00:
 * Curated v1 allow-list rationale: tasks — fn_task_create, fn_task_list,
 * fn_task_show, fn_task_search, fn_delegate_task; agents — fn_list_agents,
 * fn_agent_show, fn_agent_create, fn_agent_start, fn_agent_stop; workflows —
 * fn_workflow_list, fn_workflow_get, fn_workflow_create, fn_workflow_update,
 * fn_workflow_select. Every handler dispatches to the SAME @fusion/core /
 * @fusion/engine domain operation the pi-extension fn_* tools in
 * packages/cli/src/extension.ts call (via exported shared helpers) — no
 * duplicated validation, no HTTP dashboard round-trip.
 *
 * FNXC:McpServer 2026-07-10-21:00:
 * Trust model: `fn mcp serve` runs as a local stdio subprocess launched
 * directly by the operator's own MCP client with the operator's own OS
 * privileges — every call here is treated as an already-authenticated
 * operator action (mirrors the `{ id: "user", role: "user", isPrivileged:
 * true }` caller shape `fn_agent_create` already uses). There is no
 * additional network-facing auth boundary; do not wire this registry to any
 * network transport (HTTP/SSE) without re-deriving the trust model.
 *
 * FNXC:McpServer 2026-07-10-21:00:
 * Hard safety boundaries enforced by the registry itself (not just by
 * caller discipline): no release/publish/version-tag/`changeset publish`
 * tool is ever declared here (see AGENTS.md "Releasing" — release is
 * operator-only, outside the task loop, and specifically outside this
 * server); no tool result may surface a raw secret value (redacted via
 * {@link redactSecretsDeep} before being serialized into any tool response).
 *
 * FNXC:McpServer 2026-07-10-22:10:
 * FUSI-002 adds the first destructive tier: `fn_task_delete`,
 * `fn_agent_delete`, `fn_workflow_delete` — see {@link DESTRUCTIVE_TOOL_TIER}
 * below. `buildMcpToolRegistry` is the SINGLE place the base v1 set is
 * combined with that tier, and it only ever appends the tier when the
 * caller-supplied `McpToolRuntimeContext.allowDestructive === true` (wired
 * end-to-end from the `fn mcp serve --allow-destructive` CLI flag — see
 * packages/cli/src/bin.ts and packages/cli/src/commands/mcp.ts). Off by
 * default: omitting the flag reproduces the exact FUSI-001 v1 tool set with
 * zero `*_delete` tools. `fn_agent_delete` reuses the SAME
 * `resolveAgentProvisioningPolicy` gate (`deny`/`require-approval`/`allow`)
 * the pi-extension `fn_agent_delete` handler uses — never bypassed. Every
 * destructive invocation writes an ids/counts/outcomes-only audit line to
 * **stderr** (never stdout — stdout is the MCP protocol channel) via
 * {@link auditDestructiveInvocation}.
 *
 * FUSI-005 extends {@link DESTRUCTIVE_TOOL_TIER} to seven tools by adding the
 * mission-hierarchy delete tools `fn_mission_delete`, `fn_milestone_delete`,
 * `fn_slice_delete`, `fn_feature_delete` — same `allowDestructive` gate, same
 * stderr audit convention, no second gate and no new approval hook (see the
 * FNXC:McpServer 2026-07-10-23:45 comment above {@link DESTRUCTIVE_TOOL_TIER}
 * for the recorded design decision).
 *
 * FNXC:McpServer 2026-07-11-08:30:
 * FUSI-017 adds the read half of the mission hierarchy to the BASE registry
 * (base tool count fifteen → sixteen → twenty-four; combined with
 * --allow-destructive: twenty-three → thirty-one): `fn_mission_list`,
 * `fn_mission_show`, `fn_milestone_list`/`fn_milestone_show`,
 * `fn_slice_list`/`fn_slice_show`, `fn_feature_list`/`fn_feature_show`. See
 * the FNXC:McpServer 2026-07-11-08:30 comment above the "Mission hierarchy
 * tools (read-only)" section for the full rationale.
 *
 * FNXC:McpServer 2026-07-11-10:30:
 * FUSI-018 adds the mutation half of the mission hierarchy plus a full goal
 * tool set to the BASE registry (base tool count twenty-four → forty;
 * combined with --allow-destructive: thirty-one → forty-seven):
 * `fn_mission_create`, `fn_mission_update`, `fn_milestone_add`,
 * `fn_milestone_update`, `fn_slice_add`, `fn_slice_activate`,
 * `fn_feature_add`, `fn_feature_update`, `fn_feature_link_task`,
 * `fn_goal_list`, `fn_goal_show`, `fn_goal_create`, `fn_goal_archive`,
 * `fn_mission_link_goal`, `fn_mission_unlink_goal`, `fn_mission_list_goals`.
 * See the FNXC:McpServer 2026-07-11-10:30 comment above the "Mission
 * hierarchy & goal mutation tools" section for the full rationale,
 * including why `fn_goal_archive` (deferred in FUSI-006) is safe to add now.
 *
 * FNXC:McpServer 2026-07-11-09:30:
 * FUSI-019 adds settings read/write on top of FUSI-018's set: `fn_settings_get`
 * (BASE-tier, scope-selected read — `project`/`global`/`effective`) dispatches
 * to the SAME `TaskStore.getSettings()`/`getSettingsByScope()` reads used
 * everywhere else in Fusion, always through {@link redactSecretsDeep} before
 * serialization (settings carry secret-ref/token-bearing fields). Base tool
 * count forty → forty-one; with --allow-destructive: forty-seven →
 * forty-nine. `fn_settings_update` (DESTRUCTIVE tier, gated behind the SAME
 *
 * FNXC:McpServer 2026-07-11-10:00:
 * FUSI-020 adds project registry tools on top of FUSI-019's set:
 * `fn_project_list`/`fn_project_show` (BASE-tier reads over the GLOBAL
 * cross-project `CentralCore` registry — base tool count forty-one →
 * forty-three) plus `fn_project_create`/`fn_project_update`/
 * `fn_project_remove` (DESTRUCTIVE tier — with --allow-destructive:
 * forty-nine → fifty-four). See the FNXC:McpServer 2026-07-11-10:00 comments
 * above the project read/write tool sections for the cross-project
 * blast-radius rationale.
 * `--allow-destructive` flag as the rest of the tier — no second gate) is a
 * SHALLOW scope-selected PATCH via `store.updateSettings(patch)` (project)
 * / `store.updateGlobalSettings(patch)` (global) — it never reads-then-
 * replaces the whole settings object, so the store's own key-filtering/
 * null-delete/merge semantics apply untouched. Its stderr audit line
 * carries the patched key NAMES only, never values (values may be secret-
 * bearing). See the FNXC:McpServer 2026-07-11-09:30 comment above
 * `fnSettingsUpdate` in the destructive-tools section for the full
 * rationale.
 *
 * FNXC:McpServer 2026-07-11-11:00:
 * FUSI-021 is the consolidating quality gate after FUSI-017…020 — it adds NO
 * new tool and no new domain logic. It pins the six invariants documented
 * above STRUCTURALLY, over the WHOLE resolved registry (base + destructive),
 * in `packages/cli/src/mcp-server/__tests__/registry-invariants.test.ts`:
 * (A) `buildMcpToolRegistry` is the ONLY base+destructive combine point and
 * the two tiers never share a tool name; (B) every `*_delete` tool plus the
 * known powerful non-`_delete` mutations (`fn_settings_update`,
 * `fn_project_create`/`update`/`remove`) live ONLY in
 * {@link DESTRUCTIVE_TOOL_TIER}; (C) every destructive description is
 * `DESTRUCTIVE:`-prefixed, no base description is; (D) every destructive
 * invocation writes an ids/counts/outcomes-only {@link auditDestructiveInvocation}
 * line to stderr, never stdout; (E) every tool response — base or
 * destructive — is {@link redactSecretsDeep}-clean of secret-shaped
 * plaintext; (F) no release/publish/version-tag/changeset tooling is ever
 * declared. A future tool addition that violates any of these fails that
 * suite with no per-task edit required here. It also reconciles every
 * stale tool-count reference this task found (docs/mcp.md's "Destructive
 * tools" section undercounted the tier at "seven" instead of the real
 * eleven) and confirms `tools.test.ts`'s hardcoded allow-lists,
 * `http-transport.test.ts`'s source-derived expectation, and the FUSI-013
 * boot-smoke's `tsImport`-sourced expected set all still match
 * `MCP_TOOL_REGISTRY`/`DESTRUCTIVE_TOOL_TIER` at HEAD. After merging with
 * FUSI-018's mission/goal mutation base tools, the current sizes are
 * 43 base / 11 destructive / 54 combined.
 */
import {
  TaskStore,
  AgentStore,
  ApprovalRequestStore,
  CentralCore,
  AGENT_VALID_TRANSITIONS,
  resolveAgentProvisioningPolicy,
  resolveTaskGithubTracking,
  formatCurrentTaskLine,
  TASK_PRIORITIES,
  COLUMNS,
  COLUMN_LABELS,
  ActiveGoalLimitExceededError,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  isValidSqliteDatabaseFile,
  readProjectIdentity,
  writeProjectIdentity,
  validateNodeOverrideChange,
  type Task,
  type ColumnId,
  type TaskPriority,
  type RegisteredProject,
} from "@fusion/core";
import { scaffoldFusionProject } from "../commands/init.js";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { workflowDeleteParams } from "@fusion/engine";
import {
  createWorkflowAuthoringTools,
  workflowListParams,
  workflowGetParams,
  workflowCreateParams,
  workflowUpdateParams,
  workflowSelectParams,
  workflowSettingsParams,
  workflowAddNodeParams,
  workflowRemoveNodeParams,
  workflowAddEdgeParams,
  workflowRemoveEdgeParams,
} from "@fusion/engine";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getFusionDir,
  validateAssignableAgentId,
  normalizeNullableStringInput,
  getTaskSourceLabel,
  formatDuplicateLineageLine,
  columnLabel,
  formatTaskLine,
} from "../extension.js";

/** Runtime context threaded into every MCP tool handler. */
export interface McpToolRuntimeContext {
  /** Resolved project root directory (contains `.fusion/`). */
  cwd: string;
  /*
  FNXC:McpServer 2026-07-10-22:10:
  Off-by-default destructive-tool gate (FUSI-002), wired end-to-end from
  `fn mcp serve --allow-destructive`. Every destructive tool handler MUST
  read this field — never a module-level/global flag — so the gate stays
  provably scoped to one `buildMcpServer(...)` call. Defaults to `false`
  wherever a caller constructs a context directly (e.g. tests).
  */
  allowDestructive?: boolean;
}

/** MCP `content` block — mirrors the SDK's `CallToolResult.content` shape. */
export interface McpToolContentBlock {
  type: "text";
  text: string;
}

/** Result returned by every registry handler; matches MCP's `CallToolResult`. */
export interface McpToolCallResult {
  content: McpToolContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Plain JSON-Schema shape for a tool's input — no zod construction required. */
export interface McpJsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpToolDefinition {
  /** MCP tool name — matches the corresponding fn_* pi tool name 1:1. */
  name: string;
  /** Concise description surfaced to the MCP client / LLM. */
  description: string;
  /** JSON-Schema describing accepted arguments. */
  inputSchema: McpJsonSchema;
  /** Dispatches to the shared @fusion/core / @fusion/engine domain operation. */
  handler: (store: TaskStore, args: Record<string, unknown>, ctx: McpToolRuntimeContext) => Promise<McpToolCallResult>;
}

function textResult(text: string, extra?: Record<string, unknown>): McpToolCallResult {
  return { content: [{ type: "text", text }], ...(extra ?? {}) };
}

function errorResult(text: string, extra?: Record<string, unknown>): McpToolCallResult {
  return { content: [{ type: "text", text: `ERROR: ${text}` }], isError: true, ...(extra ?? {}) };
}

/*
FNXC:McpServer 2026-07-10-21:00:
Defense-in-depth secret redaction applied to every structured payload this
registry serializes into a tool result (e.g. created agent's runtimeConfig,
task metadata). Nothing in the curated v1 allow-list is expected to surface
secret material (secrets tools are intentionally excluded from the
allow-list), but agent/task records are free-form enough that a future field
addition could leak one; walk and redact by key-name heuristic so that risk
never becomes an unredacted MCP response.
*/
const SECRET_KEY_PATTERN = /(secret|token|apikey|api_key|password|passwd|authorization|privatekey|private_key)/i;

export function redactSecretsDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, seen)) as unknown as T;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return value;
    seen.add(obj);
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        result[key] = "[redacted]";
        continue;
      }
      result[key] = redactSecretsDeep(val, seen);
    }
    return result as unknown as T;
  }
  return value;
}

/** Minimal stub satisfying the pi ToolDefinition execute() signature; the
 * workflow-authoring tools bound below never read ctx fields beyond `cwd`. */
function buildStubExtensionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
}

async function getAgentStore(cwd: string): Promise<AgentStore> {
  const agentStore = new AgentStore({ rootDir: getFusionDir(cwd) });
  await agentStore.init();
  return agentStore;
}

// ── Task tools ───────────────────────────────────────────────────────────

const fnTaskCreate: McpToolDefinition = {
  name: "fn_task_create",
  description:
    "Create a new task on the Fusion task board. The task enters the planning column where the AI " +
    "planning agent will plan it into a full prompt with steps, file scope, and acceptance criteria. " +
    "Optionally pass workflow_id to select a workflow at creation time; use fn_workflow_list to discover valid IDs.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "What needs to be done — be descriptive" },
      depends: { type: "array", items: { type: "string" }, description: "Task IDs this depends on (e.g. ['FN-001', 'FN-002'])" },
      agentId: { type: "string", description: "Agent ID to assign this task to (e.g. 'agent-abc123')" },
      priority: { type: "string", enum: [...TASK_PRIORITIES], description: "Task priority (low, normal, high, urgent)" },
      workflow_id: {
        type: "string",
        description:
          "Workflow ID to select for the new task (e.g. 'WF-003' or 'builtin:coding'). Omit to inherit the " +
          "project default workflow. Use fn_workflow_list to discover valid IDs.",
      },
    },
    required: ["description"],
  },
  async handler(store, args, ctx) {
    const description = String(args.description ?? "").trim();
    if (!description) return errorResult("description is required.");

    const normalizedAgentId = normalizeNullableStringInput(
      typeof args.agentId === "string" ? args.agentId : undefined,
    );
    if (normalizedAgentId !== undefined && normalizedAgentId !== null) {
      const candidateTask: Pick<Task, "id" | "column"> = { id: "<new>", column: "todo" };
      const agentError = await validateAssignableAgentId(ctx.cwd, normalizedAgentId, candidateTask);
      if (agentError) return errorResult(agentError);
    }

    try {
      const projectSettings = await store.getSettings();
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      const resolvedTracking = resolveTaskGithubTracking({ githubTracking: undefined }, projectSettings, globalSettings);
      const workflowId = typeof args.workflow_id === "string" ? args.workflow_id.trim() || undefined : undefined;

      const task = await store.createTask({
        description,
        dependencies: Array.isArray(args.depends) ? (args.depends as string[]) : undefined,
        assignedAgentId: normalizedAgentId === null ? undefined : normalizedAgentId,
        priority: typeof args.priority === "string" ? (args.priority as TaskPriority) : undefined,
        ...(workflowId ? { workflowId } : {}),
        source: { sourceType: "api" },
        githubTracking: resolvedTracking.enabled
          ? { enabled: true, ...(resolvedTracking.repo ? { repoOverride: `${resolvedTracking.repo.owner}/${resolvedTracking.repo.repo}` } : {}) }
          : undefined,
      });

      const label = task.description.length > 80 ? task.description.slice(0, 80) + "…" : task.description;
      return textResult(
        `Created ${task.id}: ${label}${workflowId ? ` (workflow: ${workflowId})` : ""}\n` +
          `Column: ${task.column}\n` +
          (task.dependencies.length ? `Dependencies: ${task.dependencies.join(", ")}\n` : "") +
          (task.assignedAgentId ? `Assigned to: ${task.assignedAgentId}\n` : "") +
          `Priority: ${task.priority}`,
        { structuredContent: redactSecretsDeep({ taskId: task.id, column: task.column, dependencies: task.dependencies, priority: task.priority }) },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Task ID already exists:")) {
        return errorResult(error.message);
      }
      throw error;
    }
  },
};

/*
FNXC:McpServer 2026-07-11-15:00:
FUSI-046: `fn_task_list`'s `column` filter/grouping must be WORKFLOW-AWARE,
not hardcoded to the six default columns — a task board using a custom
workflow (e.g. the coding-ideas workflow's `ideas` backlog column) previously
had tasks silently dropped from the unfiltered listing (the `for (const col
of COLUMNS)` grouping loop never visited a non-default column id) and the
`column` param's JSON-Schema `enum: [...COLUMNS]` REJECTED a workflow-specific
filter value outright, so an MCP client could not even ask for `column:
"ideas"`. Fix: (1) drop the rejecting `enum` — accept any column string; (2)
group over the UNION of the six defaults and every DISTINCT `task.column`
value actually present on the board (defaults first, extras after, stable
order), so a workflow-specific column with occupants is always visible
unfiltered and always filterable explicitly. `columnLabel` already falls back
to the raw id for an unknown column, so an unrecognized filter value still
renders (empty result, not a crash) rather than throwing.
*/
const fnTaskList: McpToolDefinition = {
  name: "fn_task_list",
  description:
    "List all tasks on the Fusion board, grouped by column. `column` accepts any of the six default columns " +
    "(todo, planning, in-progress, in-review, done, archived) PLUS any workflow-specific column defined by a " +
    "custom workflow (e.g. an 'ideas' backlog column) — workflow-specific columns are also shown unfiltered.",
  inputSchema: {
    type: "object",
    properties: {
      column: {
        type: "string",
        description:
          "Filter to a specific column. Accepts the six defaults (todo, planning, in-progress, in-review, done, " +
          "archived) or any workflow-specific column id (e.g. 'ideas'). An unrecognized value returns an empty " +
          "result rather than an error.",
      },
      limit: { type: "number", description: "Max tasks to show per column (default: 10)" },
    },
  },
  async handler(store, args) {
    const tasks = await store.listTasks({ slim: true });
    if (tasks.length === 0) return textResult("No tasks yet.", { structuredContent: { count: 0 } });

    const perColumn = typeof args.limit === "number" ? args.limit : 10;
    const requestedColumn = typeof args.column === "string" ? (args.column as ColumnId) : undefined;
    // Union of the six default columns and every distinct column actually
    // present on the board — defaults first (stable, familiar ordering), then
    // any workflow-specific extras in first-seen order — so a task parked in a
    // custom workflow column (e.g. `ideas`) is never silently dropped.
    const extraColumns = [...new Set(tasks.map((t) => t.column))].filter(
      (col) => !(COLUMNS as readonly string[]).includes(col),
    );
    const allColumns: ColumnId[] = [...COLUMNS, ...(extraColumns as ColumnId[])];
    const lines: string[] = [];
    for (const col of allColumns) {
      if (requestedColumn && requestedColumn !== col) continue;
      const colTasks = tasks.filter((t) => t.column === col);
      if (colTasks.length === 0) continue;
      lines.push(`${(COLUMN_LABELS as Record<string, string>)[col] ?? columnLabel(col)} (${colTasks.length}):`);
      const shown = colTasks.slice(0, perColumn);
      for (const t of shown) lines.push(`  ${formatTaskLine(t)}`);
      const hidden = colTasks.length - shown.length;
      if (hidden > 0) lines.push(`  ... and ${hidden} more`);
      lines.push("");
    }
    const emptyStateText = requestedColumn ? `No tasks in ${columnLabel(requestedColumn)} (${requestedColumn}).` : "No matching tasks.";
    const text = lines.length === 0 ? emptyStateText : lines.join("\n").trimEnd();
    return textResult(text.trim().length > 0 ? text : emptyStateText, { structuredContent: { count: tasks.length } });
  },
};

const fnTaskShow: McpToolDefinition = {
  name: "fn_task_show",
  description: "Show full details for a task including steps, progress, and log entries.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Task ID (e.g. FN-001)" } },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const task = await store.getTask(id);

    const lines: string[] = [];
    lines.push(`${task.id}: ${task.title || task.description}`);
    lines.push(
      `Column: ${columnLabel(task.column)}` +
        (task.size ? ` · Size: ${task.size}` : "") +
        (task.reviewLevel !== undefined ? ` · Review: ${task.reviewLevel}` : ""),
    );
    if (task.dependencies.length) lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
    const sourceLabel = getTaskSourceLabel(task);
    if (sourceLabel) lines.push(`Created via: ${sourceLabel}`);
    const duplicateLineage = await formatDuplicateLineageLine(task, store);
    if (duplicateLineage) lines.push(duplicateLineage);
    if (task.paused) lines.push("Status: PAUSED");
    lines.push("");

    if (task.steps.length > 0) {
      const done = task.steps.filter((s) => s.status === "done").length;
      lines.push(`Steps (${done}/${task.steps.length}):`);
      for (let i = 0; i < task.steps.length; i++) {
        const s = task.steps[i];
        const icon = s.status === "done" ? "✓" : s.status === "in-progress" ? "▸" : s.status === "skipped" ? "–" : " ";
        const marker = i === task.currentStep && s.status !== "done" ? " ◀" : "";
        lines.push(`  [${icon}] ${i}: ${s.name}${marker}`);
      }
      lines.push("");
    }

    if (task.prompt) {
      const promptPreview = task.prompt.length > 500 ? task.prompt.slice(0, 500) + "\n... (truncated)" : task.prompt;
      lines.push("Prompt:");
      lines.push(promptPreview);
      lines.push("");
    }

    if (task.log.length > 0) {
      const recent = task.log.slice(-5);
      lines.push(`Log (last ${recent.length}):`);
      for (const l of recent) {
        const ts = new Date(l.timestamp).toLocaleTimeString();
        lines.push(`  ${ts}  ${l.action}${l.outcome ? ` → ${l.outcome}` : ""}`);
      }
    }

    return textResult(lines.join("\n").trimEnd(), { structuredContent: redactSecretsDeep({ taskId: task.id, column: task.column }) });
  },
};

const fnTaskSearch: McpToolDefinition = {
  name: "fn_task_search",
  description: "Search Fusion tasks by title, description, comments, and ID across all columns (full-text search).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query text" },
      limit: { type: "number", description: "Max results to return (default: 20)" },
      includeArchived: { type: "boolean", description: "Include archived tasks in results (default: true)" },
    },
    required: ["query"],
  },
  async handler(store, args) {
    const query = String(args.query ?? "").trim();
    if (!query) return errorResult("query is required.");
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const includeArchived = typeof args.includeArchived === "boolean" ? args.includeArchived : true;
    const results = await store.searchTasks(query, { limit, slim: true, includeArchived });
    if (results.length === 0) {
      return textResult(`No tasks match "${query}".`, { structuredContent: { count: 0 } });
    }
    const lines = results.map((t) => `${columnLabel(t.column)}: ${formatTaskLine(t)}`);
    return textResult(`Found ${results.length} task(s) matching "${query}":\n${lines.join("\n")}`, {
      structuredContent: { count: results.length, taskIds: results.map((t) => t.id) },
    });
  },
};

const fnDelegateTask: McpToolDefinition = {
  name: "fn_delegate_task",
  description:
    "Create a new task and assign it to a specific agent for execution. The task goes to 'todo' and will be " +
    "picked up by the target agent on their next heartbeat cycle. Use fn_list_agents first to find available " +
    "agents and their capabilities. Optionally pass workflow_id to select a workflow at creation time.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "The agent ID to delegate work to" },
      description: { type: "string", description: "What needs to be done" },
      dependencies: { type: "array", items: { type: "string" }, description: "Task IDs this new task depends on (e.g. ['KB-001'])" },
      workflow_id: { type: "string", description: "Workflow ID to select for the new task. Use fn_workflow_list to discover valid IDs." },
      override: { type: "boolean", description: "Set true to bypass executor-role assignment policy" },
    },
    required: ["agent_id", "description"],
  },
  async handler(store, args, ctx) {
    const agentId = String(args.agent_id ?? "").trim();
    const description = String(args.description ?? "").trim();
    if (!agentId) return errorResult("agent_id is required.");
    if (!description) return errorResult("description is required.");
    const override = args.override === true;

    const delegateTaskShape: Pick<Task, "id" | "column"> = { id: "<new>", column: "todo" };
    const agentError = await validateAssignableAgentId(ctx.cwd, agentId, delegateTaskShape, override);
    if (agentError) return errorResult(agentError);

    const agentStore = await getAgentStore(ctx.cwd);
    const agent = await agentStore.getAgent(agentId);

    try {
      const workflowId = typeof args.workflow_id === "string" ? args.workflow_id.trim() || undefined : undefined;
      const task = await store.createTask({
        description,
        dependencies: Array.isArray(args.dependencies) ? (args.dependencies as string[]) : undefined,
        column: "todo",
        assignedAgentId: agentId,
        ...(workflowId ? { workflowId } : {}),
        source: { sourceType: "api", ...(override ? { sourceMetadata: { executorRoleOverride: true } } : {}) },
      });

      const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
      const workflow = workflowId ? ` (workflow: ${workflowId})` : "";
      return textResult(
        `Delegated to ${agent!.name} (${agent!.id}): Created ${task.id}${deps}${workflow}. ` +
          `The task will be picked up by ${agent!.name} on their next heartbeat cycle.`,
        { structuredContent: { taskId: task.id, agentId: agent!.id, agentName: agent!.name } },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Task ID already exists:")) {
        return errorResult(error.message);
      }
      throw error;
    }
  },
};

// ── Agent tools ──────────────────────────────────────────────────────────

const fnListAgents: McpToolDefinition = {
  name: "fn_list_agents",
  description:
    "List all available agents in the system. Shows each agent's name, role, state, personality (soul), and " +
    "current assignment. Use this to discover which agents exist and what they specialize in before delegating work.",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string", description: "Filter by agent role/capability (e.g., 'executor', 'reviewer', 'qa')" },
      state: { type: "string", description: "Filter by agent state (e.g., 'idle', 'active', 'running')" },
      includeEphemeral: { type: "boolean", description: "Include ephemeral/runtime agents (default: false)" },
    },
  },
  async handler(store, args, ctx) {
    const agentStore = await getAgentStore(ctx.cwd);
    const filter: Record<string, unknown> = {};
    if (typeof args.role === "string") filter.role = args.role;
    if (typeof args.state === "string") filter.state = args.state;
    if (typeof args.includeEphemeral === "boolean") filter.includeEphemeral = args.includeEphemeral;

    const agents = await agentStore.listAgents(filter as Parameters<typeof agentStore.listAgents>[0]);
    if (agents.length === 0) {
      return textResult("No agents found matching the specified filters.", { structuredContent: { count: 0 } });
    }

    const lines = await Promise.all(
      agents.map(async (agent) => {
        const parts: string[] = [`ID: ${agent.id}`, `Name: ${agent.name}`, `Role: ${agent.role}`, `State: ${agent.state}`];
        if (agent.title) parts.push(`Title: ${agent.title}`);
        if (agent.soul) parts.push(`Soul: ${agent.soul.slice(0, 200)}`);
        if (agent.taskId) {
          let linkedTask: Pick<Task, "id" | "column"> | null = null;
          try {
            linkedTask = await store.getTask(agent.taskId);
          } catch {
            linkedTask = null;
          }
          parts.push(formatCurrentTaskLine(agent.taskId, linkedTask));
        }
        return parts.join("\n");
      }),
    );

    return textResult(`Available agents (${agents.length}):\n\n${lines.join("\n\n")}`, {
      structuredContent: redactSecretsDeep({ count: agents.length }),
    });
  },
};

const fnAgentShow: McpToolDefinition = {
  name: "fn_agent_show",
  description:
    "Show detailed information about a single agent, including their role, state, position in the org hierarchy " +
    "(reports-to, direct reports), skills, and current assignment.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Agent ID or resolvable name" } },
    required: ["id"],
  },
  async handler(store, args, ctx) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const agentStore = await getAgentStore(ctx.cwd);
    const agent = await agentStore.resolveAgent(id);
    if (!agent) return errorResult(`Agent '${id}' not found`);

    const directReports = await agentStore.getAgentsByReportsTo(agent.id);
    const parts: string[] = [`ID: ${agent.id}`, `Name: ${agent.name}`, `Role: ${agent.role}`, `State: ${agent.state}`];
    if (agent.title) parts.push(`Title: ${agent.title}`);
    if (agent.reportsTo) {
      const manager = await agentStore.getAgent(agent.reportsTo);
      parts.push(manager ? `Reports To: ${manager.name} (${manager.id})` : `Reports To: ${agent.reportsTo}`);
    }
    if (directReports.length > 0) {
      parts.push(`Direct Reports: ${directReports.map((r) => `${r.name} (${r.id})`).join(", ")}`);
    }
    if (agent.taskId) {
      let linkedTask: Pick<Task, "id" | "column"> | null = null;
      try {
        linkedTask = await store.getTask(agent.taskId);
      } catch {
        linkedTask = null;
      }
      parts.push(formatCurrentTaskLine(agent.taskId, linkedTask));
    }
    if (agent.soul) parts.push(`Soul: ${agent.soul.slice(0, 200)}${agent.soul.length > 200 ? "…" : ""}`);

    return textResult(parts.join("\n"), {
      structuredContent: redactSecretsDeep({
        agentId: agent.id,
        directReports: directReports.map((r) => ({ id: r.id, name: r.name, role: r.role })),
      }),
    });
  },
};

const fnAgentCreate: McpToolDefinition = {
  name: "fn_agent_create",
  description: "Create a new non-ephemeral agent.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Agent name" },
      role: { type: "string", enum: ["triage", "executor", "reviewer", "merger", "engineer", "custom"], description: "Agent role/capability" },
      soul: { type: "string", description: "Agent personality/identity text" },
      instructions_text: { type: "string", description: "Inline custom instructions" },
      instructions_path: { type: "string", description: "Path to instructions markdown" },
      reportsTo: { type: "string", description: "Manager agent ID" },
      heartbeat_interval_ms: { type: "number", minimum: 1000 },
      heartbeat_timeout_ms: { type: "number", minimum: 5000 },
      max_concurrent_runs: { type: "number", minimum: 1 },
      message_response_mode: { type: "string", enum: ["immediate", "on-heartbeat"] },
    },
    required: ["name", "role"],
  },
  async handler(store, args, ctx) {
    const name = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    if (!name) return errorResult("name is required.");
    if (!role) return errorResult("role is required.");

    const agentStore = await getAgentStore(ctx.cwd);
    /*
    FNXC:McpServer 2026-07-10-21:00:
    fn mcp serve runs as a local stdio process launched directly by the
    operator, so every call is treated as an already-privileged operator
    action — mirrors the caller shape fn_agent_create already uses in the pi
    extension (packages/cli/src/extension.ts).
    */
    const caller = { id: "user", role: "user", isPrivileged: true } as const;
    const policy = resolveAgentProvisioningPolicy({ tool: "fn_agent_create", caller, settings: await store.getSettings() });

    if (policy.decision === "require-approval") {
      const approvalStore = new ApprovalRequestStore(store.getDatabase());
      const request = approvalStore.create({
        requester: { actorId: "user", actorType: "user", actorName: "MCP Operator" },
        targetAction: {
          category: "agent_provisioning",
          action: "create",
          summary: `Create agent ${name} (${role})`,
          resourceType: "agent",
          resourceId: "",
          context: { tool: "fn_agent_create", params: redactSecretsDeep(args) },
        },
      });
      return textResult(`Approval required. Request ${request.id} created.`, {
        structuredContent: { outcome: "pending_approval", approvalRequestId: request.id, matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode },
      });
    }

    const runtimeConfig: Record<string, unknown> = {
      ...(typeof args.heartbeat_interval_ms === "number" ? { heartbeatIntervalMs: args.heartbeat_interval_ms } : {}),
      ...(typeof args.heartbeat_timeout_ms === "number" ? { heartbeatTimeoutMs: args.heartbeat_timeout_ms } : {}),
      ...(typeof args.max_concurrent_runs === "number" ? { maxConcurrentRuns: args.max_concurrent_runs } : {}),
      ...(typeof args.message_response_mode === "string" ? { messageResponseMode: args.message_response_mode } : {}),
    };
    const created = await agentStore.createAgent({
      name,
      role: role as never,
      ...(typeof args.soul === "string" ? { soul: args.soul } : {}),
      ...(typeof args.instructions_text === "string" ? { instructionsText: args.instructions_text } : {}),
      ...(typeof args.instructions_path === "string" ? { instructionsPath: args.instructions_path } : {}),
      ...(typeof args.reportsTo === "string" ? { reportsTo: args.reportsTo } : {}),
      ...(Object.keys(runtimeConfig).length > 0 ? { runtimeConfig } : {}),
    });

    return textResult(`Created agent ${created.name} (${created.id})`, {
      structuredContent: redactSecretsDeep({ outcome: "created", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: created.id }),
    });
  },
};

const fnAgentStart: McpToolDefinition = {
  name: "fn_agent_start",
  description: "Start a stopped agent — resumes its execution. Transitions the agent from paused to active state.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Agent ID to start (e.g., agent-abc123)" } },
    required: ["id"],
  },
  async handler(_store, args, ctx) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const agentStore = await getAgentStore(ctx.cwd);
    const agent = await agentStore.getAgent(id);
    if (!agent) return errorResult(`Agent ${id} not found`);
    if (agent.state === "active" || agent.state === "running") {
      return textResult(`Agent ${id} is already running (${agent.state})`, { structuredContent: { agentId: id, state: agent.state } });
    }
    const validTargets = AGENT_VALID_TRANSITIONS[agent.state];
    if (!validTargets.includes("active")) {
      return errorResult(
        `Cannot start agent ${id} — current state '${agent.state}' cannot transition to 'active'. Valid transitions: ${validTargets.join(", ")}`,
        { structuredContent: { agentId: id, currentState: agent.state, validTargets } },
      );
    }
    await agentStore.updateAgentState(id, "active");
    return textResult(`Started ${id}`, { structuredContent: { agentId: id, previousState: agent.state, newState: "active" } });
  },
};

const fnAgentStop: McpToolDefinition = {
  name: "fn_agent_stop",
  description: "Stop a running agent — pauses its execution. Transitions the agent from running/active to paused state.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Agent ID to stop (e.g., agent-abc123)" } },
    required: ["id"],
  },
  async handler(_store, args, ctx) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const agentStore = await getAgentStore(ctx.cwd);
    const agent = await agentStore.getAgent(id);
    if (!agent) return errorResult(`Agent ${id} not found`);
    if (agent.state === "paused") {
      return textResult(`Agent ${id} is already paused`, { structuredContent: { agentId: id, state: agent.state } });
    }
    const validTargets = AGENT_VALID_TRANSITIONS[agent.state];
    if (!validTargets.includes("paused")) {
      return errorResult(
        `Cannot stop agent ${id} — current state '${agent.state}' cannot transition to 'paused'. Valid transitions: ${validTargets.join(", ")}`,
        { structuredContent: { agentId: id, currentState: agent.state, validTargets } },
      );
    }
    await agentStore.updateAgentState(id, "paused");
    return textResult(`Stopped ${id}`, { structuredContent: { agentId: id, previousState: agent.state, newState: "paused" } });
  },
};

// ── Workflow tools ───────────────────────────────────────────────────────

/*
FNXC:McpServer 2026-07-10-21:00:
Workflow tools bind directly to @fusion/engine's createWorkflowAuthoringTools
— the exact same factory the pi extension's fn_workflow_* tools use
(packages/cli/src/extension.ts) — so IR validation and store-side behavior
stay centralized in one place rather than being re-implemented here.
`stripApprovalFlags: true` mirrors the pi extension's prompt-injectable-lane
treatment since an external MCP client is likewise untrusted input for IR
authoring.

FNXC:McpServer 2026-07-10-22:10:
`fn_workflow_delete` (FUSI-002) reuses this SAME `bindWorkflowTool` binding
— the factory already produces a `createWorkflowDeleteTool` entry that
protects built-in workflows and re-homes occupants, so the destructive tier
below does not re-implement any of that; it only gates registration of the
name behind `allowDestructive` and adds a stderr audit line.
*/
function bindWorkflowTool(name: "fn_workflow_list" | "fn_workflow_get" | "fn_workflow_create" | "fn_workflow_update" | "fn_workflow_select" | "fn_workflow_delete" | "fn_workflow_settings" | "fn_workflow_add_node" | "fn_workflow_remove_node" | "fn_workflow_add_edge" | "fn_workflow_remove_edge", description: string, inputSchema: McpJsonSchema): McpToolDefinition {
  return {
    name,
    description,
    inputSchema,
    async handler(store, args, ctx) {
      const currentTaskId = "";
      const workflowTools = createWorkflowAuthoringTools(store, currentTaskId, { stripApprovalFlags: true });
      const tool = workflowTools.find((candidate) => candidate.name === name);
      if (!tool) return errorResult(`Workflow tool '${name}' is not available.`);
      if (name === "fn_workflow_select") {
        const explicitTaskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!explicitTaskId) return errorResult("task_id is required when calling fn_workflow_select from the MCP operator server.");
      }
      const stubCtx = buildStubExtensionContext(ctx.cwd);
      const result = (await tool.execute("mcp-call", args as never, undefined, undefined, stubCtx)) as {
        content?: Array<{ type: string; text?: string }>;
        details?: unknown;
        isError?: boolean;
      };
      return {
        content: (result.content ?? []).map((block) =>
          block.type === "text" && typeof block.text === "string"
            ? { type: "text" as const, text: block.text }
            : { type: "text" as const, text: JSON.stringify(block) },
        ),
        isError: result.isError,
        structuredContent: redactSecretsDeep(result.details ?? {}),
      };
    },
  };
}

/*
FNXC:McpWorkflow 2026-07-11-00:00:
FUSI-043: TypeBox's `Type.Object(...)` already emits fully JSON-Schema-shaped
output (nested `type`/`properties`/`items` all the way down — verified against
the new `workflowIrSchema` in packages/engine/src/agent-tools.ts), so a shallow
forward of `schema.properties` here is sufficient: nested object/array
sub-schemas (e.g. `ir.properties.nodes.items.properties.id`) survive untouched.
The adapter that DOES need to recurse is `jsonSchemaPropertyToZod` in
packages/cli/src/mcp-server/server.ts, which converts this plain JSON Schema
into the zod raw shape `McpServer.registerTool` requires.
*/
const jsonSchemaOf = (schema: { properties?: Record<string, unknown>; required?: string[] }): McpJsonSchema => ({
  type: "object",
  properties: schema.properties ?? {},
  required: schema.required,
});

const fnWorkflowList = bindWorkflowTool(
  "fn_workflow_list",
  "List the custom workflows available for this project — read-only built-ins (ids starting with 'builtin:') and user-authored definitions. Use before fn_workflow_select to discover valid workflow IDs.",
  jsonSchemaOf(workflowListParams),
);
/*
FNXC:McpWorkflow 2026-07-11-00:00:
FUSI-043: fn_workflow_get's `structuredContent` now carries the definition's
full `ir` (see createWorkflowGetTool's `details` payload in
packages/engine/src/agent-tools.ts) so a source-blind MCP client can clone a
workflow; fn_workflow_create/fn_workflow_update's `ir` input schema is now a
typed, discoverable object (workflowIrSchema) instead of `Type.Unknown()`, so
the same client can author a valid graph without reading Fusion source. Both
fixes dispatch through the SAME createWorkflowAuthoringTools factory via
bindWorkflowTool above — no duplicated validation here.
*/
const fnWorkflowGet = bindWorkflowTool(
  "fn_workflow_get",
  "Fetch a single workflow definition by its ID — its name, description, whether it is a read-only built-in, and its full IR (nodes, edges, columns, artifacts, and custom fields) as JSON. Use fn_workflow_list to discover IDs first.",
  jsonSchemaOf(workflowGetParams),
);
const fnWorkflowCreate = bindWorkflowTool(
  "fn_workflow_create",
  "Create a new custom workflow definition from a name and a workflow graph (IR). The IR is validated server-side; a malformed graph rejects. Returns the new workflow ID.",
  jsonSchemaOf(workflowCreateParams),
);
const fnWorkflowUpdate = bindWorkflowTool(
  "fn_workflow_update",
  "Update a custom workflow definition (name/description/ir/layout). Built-ins cannot be edited.",
  jsonSchemaOf(workflowUpdateParams),
);
const fnWorkflowSelect = bindWorkflowTool(
  "fn_workflow_select",
  "Assign a custom workflow to a task by its workflow ID. task_id is required when called from the MCP operator server (no ambient task context).",
  jsonSchemaOf(workflowSelectParams),
);

const fnWorkflowDelete = bindWorkflowTool(
  "fn_workflow_delete",
  "DESTRUCTIVE: delete a custom Fusion workflow definition. Built-in workflows are protected. " +
    "Any tasks using the deleted workflow have their selection cleared and are re-homed to the default " +
    "workflow's entry column. Only registered when `fn mcp serve` is started with --allow-destructive.",
  jsonSchemaOf(workflowDeleteParams),
);

/*
FNXC:McpServer 2026-07-11-15:00:
FUSI-046: `fn_workflow_settings` closes the biggest remaining MCP-surface gap
— the CLI's own guidance already told operators "these live in workflow
settings — edit via the editor or fn_workflow_settings", but no such tool was
registered here, so a source-blind MCP client could not set autoMerge,
planApprovalMode, review/approval gates, or per-phase model lanes on a
workflow AT ALL (directly blocking MCP-only Trio/WF-001 setup). Dispatches
through the SAME `bindWorkflowTool` → `createWorkflowAuthoringTools` factory
as every other workflow tool — `createWorkflowSettingsTool` already existed
in that factory (agent-tools.ts) for the chat/planning/executor lanes; this
is purely a registration gap fix, no new domain logic. Base-tier (NOT
destructive): `set` is a reversible per-(workflow, project) VALUES write —
`null` clears an override — exactly like `fn_workflow_update`'s base-tier
IR/name/description edits, and unlike the `*_delete` tools.
*/
const fnWorkflowSettings = bindWorkflowTool(
  "fn_workflow_settings",
  "Read or write a workflow's setting VALUES (the per-(workflow, project) policy knobs: step timeouts, " +
    "review/approval gates, per-phase model lanes). action='get' returns both the raw `stored` values and the " +
    "engine `effective` values (declaration defaults filled in, orphaned values dropped). action='set' writes " +
    "`values` against the NAMED workflow's declared settings; a `null` value clears an override. Built-in " +
    "workflow VALUES are writable, but built-in DECLARATIONS are not — declarations are authored in the " +
    "workflow IR's `settings` array via fn_workflow_create/fn_workflow_update. An invalid value returns the " +
    "typed rejection list and persists nothing.",
  jsonSchemaOf(workflowSettingsParams),
);

/*
FNXC:McpWorkflow 2026-07-11-15:00:
FUSI-046: granular add/remove-node and add/remove-edge tools — the
fine-grained complement to whole-IR `fn_workflow_update`, over a
read(fn_workflow_get)→mutate→write flow. Same `bindWorkflowTool` →
`createWorkflowAuthoringTools` dispatch as every other workflow tool; the
underlying @fusion/core `addNodeToIr`/`removeNodeFromIr`/`addEdgeToIr`/
`removeEdgeFromIr` helpers (packages/core/src/workflow-ir.ts) route every
mutation through the SAME `parseWorkflowIr` whole-IR validator
`fn_workflow_update` uses — no second validation path. Base-tier (NOT
destructive): each mutates a custom workflow's own IR in a reversible way
(a removed node/edge can be re-added) and re-homes nothing, so this is NOT
`*_delete`-class.
*/
const fnWorkflowAddNode = bindWorkflowTool(
  "fn_workflow_add_node",
  "Add a single node to a custom workflow's IR without a whole-IR round-trip. Built-ins cannot be edited. " +
    "Pass `edges` to connect the node atomically in the SAME call — required unless the node kind is one of " +
    "the interpreter-entry kinds exempt from start-reachability (merge-gate, merge-attempt, manual-merge-hold, " +
    "retry-backoff, recovery-router, branch-group-member-integration, branch-group-promotion, pr-create, " +
    "pr-respond, pr-merge); every other node must already be reachable from the workflow's start node when " +
    "validated, and a freshly added node has no other edges yet. The resulting graph is validated the same way " +
    "fn_workflow_update validates a full IR replace.",
  jsonSchemaOf(workflowAddNodeParams),
);
const fnWorkflowRemoveNode = bindWorkflowTool(
  "fn_workflow_remove_node",
  "Remove a single node from a custom workflow's IR. Built-ins cannot be edited. CASCADES to also remove every " +
    "edge incident to the removed node (both incoming and outgoing) in the SAME atomic mutation — a non-cascading " +
    "two-step removal is unsafe in general, since removing a mid-graph node's incident edges one at a time would " +
    "strand it unreachable from start before the node itself could be removed. No OTHER edge is touched. The " +
    "resulting graph is validated the same way fn_workflow_update validates a full IR replace.",
  jsonSchemaOf(workflowRemoveNodeParams),
);
const fnWorkflowAddEdge = bindWorkflowTool(
  "fn_workflow_add_edge",
  "Add a single edge to a custom workflow's IR without a whole-IR round-trip. Built-ins cannot be edited. Both " +
    "endpoint node ids must already exist. The resulting graph is validated the same way fn_workflow_update " +
    "validates a full IR replace.",
  jsonSchemaOf(workflowAddEdgeParams),
);
const fnWorkflowRemoveEdge = bindWorkflowTool(
  "fn_workflow_remove_edge",
  "Remove a single edge from a custom workflow's IR, matched by from/to (and optional condition to " +
    "disambiguate when multiple edges share the same from/to pair). Built-ins cannot be edited. The resulting " +
    "graph is validated the same way fn_workflow_update validates a full IR replace.",
  jsonSchemaOf(workflowRemoveEdgeParams),
);

/*
FNXC:McpServer 2026-07-10-23:59:
FUSI-006 adds `fn_task_archive` to the BASE registry (not the destructive
tier gated by --allow-destructive). Archive is a fully reversible soft-move
to the `archived` column — it has a restore path (`fn_task_unarchive` /
store.unarchiveTask), unlike the `*_delete` tools in DESTRUCTIVE_TOOL_TIER —
so it belongs alongside the other safe-mutation base tools. The handler
dispatches to the SAME `store.archiveTask(id, { removeLineageReferences })`
call the pi-extension `fn_task_archive` handler uses
(packages/cli/src/extension.ts), including forwarding `removeLineageReferences`
so the TaskHasLineageChildrenError recovery path it advertises is reachable
(see the FN-7661 FNXC:TaskLifecycleTools comment on the extension handler).
`fn_goal_archive` was evaluated and explicitly DEFERRED: the base registry
currently exposes no `fn_goal_list`/`fn_goal_show` tools, so a standalone
goal-archive tool would have no MCP-discoverable way to find goal IDs — see
the filed follow-up task for introducing a coherent goal tool set.
*/
const fnTaskArchive: McpToolDefinition = {
  name: "fn_task_archive",
  description:
    "Archive a task from any live column (move to archived). This is a REVERSIBLE soft-move, not a deletion " +
    "— archived tasks are preserved for historical reference and restorable via fn_task_unarchive. If the task " +
    "is still referenced as a lineage parent by another task, archiving is rejected unless " +
    "removeLineageReferences:true is passed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID to archive from any live column (e.g. FN-001)." },
      removeLineageReferences: {
        type: "boolean",
        description:
          "When true, clear incoming lineage-parent references (child sourceParentTaskId) before archiving, " +
          "so a task still referenced as a lineage parent can be archived.",
      },
    },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    try {
      const task = await store.archiveTask(id, { removeLineageReferences: args.removeLineageReferences === true });
      return textResult(`Archived ${task.id} → ${columnLabel(task.column)}`, {
        structuredContent: redactSecretsDeep({ taskId: task.id, column: task.column }),
      });
    } catch (error) {
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    }
  },
};

/*
FNXC:McpServer 2026-07-11-15:00:
FUSI-046: `fn_task_update` closes the "no task-edit on MCP; had to
archive+recreate" papercut — it mirrors the pi-extension `fn_task_update`
handler (packages/cli/src/extension.ts) FIELD FOR FIELD: title/description/
depends/agentId/nodeId/priority/workflow_id, the SAME `validateAssignableAgentId`
+ `normalizeNullableStringInput` + `validateNodeOverrideChange` pre-validation
(including the FN-7641 `nodeId='end'` merge-proof guard), the same
at-least-one-field guard, and the same final `store.updateTask(id, updates)` /
`store.selectTaskWorkflowAndReconcile` / `store.clearTaskWorkflowSelection`
dispatch — no re-implemented update logic. Base-tier: an in-place edit,
reversible and analogous to `fn_task_create`/`fn_task_archive`, not a
`*_delete`-class mutation.
*/
const fnTaskUpdate: McpToolDefinition = {
  name: "fn_task_update",
  description:
    "Update fields on an existing task. Supports modifying the title, description, dependencies, assigned " +
    "agent, priority, and workflow_id after task creation. Set workflow_id to a workflow ID to select it, or " +
    "null to clear the workflow selection. At least one field must be provided.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID (e.g. FN-001)" },
      title: { type: "string", description: "New task title" },
      description: { type: "string", description: "New task description" },
      depends: {
        type: "array",
        items: { type: "string" },
        description: "New dependency list — replaces existing dependencies (e.g. ['FN-001', 'FN-002'])",
      },
      agentId: {
        type: ["string", "null"],
        description: "Agent ID to assign this task to, or null to clear (e.g. 'agent-abc123')",
      },
      nodeId: {
        type: ["string", "null"],
        description: "Node ID override for this task, or null to clear",
      },
      priority: { type: "string", enum: [...TASK_PRIORITIES], description: "Task priority (low, normal, high, urgent)" },
      workflow_id: {
        type: ["string", "null"],
        description:
          "Workflow ID to select for this task (e.g. 'WF-003' or 'builtin:coding'), or null to clear the " +
          "workflow selection and revert to the project default. Use fn_workflow_list to discover valid IDs.",
      },
    },
    required: ["id"],
  },
  async handler(store, args, ctx) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");

    let task: Task;
    try {
      task = await store.getTask(id);
    } catch {
      return errorResult(`Task ${id} not found`);
    }

    const updates: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    if (typeof args.title === "string") {
      updates.title = args.title.trim();
      updatedFields.push("title");
    }
    if (typeof args.description === "string") {
      updates.description = args.description.trim();
      updatedFields.push("description");
    }
    if (Array.isArray(args.depends)) {
      updates.dependencies = args.depends as string[];
      updatedFields.push("dependencies");
    }
    if (args.agentId !== undefined) {
      const normalizedAgentId = normalizeNullableStringInput(
        args.agentId === null ? null : typeof args.agentId === "string" ? args.agentId : undefined,
      );
      if (typeof normalizedAgentId === "string") {
        const agentError = await validateAssignableAgentId(ctx.cwd, normalizedAgentId, task);
        if (agentError) return errorResult(agentError);
      }
      updates.assignedAgentId = normalizedAgentId;
      updatedFields.push("agentId");
    }
    if (args.nodeId !== undefined) {
      const normalizedNodeId = normalizeNullableStringInput(
        args.nodeId === null ? null : typeof args.nodeId === "string" ? args.nodeId : undefined,
      );
      const validation = validateNodeOverrideChange(task, normalizedNodeId ?? null);
      if (!validation.allowed) return errorResult(validation.message ?? "Node override change blocked");
      updates.nodeId = normalizedNodeId;
      updatedFields.push("nodeId");
    }
    if (typeof args.priority === "string") {
      updates.priority = args.priority as TaskPriority;
      updatedFields.push("priority");
    }
    if (args.workflow_id !== undefined) {
      if (args.workflow_id === null) {
        await store.clearTaskWorkflowSelection(task.id);
        updatedFields.push("workflowId");
      } else if (typeof args.workflow_id === "string") {
        const workflowId = args.workflow_id.trim();
        if (workflowId.length > 0) {
          try {
            await store.selectTaskWorkflowAndReconcile(task.id, workflowId);
          } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
          }
          updatedFields.push("workflowId");
        }
      }
    }

    if (updatedFields.length === 0) {
      return errorResult(
        "No fields to update. Provide at least one of: title, description, depends, agentId, nodeId, priority, workflow_id.",
      );
    }

    if (Object.keys(updates).length > 0) {
      await store.updateTask(id, updates);
    }

    return textResult(`Updated ${id}: ${updatedFields.join(", ")}`, {
      structuredContent: redactSecretsDeep({ taskId: id, updatedFields }),
    });
  },
};

/**
 * The curated v1 allow-list — the base set `fn mcp serve` ALWAYS exposes
 * (with or without --allow-destructive). Order mirrors the task/agent/workflow
 * grouping documented in docs/mcp.md; `fn_task_archive` (FUSI-006) is grouped
 * with the other `fnTask*` tools.
 *
 * Deliberately absent: any release/publish/version-tag tool, and any tool
 * that could return raw secret material. `*_delete` tools live in
 * {@link DESTRUCTIVE_TOOL_TIER} instead, appended only via
 * {@link buildMcpToolRegistry} when the operator opts in. `fn_task_archive`
 * is reversible (restorable via fn_task_unarchive) so it stays here, NOT in
 * the destructive tier.
 */
// ── Mission hierarchy tools (read-only) ────────────────────────────────

/*
FNXC:McpServer 2026-07-11-08:30:
FUSI-017 adds the read half of the mission hierarchy to the BASE registry
(no --allow-destructive gate — these are plain reads): fn_mission_list,
fn_mission_show, fn_milestone_list/show, fn_slice_list/show,
fn_feature_list/show. Every handler dispatches to the SAME MissionStore
read the pi-extension fn_mission_list/fn_mission_show handlers in
packages/cli/src/extension.ts already call (listMissions,
getMissionWithHierarchy, getMilestone/listMilestones, getSlice/listSlices,
getFeature/listFeatures) — no duplicated validation, no HTTP round-trip.
fn_mission_list/fn_mission_show mirror the pi-extension tools 1:1 (name,
param shape, text rendering, details payload). The per-level
fn_milestone_show/list, fn_slice_show/list, fn_feature_show/list tools have
NO pi-extension precedent — they are net-new here so every hierarchy level
is independently discoverable/addressable from an external MCP client
without always walking the full mission tree. These eight tools unblock
FUSI-018/019/020, which all depend on ID discovery this task provides.
*/

const fnMissionList: McpToolDefinition = {
  name: "fn_mission_list",
  description: "List all missions with their current status.",
  inputSchema: {
    type: "object",
    properties: {
      includeDrafts: { type: "boolean", description: "Include in-flight mission interview drafts (default: true)" },
    },
  },
  async handler(store, args) {
    const missionStore = store.getMissionStore();
    const includeDrafts = args.includeDrafts === false ? false : true;

    const missions = missionStore.listMissions();
    const drafts = includeDrafts
      ? (store.getDatabase()
        .prepare(
          `SELECT id, title, status, updatedAt
           FROM ai_sessions
           WHERE type = 'mission_interview'
             AND status IN ('generating', 'awaiting_input', 'error', 'complete')
             AND COALESCE(archived, 0) = 0
           ORDER BY updatedAt DESC`,
        )
        .all() as Array<{ id: string; title: string; status: "generating" | "awaiting_input" | "error" | "complete"; updatedAt: string }>)
      : [];

    if (missions.length === 0 && drafts.length === 0) {
      return textResult("No missions yet.", { structuredContent: { count: 0, drafts: [] } });
    }

    const summary = {
      planning: missions.filter((m) => m.status === "planning").length,
      active: missions.filter((m) => m.status === "active").length,
      blocked: missions.filter((m) => m.status === "blocked").length,
      complete: missions.filter((m) => m.status === "complete").length,
      archived: missions.filter((m) => m.status === "archived").length,
    };

    const lines: string[] = [];
    lines.push(`Missions (${missions.length})`);
    lines.push(
      `Summary: active ${summary.active}, planning ${summary.planning}, blocked ${summary.blocked}, complete ${summary.complete}, archived ${summary.archived}`,
    );
    lines.push("");

    if (drafts.length > 0) {
      lines.push(`Drafts (${drafts.length})`);
      for (const draft of drafts) {
        const draftStatus = draft.status === "complete" ? "plan ready" : draft.status;
        lines.push(`  \u25cc ${draft.id}: ${draft.title} (draft \u00b7 interview ${draftStatus})`);
      }
      lines.push("");
    }

    for (const mission of missions) {
      const statusIcon = mission.status === "complete" ? "\u2713" : mission.status === "active" ? "\u25cf" : mission.status === "blocked" ? "\u26a0" : "\u25cb";
      const autoAdvance = mission.autoAdvance ? " \u00b7 auto-advance" : "";
      lines.push(`  ${statusIcon} ${mission.id}: ${mission.title} (${mission.status}${autoAdvance})`);
    }

    return textResult(lines.join("\n"), {
      structuredContent: redactSecretsDeep({
        count: missions.length,
        missions: missions.map((m) => ({ id: m.id, title: m.title, status: m.status })),
        drafts: drafts.map((draft) => ({ id: draft.id, title: draft.title, status: draft.status, updatedAt: draft.updatedAt })),
      }),
    });
  },
};

const fnMissionShow: McpToolDefinition = {
  name: "fn_mission_show",
  description: "Show mission details with full hierarchy: milestones \u2192 slices \u2192 features.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Mission ID (e.g., M-001)" } },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const missionStore = store.getMissionStore();
    const mission = missionStore.getMissionWithHierarchy(id);
    if (!mission) return errorResult(`Mission ${id} not found`);

    const lines: string[] = [];
    const renderGateLine = (indent: string, label: string, value: string | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed) return;
      if (trimmed.length > 240) {
        lines.push(`${indent}${label} ${trimmed.slice(0, 240)}\u2026 (truncated, ${trimmed.length} chars)`);
        return;
      }
      lines.push(`${indent}${label} ${trimmed}`);
    };

    lines.push(`${mission.id}: ${mission.title}`);
    lines.push(`Status: ${mission.status}`);
    if (mission.description) lines.push(`Description: ${mission.description}`);
    lines.push("");

    lines.push("Linked Goals:");
    if ((mission.linkedGoals?.length ?? 0) === 0) {
      lines.push("No linked goals.");
    } else {
      for (const goal of mission.linkedGoals ?? []) lines.push(`- ${goal.id}: ${goal.title}`);
    }
    lines.push("");

    if (mission.milestones.length === 0) {
      lines.push("No milestones yet.");
    } else {
      lines.push("Milestones:");
      for (const milestone of mission.milestones) {
        const mIcon = milestone.status === "complete" ? "\u2713" : milestone.status === "active" ? "\u25cf" : "\u25cb";
        lines.push(`  ${mIcon} ${milestone.id}: ${milestone.title} (${milestone.status})`);
        renderGateLine("    ", "AC:", milestone.acceptanceCriteria);

        for (const slice of milestone.slices) {
          const sIcon = slice.status === "complete" ? "\u2713" : slice.status === "active" ? "\u25cf" : "\u25cb";
          lines.push(`    ${sIcon} ${slice.id}: ${slice.title} (${slice.status})`);
          renderGateLine("      ", "Verification:", slice.verification);

          for (const feature of slice.features) {
            const fIcon = feature.status === "done" ? "\u2713" : feature.status === "in-progress" ? "\u25b8" : feature.status === "triaged" ? "\u25cf" : "\u25cb";
            const taskLink = feature.taskId ? ` \u2192 ${feature.taskId}` : "";
            lines.push(`      ${fIcon} ${feature.id}: ${feature.title} (${feature.status})${taskLink}`);
            renderGateLine("        ", "AC:", feature.acceptanceCriteria);
          }
        }
      }
    }

    return textResult(lines.join("\n").trimEnd(), { structuredContent: redactSecretsDeep({ mission }) });
  },
};

function bindMissionHierarchyListTool(config: {
  name: "fn_milestone_list" | "fn_slice_list" | "fn_feature_list";
  parentParamKey: "missionId" | "milestoneId" | "sliceId";
  childLabel: string;
  listOp: (missionStore: ReturnType<TaskStore["getMissionStore"]>, parentId: string) => Array<{ id: string; title: string; status: string; acceptanceCriteria?: string; taskId?: string }>;
}): McpToolDefinition {
  return {
    name: config.name,
    description: `List the ${config.childLabel}s under a given ${config.parentParamKey}.`,
    inputSchema: {
      type: "object",
      properties: {
        [config.parentParamKey]: { type: "string", description: `Parent ${config.parentParamKey} to list ${config.childLabel}s for` },
      },
      required: [config.parentParamKey],
    },
    async handler(store, args) {
      const parentId = String(args[config.parentParamKey] ?? "").trim();
      if (!parentId) return errorResult(`${config.parentParamKey} is required.`);
      const missionStore = store.getMissionStore();
      const items = config.listOp(missionStore, parentId);

      if (items.length === 0) {
        return textResult(`No ${config.childLabel}s for ${parentId}.`, {
          structuredContent: { [config.parentParamKey]: parentId, count: 0, [`${config.childLabel}s`]: [] },
        });
      }

      const lines = [`${config.childLabel}s for ${parentId} (${items.length}):`];
      for (const item of items) {
        const taskLink = item.taskId ? ` \u2192 ${item.taskId}` : "";
        lines.push(`  ${item.id}: ${item.title} (${item.status})${taskLink}`);
      }

      return textResult(lines.join("\n"), {
        structuredContent: redactSecretsDeep({
          [config.parentParamKey]: parentId,
          count: items.length,
          [`${config.childLabel}s`]: items,
        }),
      });
    },
  };
}

const fnMilestoneList = bindMissionHierarchyListTool({
  name: "fn_milestone_list",
  parentParamKey: "missionId",
  childLabel: "milestone",
  listOp: (missionStore, missionId) => missionStore.listMilestones(missionId),
});

const fnSliceList = bindMissionHierarchyListTool({
  name: "fn_slice_list",
  parentParamKey: "milestoneId",
  childLabel: "slice",
  listOp: (missionStore, milestoneId) => missionStore.listSlices(milestoneId),
});

const fnFeatureList = bindMissionHierarchyListTool({
  name: "fn_feature_list",
  parentParamKey: "sliceId",
  childLabel: "feature",
  listOp: (missionStore, sliceId) => missionStore.listFeatures(sliceId),
});

function bindMissionHierarchyShowTool(config: {
  name: "fn_milestone_show" | "fn_slice_show" | "fn_feature_show";
  paramKey: "id";
  entityLabel: string;
  getOp: (missionStore: ReturnType<TaskStore["getMissionStore"]>, id: string) => { id: string; title: string; status: string; acceptanceCriteria?: string; verification?: string; taskId?: string; missionId?: string; milestoneId?: string; sliceId?: string } | undefined;
}): McpToolDefinition {
  return {
    name: config.name,
    description: `Show full details for a single ${config.entityLabel} by ID.`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: `${config.entityLabel} ID` } },
      required: ["id"],
    },
    async handler(store, args) {
      const id = String(args.id ?? "").trim();
      if (!id) return errorResult("id is required.");
      const missionStore = store.getMissionStore();
      const entity = config.getOp(missionStore, id);
      if (!entity) return errorResult(`${config.entityLabel[0].toUpperCase()}${config.entityLabel.slice(1)} ${id} not found`);

      const lines: string[] = [`${entity.id}: ${entity.title}`, `Status: ${entity.status}`];
      if (entity.missionId) lines.push(`Mission: ${entity.missionId}`);
      if (entity.milestoneId) lines.push(`Milestone: ${entity.milestoneId}`);
      if (entity.sliceId) lines.push(`Slice: ${entity.sliceId}`);
      if (entity.taskId) lines.push(`Linked task: ${entity.taskId}`);
      if (entity.verification) lines.push(`Verification: ${entity.verification}`);
      if (entity.acceptanceCriteria) lines.push(`Acceptance Criteria: ${entity.acceptanceCriteria}`);

      return textResult(lines.join("\n"), { structuredContent: redactSecretsDeep(entity) });
    },
  };
}

const fnMilestoneShow = bindMissionHierarchyShowTool({
  name: "fn_milestone_show",
  paramKey: "id",
  entityLabel: "milestone",
  getOp: (missionStore, id) => missionStore.getMilestone(id),
});

const fnSliceShow = bindMissionHierarchyShowTool({
  name: "fn_slice_show",
  paramKey: "id",
  entityLabel: "slice",
  getOp: (missionStore, id) => missionStore.getSlice(id),
});

const fnFeatureShow = bindMissionHierarchyShowTool({
  name: "fn_feature_show",
  paramKey: "id",
  entityLabel: "feature",
  getOp: (missionStore, id) => missionStore.getFeature(id),
});

// ── Mission hierarchy & goal mutation tools ────────────────────────────

/*
FNXC:McpServer 2026-07-11-10:30:
FUSI-018 adds the mutation half of the mission hierarchy plus a full goal
tool set to the BASE registry (no --allow-destructive gate — every one of
these sixteen tools is a reversible, non-cascading create/update/link
operation with no equivalent in DESTRUCTIVE_TOOL_TIER): fn_mission_create,
fn_mission_update, fn_milestone_add, fn_milestone_update, fn_slice_add,
fn_slice_activate, fn_feature_add, fn_feature_update, fn_feature_link_task,
fn_goal_list, fn_goal_show, fn_goal_create, fn_goal_archive,
fn_mission_link_goal, fn_mission_unlink_goal, fn_mission_list_goals. Every
handler dispatches to the SAME store.getMissionStore()/store.getGoalStore()
operation the pi-extension fn_* handlers in packages/cli/src/extension.ts
already call — no duplicated validation, no HTTP round-trip. This unblocks
the fn_goal_archive MCP tool deferred in FUSI-006 (see the FNXC:McpServer
2026-07-10-23:59 comment above fnTaskArchive): fn_goal_list/fn_goal_show now
exist (this task) to discover goal IDs first.

FNXC:McpServer 2026-07-11-10:30:
The pi-extension fn_goal_list/fn_goal_show handlers call
emitGoalRetrievalAudit(store, ctx, ...) to record pi-run-scoped
(agentId/runId/taskId) retrieval telemetry. That helper is intentionally NOT
replicated here: `fn mcp serve` has no pi run context (no agentId/runId/
taskId to attach), and the existing FUSI-017 mission/milestone/slice/feature
read handlers already omit pi-side audit for the same reason — this keeps
the MCP server's audit surface consistent (stderr destructive-audit only,
see auditDestructiveInvocation below).
*/

const fnMissionCreate: McpToolDefinition = {
  name: "fn_mission_create",
  description:
    "Create a new mission — a high-level objective that can span multiple milestones. Missions contain " +
    "milestones that break down work into phases.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Mission title — brief but descriptive" },
      description: { type: "string", description: "Detailed mission objectives and context" },
      autoAdvance: { type: "boolean", description: "Automatically activate the next pending slice when the current slice completes" },
      baseBranch: { type: "string", description: "Optional integration base branch for tasks triaged from this mission" },
    },
    required: ["title"],
  },
  async handler(store, args) {
    const title = String(args.title ?? "").trim();
    if (!title) return errorResult("title is required.");
    const missionStore = store.getMissionStore();

    const mission = missionStore.createMission({
      title,
      description: typeof args.description === "string" ? args.description.trim() : undefined,
      baseBranch: typeof args.baseBranch === "string" ? args.baseBranch.trim() || undefined : undefined,
    });

    if (args.autoAdvance !== undefined) {
      missionStore.updateMission(mission.id, { autoAdvance: args.autoAdvance === true });
    }

    const createdMission = missionStore.getMission(mission.id)!;
    return textResult(
      `Created ${createdMission.id}: ${createdMission.title}\nStatus: ${createdMission.status}${createdMission.autoAdvance ? "\nAuto-advance: enabled" : ""}`,
      {
        structuredContent: redactSecretsDeep({
          missionId: createdMission.id,
          title: createdMission.title,
          status: createdMission.status,
          autoAdvance: createdMission.autoAdvance ?? false,
        }),
      },
    );
  },
};

const fnMissionUpdate: McpToolDefinition = {
  name: "fn_mission_update",
  description: "Update an existing mission's title or description. Partial patches leave untouched fields intact.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Mission ID to update (e.g., M-001)" },
      title: { type: "string", description: "Updated mission title" },
      description: { type: "string", description: "Updated mission description" },
    },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const missionStore = store.getMissionStore();
    const existingMission = missionStore.getMission(id);
    if (!existingMission) return errorResult(`Mission ${id} not found`);

    const updates: { title?: string; description?: string } = {};
    if ("title" in args) updates.title = typeof args.title === "string" ? args.title.trim() : undefined;
    if ("description" in args) updates.description = typeof args.description === "string" ? args.description.trim() : undefined;

    if (Object.keys(updates).length === 0) {
      return errorResult("No fields to update (provide at least one of: title, description)");
    }

    const mission = missionStore.updateMission(id, updates);
    return textResult(`Updated ${mission.id}: "${mission.title}"`, {
      structuredContent: redactSecretsDeep({ missionId: mission.id, title: mission.title, description: mission.description, status: mission.status }),
    });
  },
};

const fnMilestoneAdd: McpToolDefinition = {
  name: "fn_milestone_add",
  description: "Add a milestone to a mission. Milestones represent phases of work.",
  inputSchema: {
    type: "object",
    properties: {
      missionId: { type: "string", description: "Parent mission ID (e.g., M-001)" },
      title: { type: "string", description: "Milestone title" },
      description: { type: "string", description: "Milestone description" },
    },
    required: ["missionId", "title"],
  },
  async handler(store, args) {
    const missionId = String(args.missionId ?? "").trim();
    const title = String(args.title ?? "").trim();
    if (!missionId) return errorResult("missionId is required.");
    if (!title) return errorResult("title is required.");

    const missionStore = store.getMissionStore();
    const mission = missionStore.getMission(missionId);
    if (!mission) return errorResult(`Mission ${missionId} not found`);

    const milestone = missionStore.addMilestone(missionId, {
      title,
      description: typeof args.description === "string" ? args.description.trim() : undefined,
    });

    return textResult(`Added ${milestone.id}: "${milestone.title}" to ${missionId}`, {
      structuredContent: redactSecretsDeep({ milestoneId: milestone.id, missionId, title: milestone.title }),
    });
  },
};

const fnMilestoneUpdate: McpToolDefinition = {
  name: "fn_milestone_update",
  description:
    "Update an existing milestone's title, description, or acceptance criteria (the structured pass/fail bar, " +
    "distinct from verification's free-form how-to-confirm notes). Partial patches leave untouched fields intact.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Milestone ID to update (e.g., MS-001)" },
      title: { type: "string", description: "Updated milestone title" },
      description: { type: "string", description: "Updated milestone description" },
      acceptanceCriteria: { type: "string", description: "Updated acceptance criteria for completing the milestone" },
    },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const missionStore = store.getMissionStore();
    const existingMilestone = missionStore.getMilestone(id);
    if (!existingMilestone) return errorResult(`Milestone ${id} not found`);

    const updates: { title?: string; description?: string; acceptanceCriteria?: string } = {};
    if ("title" in args) updates.title = typeof args.title === "string" ? args.title.trim() : undefined;
    if ("description" in args) updates.description = typeof args.description === "string" ? args.description.trim() : undefined;
    if ("acceptanceCriteria" in args) updates.acceptanceCriteria = typeof args.acceptanceCriteria === "string" ? args.acceptanceCriteria.trim() : undefined;

    if (Object.keys(updates).length === 0) {
      return errorResult("No fields to update (provide at least one of: title, description, acceptanceCriteria)");
    }

    const milestone = missionStore.updateMilestone(id, updates);
    return textResult(`Updated ${milestone.id}: "${milestone.title}"`, {
      structuredContent: redactSecretsDeep({
        milestoneId: milestone.id,
        title: milestone.title,
        description: milestone.description,
        acceptanceCriteria: milestone.acceptanceCriteria,
        status: milestone.status,
      }),
    });
  },
};

const fnSliceAdd: McpToolDefinition = {
  name: "fn_slice_add",
  description: "Add a slice to a milestone. Slices are work units that can be activated for implementation.",
  inputSchema: {
    type: "object",
    properties: {
      milestoneId: { type: "string", description: "Parent milestone ID (e.g., MS-001)" },
      title: { type: "string", description: "Slice title" },
      description: { type: "string", description: "Slice description" },
    },
    required: ["milestoneId", "title"],
  },
  async handler(store, args) {
    const milestoneId = String(args.milestoneId ?? "").trim();
    const title = String(args.title ?? "").trim();
    if (!milestoneId) return errorResult("milestoneId is required.");
    if (!title) return errorResult("title is required.");

    const missionStore = store.getMissionStore();
    const milestone = missionStore.getMilestone(milestoneId);
    if (!milestone) return errorResult(`Milestone ${milestoneId} not found`);

    const slice = missionStore.addSlice(milestoneId, {
      title,
      description: typeof args.description === "string" ? args.description.trim() : undefined,
    });

    return textResult(`Added ${slice.id}: "${slice.title}" to ${milestoneId}`, {
      structuredContent: redactSecretsDeep({ sliceId: slice.id, milestoneId, title: slice.title }),
    });
  },
};

const fnSliceActivate: McpToolDefinition = {
  name: "fn_slice_activate",
  description: "Activate a pending slice for implementation. Sets status to 'active' and enables task linking for its features.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Slice ID to activate (e.g., SL-001)" } },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const missionStore = store.getMissionStore();
    const slice = missionStore.getSlice(id);
    if (!slice) return errorResult(`Slice ${id} not found`);
    if (slice.status !== "pending") {
      return errorResult(`Slice ${id} is not pending (status: ${slice.status})`, { structuredContent: { sliceId: id, currentStatus: slice.status } });
    }

    const activated = await missionStore.activateSlice(id);
    return textResult(`Activated ${activated.id}: "${activated.title}"\nStatus: ${activated.status}`, {
      structuredContent: redactSecretsDeep({ sliceId: activated.id, title: activated.title, status: activated.status }),
    });
  },
};

const fnFeatureAdd: McpToolDefinition = {
  name: "fn_feature_add",
  description: "Add a feature to a slice. Features are deliverables that can be linked to tasks.",
  inputSchema: {
    type: "object",
    properties: {
      sliceId: { type: "string", description: "Parent slice ID (e.g., SL-001)" },
      title: { type: "string", description: "Feature title" },
      description: { type: "string", description: "Feature description" },
      acceptanceCriteria: { type: "string", description: "Acceptance criteria for completing the feature" },
    },
    required: ["sliceId", "title"],
  },
  async handler(store, args) {
    const sliceId = String(args.sliceId ?? "").trim();
    const title = String(args.title ?? "").trim();
    if (!sliceId) return errorResult("sliceId is required.");
    if (!title) return errorResult("title is required.");

    const missionStore = store.getMissionStore();
    const slice = missionStore.getSlice(sliceId);
    if (!slice) return errorResult(`Slice ${sliceId} not found`);

    const feature = missionStore.addFeature(sliceId, {
      title,
      description: typeof args.description === "string" ? args.description.trim() : undefined,
      acceptanceCriteria: typeof args.acceptanceCriteria === "string" ? args.acceptanceCriteria.trim() : undefined,
    });

    return textResult(`Added ${feature.id}: "${feature.title}" to ${sliceId}`, {
      structuredContent: redactSecretsDeep({ featureId: feature.id, sliceId, title: feature.title }),
    });
  },
};

const fnFeatureUpdate: McpToolDefinition = {
  name: "fn_feature_update",
  description: "Update an existing feature's title, description, or acceptance criteria. Partial patches leave untouched fields intact.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Feature ID to update (e.g., F-001)" },
      title: { type: "string", description: "Updated feature title" },
      description: { type: "string", description: "Updated feature description" },
      acceptanceCriteria: { type: "string", description: "Updated acceptance criteria for completing the feature" },
    },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const missionStore = store.getMissionStore();
    const existingFeature = missionStore.getFeature(id);
    if (!existingFeature) return errorResult(`Feature ${id} not found`);

    const updates: { title?: string; description?: string; acceptanceCriteria?: string } = {};
    if ("title" in args) updates.title = typeof args.title === "string" ? args.title.trim() : undefined;
    if ("description" in args) updates.description = typeof args.description === "string" ? args.description.trim() : undefined;
    if ("acceptanceCriteria" in args) updates.acceptanceCriteria = typeof args.acceptanceCriteria === "string" ? args.acceptanceCriteria.trim() : undefined;

    if (Object.keys(updates).length === 0) {
      return errorResult("No fields to update (provide at least one of: title, description, acceptanceCriteria)");
    }

    const feature = missionStore.updateFeature(id, updates);
    return textResult(`Updated ${feature.id}: "${feature.title}"`, {
      structuredContent: redactSecretsDeep({
        featureId: feature.id,
        sliceId: feature.sliceId,
        title: feature.title,
        description: feature.description,
        acceptanceCriteria: feature.acceptanceCriteria,
        status: feature.status,
      }),
    });
  },
};

const fnFeatureLinkTask: McpToolDefinition = {
  name: "fn_feature_link_task",
  description:
    "Link a feature to a fn task for implementation. Updates the feature status to 'triaged' and associates it " +
    "with the task. If the target task is not on the active board (for example archived, deleted, or never " +
    "created), the tool returns a clear validation error indicating that only active tasks can be linked.",
  inputSchema: {
    type: "object",
    properties: {
      featureId: { type: "string", description: "Feature ID to link (e.g., F-001)" },
      taskId: { type: "string", description: "Task ID to link to (e.g., FN-001)" },
    },
    required: ["featureId", "taskId"],
  },
  async handler(store, args) {
    const featureId = String(args.featureId ?? "").trim();
    const taskId = String(args.taskId ?? "").trim();
    if (!featureId) return errorResult("featureId is required.");
    if (!taskId) return errorResult("taskId is required.");

    const missionStore = store.getMissionStore();
    const feature = missionStore.getFeature(featureId);
    if (!feature) return errorResult(`Feature ${featureId} not found`);

    try {
      await store.getTask(taskId);
    } catch {
      return errorResult(`Task ${taskId} not found`);
    }

    try {
      const updated = missionStore.linkFeatureToTask(featureId, taskId);
      await store.updateTask(taskId, { sliceId: feature.sliceId });
      return textResult(`Linked ${updated.id}: "${updated.title}" → ${taskId}\nStatus: ${updated.status}`, {
        structuredContent: redactSecretsDeep({ featureId: updated.id, taskId, title: updated.title, status: updated.status }),
      });
    } catch (error) {
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    }
  },
};

const GOAL_LIST_HARD_LIMIT = 5;
const GOAL_LIST_SOFT_WARNING_THRESHOLD = 3;
const GOAL_SNIPPET_MAX_CHARS = 80;

function buildGoalSnippet(description?: string): string | undefined {
  const firstLine = description?.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim();
  if (!firstLine) return undefined;
  if (firstLine.length <= GOAL_SNIPPET_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, GOAL_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

function buildGoalListEntry(goal: { id: string; title: string; status: string; description?: string }) {
  const snippet = buildGoalSnippet(goal.description);
  return snippet ? { id: goal.id, title: goal.title, status: goal.status, snippet } : { id: goal.id, title: goal.title, status: goal.status };
}

function formatGoalListLine(goal: { id: string; title: string; status: string; snippet?: string }): string {
  return `- ${goal.id} [${goal.status}] ${goal.title}${goal.snippet ? ` — ${goal.snippet}` : ""}`;
}

const fnGoalList: McpToolDefinition = {
  name: "fn_goal_list",
  description: "List goals by status with active-goal warning details.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "archived", "all"], description: "Filter by goal status (default: active)" },
    },
  },
  async handler(store, args) {
    const goalStore = store.getGoalStore();
    const status = (typeof args.status === "string" ? args.status : "active") as "active" | "archived" | "all";
    const goals = status === "all" ? goalStore.listGoals() : goalStore.listGoals({ status });
    const activeCount = goalStore.listGoals({ status: "active" }).length;
    const softWarning = activeCount >= GOAL_LIST_SOFT_WARNING_THRESHOLD;
    const goalEntries = goals.map(buildGoalListEntry);

    const lines: string[] = [];
    lines.push(`Goals (${goals.length}) [filter: ${status}]`);
    lines.push(`Active: ${activeCount}/${GOAL_LIST_HARD_LIMIT}`);
    if (softWarning) {
      lines.push(`⚠  ${GOAL_LIST_SOFT_WARNING_THRESHOLD}/${GOAL_LIST_HARD_LIMIT} active goals — soft warning at ${GOAL_LIST_SOFT_WARNING_THRESHOLD}, hard cap at ${GOAL_LIST_HARD_LIMIT}`);
    }
    lines.push("");
    if (goalEntries.length === 0) {
      lines.push("No goals found.");
    } else {
      lines.push(...goalEntries.map(formatGoalListLine));
    }

    return textResult(lines.join("\n"), {
      structuredContent: redactSecretsDeep({ goals: goalEntries, activeCount, softWarning, hardLimit: GOAL_LIST_HARD_LIMIT }),
    });
  },
};

const fnGoalShow: McpToolDefinition = {
  name: "fn_goal_show",
  description: "Show full details for a single goal by ID.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Goal ID (G-…)" } },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const goalStore = store.getGoalStore();
    const goal = goalStore.getGoal(id);
    if (!goal) return errorResult(`Goal ${id} not found`, { structuredContent: { code: "GOAL_NOT_FOUND", goalId: id } });

    const lines: string[] = [`${goal.id}: ${goal.title}`, `Status: ${goal.status}`, `Created: ${goal.createdAt}`, `Updated: ${goal.updatedAt}`];
    if (goal.description) lines.push(`Description: ${goal.description}`);

    return textResult(lines.join("\n"), { structuredContent: redactSecretsDeep({ goal }) });
  },
};

const fnGoalCreate: McpToolDefinition = {
  name: "fn_goal_create",
  description: "Create a new project goal.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Goal title — brief but descriptive" },
      description: { type: "string", description: "Long-form goal description (free-text markdown)" },
    },
    required: ["title"],
  },
  async handler(store, args) {
    const title = String(args.title ?? "").trim();
    if (!title) return errorResult("title is required.");
    const goalStore = store.getGoalStore();

    try {
      const goal = goalStore.createGoal({
        title,
        description: typeof args.description === "string" ? args.description.trim() || undefined : undefined,
      });
      const activeCount = goalStore.listGoals({ status: "active" }).length;
      const softWarning = activeCount >= GOAL_LIST_SOFT_WARNING_THRESHOLD;
      return textResult(
        `Created ${goal.id}: ${goal.title}\nStatus: ${goal.status}${softWarning ? `\n⚠  ${activeCount}/${GOAL_LIST_HARD_LIMIT} active goals — approaching hard cap` : ""}`,
        { structuredContent: redactSecretsDeep({ goalId: goal.id, title: goal.title, status: goal.status, softWarning }) },
      );
    } catch (error) {
      if (error instanceof ActiveGoalLimitExceededError) {
        return errorResult(
          `Cannot create goal — already at the hard cap of ${error.limit} active goals (currently ${error.currentActive}). Archive one first.`,
          { structuredContent: { code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit: error.limit, currentActive: error.currentActive } },
        );
      }
      throw error;
    }
  },
};

const fnGoalArchive: McpToolDefinition = {
  name: "fn_goal_archive",
  description: "Archive a goal by ID.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Goal ID (G-…) to archive" } },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    const goalStore = store.getGoalStore();
    const goal = goalStore.getGoal(id);
    if (!goal) return errorResult(`Goal ${id} not found`, { structuredContent: { code: "GOAL_NOT_FOUND", goalId: id } });

    if (goal.status === "archived") {
      return textResult(`Goal ${id} is already archived`, { structuredContent: { goalId: id, status: "archived" } });
    }

    const archived = goalStore.archiveGoal(id);
    return textResult(`Archived ${archived.id}: ${archived.title}`, {
      structuredContent: redactSecretsDeep({ goalId: archived.id, status: "archived" }),
    });
  },
};

const fnMissionListGoals: McpToolDefinition = {
  name: "fn_mission_list_goals",
  description: "List goals linked to a mission.",
  inputSchema: {
    type: "object",
    properties: { missionId: { type: "string", description: "Mission ID (e.g., M-001)" } },
    required: ["missionId"],
  },
  async handler(store, args) {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId) return errorResult("missionId is required.");
    const missionStore = store.getMissionStore();
    const goalStore = store.getGoalStore();
    const mission = missionStore.getMission(missionId);
    if (!mission) return errorResult(`Mission ${missionId} not found`, { structuredContent: { code: "MISSION_NOT_FOUND", missionId } });

    const goals = missionStore
      .listGoalIdsForMission(missionId)
      .map((goalId) => goalStore.getGoal(goalId))
      .filter((goal): goal is NonNullable<typeof goal> => Boolean(goal));

    const lines = [`Linked goals for ${mission.id}: ${mission.title}`];
    if (goals.length === 0) {
      lines.push("No linked goals.");
    } else {
      for (const goal of goals) {
        const description = goal.description ? ` — ${goal.description}` : "";
        lines.push(`- ${goal.id} [${goal.status}] ${goal.title}${description}`);
      }
    }

    return textResult(lines.join("\n"), {
      structuredContent: redactSecretsDeep({ missionId: mission.id, missionTitle: mission.title, goals }),
    });
  },
};

const fnMissionLinkGoal: McpToolDefinition = {
  name: "fn_mission_link_goal",
  description: "Link a goal to a mission.",
  inputSchema: {
    type: "object",
    properties: {
      missionId: { type: "string", description: "Mission ID (e.g., M-001)" },
      goalId: { type: "string", description: "Goal ID (e.g., G-001)" },
    },
    required: ["missionId", "goalId"],
  },
  async handler(store, args) {
    const missionId = String(args.missionId ?? "").trim();
    const goalId = String(args.goalId ?? "").trim();
    if (!missionId) return errorResult("missionId is required.");
    if (!goalId) return errorResult("goalId is required.");

    const missionStore = store.getMissionStore();
    const goalStore = store.getGoalStore();
    const mission = missionStore.getMission(missionId);
    if (!mission) return errorResult(`Mission ${missionId} not found`, { structuredContent: { code: "MISSION_NOT_FOUND", missionId } });

    const goal = goalStore.getGoal(goalId);
    if (!goal) return errorResult(`Goal ${goalId} not found`, { structuredContent: { code: "GOAL_NOT_FOUND", goalId } });
    if (goal.status === "archived") {
      return errorResult(`Goal ${goalId} is archived and cannot be linked`, { structuredContent: { code: "GOAL_ARCHIVED", goalId } });
    }

    missionStore.linkGoal(missionId, goalId);
    const goals = missionStore
      .listGoalIdsForMission(missionId)
      .map((id) => goalStore.getGoal(id))
      .filter((linkedGoal): linkedGoal is NonNullable<typeof linkedGoal> => Boolean(linkedGoal));

    return textResult(`Linked ${goal.id}: ${goal.title} → ${mission.id}`, {
      structuredContent: redactSecretsDeep({ missionId: mission.id, missionTitle: mission.title, goal, goals }),
    });
  },
};

const fnMissionUnlinkGoal: McpToolDefinition = {
  name: "fn_mission_unlink_goal",
  description: "Unlink a goal from a mission.",
  inputSchema: {
    type: "object",
    properties: {
      missionId: { type: "string", description: "Mission ID (e.g., M-001)" },
      goalId: { type: "string", description: "Goal ID (e.g., G-001)" },
    },
    required: ["missionId", "goalId"],
  },
  async handler(store, args) {
    const missionId = String(args.missionId ?? "").trim();
    const goalId = String(args.goalId ?? "").trim();
    if (!missionId) return errorResult("missionId is required.");
    if (!goalId) return errorResult("goalId is required.");

    const missionStore = store.getMissionStore();
    const goalStore = store.getGoalStore();
    const mission = missionStore.getMission(missionId);
    if (!mission) return errorResult(`Mission ${missionId} not found`, { structuredContent: { code: "MISSION_NOT_FOUND", missionId } });

    const goal = goalStore.getGoal(goalId);
    if (!goal) return errorResult(`Goal ${goalId} not found`, { structuredContent: { code: "GOAL_NOT_FOUND", goalId } });

    missionStore.unlinkGoal(missionId, goalId);
    const goals = missionStore
      .listGoalIdsForMission(missionId)
      .map((id) => goalStore.getGoal(id))
      .filter((linkedGoal): linkedGoal is NonNullable<typeof linkedGoal> => Boolean(linkedGoal));

    return textResult(`Unlinked ${goal.id}: ${goal.title} from ${mission.id}`, {
      structuredContent: redactSecretsDeep({ missionId: mission.id, missionTitle: mission.title, goal, goals }),
    });
  },
};

// ── Settings tools ────────────────────────────────────────────────────

const SETTINGS_SCOPES = ["project", "global", "effective"] as const;
type SettingsScope = (typeof SETTINGS_SCOPES)[number];

/*
FNXC:McpServer 2026-07-11-09:30:
BASE-tier (not destructive) settings read — scope-selected (`project` /
`global` / `effective`), dispatching to the SAME `TaskStore.getSettings()`
(fully merged effective settings) / `TaskStore.getSettingsByScope()`
(scope-separated project/global reads) operations used by `fn config` and
every other Fusion settings surface — no bespoke settings-read logic is
introduced here. {@link redactSecretsDeep} is mandatory on the returned
object before it is placed in EITHER the text body or `structuredContent`:
settings objects can carry secret-ref/token-bearing fields (e.g. `mcpServers`
env/header secret refs), and this is a read tool with no destructive gate,
so redaction is the only thing standing between a misconfigured settings
value and a leaked secret over the MCP wire.
*/
const fnSettingsGet: McpToolDefinition = {
  name: "fn_settings_get",
  description:
    "Read Fusion settings for a selected scope (project, global, or the fully merged effective settings). " +
    "All secret-like values (tokens, API keys, passwords, MCP secret refs) are redacted before being returned. " +
    "Base-tier read — does not require --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: [...SETTINGS_SCOPES],
        description: "Which settings to read: 'project' (project-scope only), 'global' (global-scope only), or 'effective' (fully merged; default).",
      },
    },
  },
  async handler(store, args) {
    const scopeArg = typeof args.scope === "string" ? args.scope : "effective";
    if (!SETTINGS_SCOPES.includes(scopeArg as SettingsScope)) {
      return errorResult("scope must be one of: project, global, effective.");
    }
    const scope = scopeArg as SettingsScope;

    let settings: unknown;
    if (scope === "effective") {
      settings = await store.getSettings();
    } else {
      const byScope = await store.getSettingsByScope();
      settings = scope === "project" ? byScope.project : byScope.global;
    }

    const redacted = redactSecretsDeep({ scope, settings }) as { scope: SettingsScope; settings: Record<string, unknown> };
    return textResult(`Settings (scope: ${scope}):\n${JSON.stringify(redacted.settings, null, 2)}`, {
      structuredContent: redacted,
    });
  },
};

// ── Project tools (read-only) ──────────────────────────────────────

/*
FNXC:McpServer 2026-07-11-10:00:
FUSI-020 adds `fn_project_list`/`fn_project_show` — BASE-tier reads over
`CentralCore.listProjects()`/`getProject()`, the SAME central-registry
primitives the `fn project list`/`fn project show` CLI commands
(packages/cli/src/commands/project.ts) already call. There is no
pi-extension `fn_project_*` precedent to mirror, so these tool shapes are
defined fresh here, following the McpToolDefinition conventions established
by the tools above.

CRITICAL: unlike every OTHER handler in this registry, project handlers get
NO store/context-provided project database — `McpToolRuntimeContext` only
ever carries `cwd`/`allowDestructive`, and the FIRST handler argument
(`store: TaskStore`) is scoped to the SINGLE project `fn mcp serve` was
launched for. `CentralCore` is Fusion's GLOBAL cross-project registry
(`~/.fusion/fusion-central.db`), so every project handler below constructs
its OWN `new CentralCore()`, calls `await init()`, and ALWAYS `close()`s it
in a `finally` block — exactly the lifecycle `packages/cli/src/commands/
project.ts` uses. This means an MCP session started for ONE project can
read (list/show, base-tier) or mutate (create/update/remove, destructive-
tier — see the FNXC:McpServer note above {@link DESTRUCTIVE_TOOL_TIER})
the registry entry for ANY other registered project on the machine. That
cross-project blast radius is precisely why create/update/remove sit behind
`--allow-destructive` even though `fn_project_remove` itself is a reversible,
registry-entry-only operation — see docs/mcp.md's Projects section for the
operator-facing callout.
*/

async function findProjectByNameOrId(central: CentralCore, nameOrId: string): Promise<RegisteredProject | undefined> {
  const byId = await central.getProject(nameOrId);
  if (byId) return byId;
  const all = await central.listProjects();
  const lower = nameOrId.toLowerCase();
  return all.find((p) => p.name.toLowerCase() === lower);
}

function renderProjectSummaryLine(project: RegisteredProject): string {
  return `  ${project.id}: ${project.name} (${project.status} \u00b7 ${project.isolationMode}) \u2014 ${project.path}`;
}

const fnProjectList: McpToolDefinition = {
  name: "fn_project_list",
  description:
    "List every project registered in Fusion's central cross-project registry (not just the current project). " +
    "Base-tier read — does not require --allow-destructive.",
  inputSchema: { type: "object", properties: {} },
  async handler(_store, _args) {
    const central = new CentralCore();
    await central.init();
    try {
      const projects = await central.listProjects();
      if (projects.length === 0) {
        return textResult("No projects registered.", { structuredContent: { count: 0, projects: [] } });
      }

      const lines = [`Projects (${projects.length})`, ...projects.map(renderProjectSummaryLine)];
      return textResult(lines.join("\n"), {
        structuredContent: redactSecretsDeep({
          count: projects.length,
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            status: p.status,
            isolationMode: p.isolationMode,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            lastActivityAt: p.lastActivityAt,
          })),
        }),
      });
    } finally {
      await central.close();
    }
  },
};

const fnProjectShow: McpToolDefinition = {
  name: "fn_project_show",
  description:
    "Show full central-registry detail for a single project by id (or by exact name). " +
    "Base-tier read — does not require --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Project id (e.g. proj_...) or exact project name" } },
    required: ["id"],
  },
  async handler(_store, args) {
    const idArg = String(args.id ?? "").trim();
    if (!idArg) return errorResult("id is required.");

    const central = new CentralCore();
    await central.init();
    try {
      const project = await findProjectByNameOrId(central, idArg);
      if (!project) return errorResult(`Project ${idArg} not found`);

      const lines = [
        `${project.id}: ${project.name}`,
        `Status: ${project.status}`,
        `Isolation: ${project.isolationMode}`,
        `Path: ${project.path}`,
        `Created: ${project.createdAt}`,
        `Updated: ${project.updatedAt}`,
      ];
      if (project.lastActivityAt) lines.push(`Last activity: ${project.lastActivityAt}`);

      return textResult(lines.join("\n"), { structuredContent: redactSecretsDeep(project) });
    } finally {
      await central.close();
    }
  },
};

export const MCP_TOOL_REGISTRY: McpToolDefinition[] = [
  fnTaskCreate,
  fnTaskList,
  fnTaskShow,
  fnTaskSearch,
  fnTaskArchive,
  fnTaskUpdate,
  fnDelegateTask,
  fnListAgents,
  fnAgentShow,
  fnAgentCreate,
  fnAgentStart,
  fnAgentStop,
  fnWorkflowList,
  fnWorkflowGet,
  fnWorkflowCreate,
  fnWorkflowUpdate,
  fnWorkflowSelect,
  fnWorkflowSettings,
  fnWorkflowAddNode,
  fnWorkflowRemoveNode,
  fnWorkflowAddEdge,
  fnWorkflowRemoveEdge,
  fnMissionList,
  fnMissionShow,
  fnMilestoneList,
  fnMilestoneShow,
  fnSliceList,
  fnSliceShow,
  fnFeatureList,
  fnFeatureShow,
  fnMissionCreate,
  fnMissionUpdate,
  fnMilestoneAdd,
  fnMilestoneUpdate,
  fnSliceAdd,
  fnSliceActivate,
  fnFeatureAdd,
  fnFeatureUpdate,
  fnFeatureLinkTask,
  fnGoalList,
  fnGoalShow,
  fnGoalCreate,
  fnGoalArchive,
  fnMissionLinkGoal,
  fnMissionUnlinkGoal,
  fnMissionListGoals,
  fnSettingsGet,
  fnProjectList,
  fnProjectShow,
];

// ── Destructive tools (opt-in via --allow-destructive) ─────────────────────

/*
FNXC:McpServer 2026-07-10-22:10:
Operator audit line for every destructive invocation. Written to STDERR ONLY
— stdout is the MCP protocol transport channel and must never carry
diagnostic output (mirrors the FUSI-001 `fn mcp serve` stderr-only logging
convention in packages/cli/src/commands/mcp.ts). Payload is ids/counts/
outcomes-only (tool name, resource id, outcome) per the AGENTS.md run-audit
convention — never prose, never a raw secret value.
*/
function auditDestructiveInvocation(entry: { tool: string; resourceId: string; outcome: string }): void {
  console.error(`[fn mcp serve] DESTRUCTIVE ${entry.tool} resourceId=${entry.resourceId} outcome=${entry.outcome}`);
}

const fnTaskDelete: McpToolDefinition = {
  name: "fn_task_delete",
  description:
    "DESTRUCTIVE: soft-delete a task from active Fusion board views. The task row and artifacts are preserved; " +
    "optional allowResurrection marks the ID for intentional recreation. If the task is still referenced as a " +
    "lineage parent by another task, deletion is rejected unless removeLineageReferences:true is passed. " +
    "Only registered when `fn mcp serve` is started with --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID to delete (e.g. FN-001)" },
      allowResurrection: { type: "boolean", description: "When true, mark this tombstone as explicitly reusable for future recreation." },
      removeLineageReferences: {
        type: "boolean",
        description: "When true, clear incoming lineage-parent references (child sourceParentTaskId) before deleting, so a task still referenced as a lineage parent can be removed.",
      },
    },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");
    try {
      const task = await store.deleteTask(id, {
        allowResurrection: args.allowResurrection === true,
        removeLineageReferences: args.removeLineageReferences === true,
        auditContext: {
          agentId: "mcp-operator",
          runId: `synthetic-mcp-delete-${id}-${Date.now()}`,
        },
      });
      auditDestructiveInvocation({ tool: "fn_task_delete", resourceId: task.id, outcome: "deleted" });
      return textResult(`Deleted ${task.id}`, { structuredContent: { taskId: task.id, outcome: "deleted" } });
    } catch (error) {
      auditDestructiveInvocation({ tool: "fn_task_delete", resourceId: id, outcome: "error" });
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    }
  },
};

const fnAgentDelete: McpToolDefinition = {
  name: "fn_agent_delete",
  description:
    "DESTRUCTIVE: delete a non-ephemeral agent. Subject to the same agent-provisioning policy " +
    "(allow/require-approval/deny) fn_agent_create uses. Only registered when `fn mcp serve` is started with " +
    "--allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Agent ID to delete" },
      force: { type: "boolean", description: "Force delete when holding checkout" },
      reassign_to: { type: "string", description: "Optional replacement agent for assigned tasks" },
    },
    required: ["agent_id"],
  },
  async handler(store, args, ctx) {
    const agentId = String(args.agent_id ?? "").trim();
    if (!agentId) return errorResult("agent_id is required.");

    const agentStore = await getAgentStore(ctx.cwd);
    /*
    FNXC:McpServer 2026-07-10-22:10:
    Reuses the SAME resolveAgentProvisioningPolicy gate the pi-extension
    fn_agent_delete handler uses (packages/cli/src/extension.ts) — never
    bypassed. `deny` and `require-approval` decisions never reach
    AgentStore.deleteAgent.
    */
    const caller = { id: "user", role: "user", isPrivileged: true } as const;
    const policy = resolveAgentProvisioningPolicy({ tool: "fn_agent_delete", caller, settings: await store.getSettings() });

    if (policy.decision === "require-approval") {
      const approvalStore = new ApprovalRequestStore(store.getDatabase());
      const request = approvalStore.create({
        requester: { actorId: "user", actorType: "user", actorName: "MCP Operator" },
        targetAction: {
          category: "agent_provisioning",
          action: "delete",
          summary: `Delete agent ${agentId}`,
          resourceType: "agent",
          resourceId: agentId,
          context: { tool: "fn_agent_delete", params: redactSecretsDeep(args) },
        },
      });
      auditDestructiveInvocation({ tool: "fn_agent_delete", resourceId: agentId, outcome: "pending_approval" });
      return textResult(`Approval required. Request ${request.id} created.`, {
        structuredContent: { outcome: "pending_approval", approvalRequestId: request.id, matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId },
      });
    }

    if (policy.decision === "deny") {
      auditDestructiveInvocation({ tool: "fn_agent_delete", resourceId: agentId, outcome: "denied" });
      return textResult(`DENIED: agent delete blocked by policy (${policy.matchedRule})`, {
        structuredContent: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId },
      });
    }

    await agentStore.deleteAgent(agentId, {
      force: args.force === true,
      reassignTo: typeof args.reassign_to === "string" ? args.reassign_to : undefined,
    });
    auditDestructiveInvocation({ tool: "fn_agent_delete", resourceId: agentId, outcome: "deleted" });
    return textResult(`Deleted ${agentId}`, {
      structuredContent: { outcome: "deleted", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId },
    });
  },
};

/*
FNXC:McpServer 2026-07-10-22:10:
fn_workflow_delete wraps the shared bindWorkflowTool binding (same
createWorkflowAuthoringTools factory as the base v1 workflow tools, and the
SAME pi-extension fn_workflow_delete dispatch path) with a stderr audit line
and the DESTRUCTIVE description; it does not duplicate the store's built-in
workflow protection or occupied-column handling.
*/
const fnWorkflowDeleteAudited: McpToolDefinition = {
  ...fnWorkflowDelete,
  async handler(store, args, ctx) {
    const workflowId = typeof args.workflow_id === "string" ? args.workflow_id.trim() : "";
    const result = await fnWorkflowDelete.handler(store, args, ctx);
    auditDestructiveInvocation({
      tool: "fn_workflow_delete",
      resourceId: workflowId || "unknown",
      outcome: result.isError ? "error" : "deleted",
    });
    return result;
  },
};

/*
FNXC:McpServer 2026-07-10-23:45:
FUSI-005 extends the destructive tier with the mission-hierarchy delete
tools (`fn_mission_delete`, `fn_milestone_delete`, `fn_slice_delete`,
`fn_feature_delete`). Design decision recorded in FUSI-005's task document
(key="design"; FUSI-004 recorded no decision document, so this task's own
recommended defaults were adopted):
  1. `force` contract — `fn_milestone_delete`/`fn_slice_delete`/
     `fn_feature_delete` expose an optional `force` boolean mirroring the
     pi-extension handlers 1:1 (overrides the MissionStore live-task-link
     guard); a distinct `forced=true` marker is added to the audit line
     when `force=true` is passed. `fn_mission_delete` exposes NO `force` —
     `MissionStore.deleteMission` has no force param and always cascades
     unconditionally, so there is no guard to override.
  2. Gate strength — `fn_mission_delete`'s cascade (deletes every
     descendant milestone/slice/feature and unlinks every task-linked
     feature) reuses the SAME `--allow-destructive` flag as the rest of the
     tier rather than a second gate: the local-stdio operator-privileged
     trust model is unchanged from the rest of FUSI-002's tier, so a second
     flag would add friction without a corresponding new adversary. As a
     compensating control, `fn_mission_delete`'s audit line is enriched
     with a pre-delete cascade summary (descendant counts + task-link
     count) since the rows are gone once `deleteMission` returns.
  3. No provisioning-policy-equivalent hook exists for ANY of these four
     MissionStore operations (unlike `fn_agent_delete`'s
     `resolveAgentProvisioningPolicy` reuse) — none is invented here; the
     only gate is `--allow-destructive` plus the store's own (unbypassed)
     live-task-link guard for milestone/slice/feature deletion.
Every handler below binds directly to the same `store.getMissionStore()`
operation the pi-extension `fn_mission_delete`/`fn_milestone_delete`/
`fn_slice_delete`/`fn_feature_delete` handlers in packages/cli/src/extension.ts
call — no duplicated validation, no HTTP dashboard round-trip.
*/

const fnMissionDelete: McpToolDefinition = {
  name: "fn_mission_delete",
  description:
    "DESTRUCTIVE: delete a mission and all its milestones, slices, and features. Cascades to ALL descendants and " +
    "unlinks every task-linked feature (the linked tasks themselves are NOT deleted, only the feature/mission " +
    "association is cleared). Cannot be undone. Only registered when `fn mcp serve` is started with " +
    "--allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Mission ID to delete (e.g., M-001)" },
    },
    required: ["id"],
  },
  async handler(store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");

    const missionStore = store.getMissionStore();
    const mission = missionStore.getMission(id);
    if (!mission) {
      auditDestructiveInvocation({ tool: "fn_mission_delete", resourceId: id, outcome: "error" });
      return errorResult(`Mission ${id} not found`);
    }

    /*
    FNXC:McpServer 2026-07-10-23:45:
    Cascade summary MUST be captured before deleteMission() runs — the
    milestone/slice/feature rows are gone once the delete completes. Counts
    use the same listMilestones/listSlices/listFeatures reads the store's
    own getMissionSummary()/getMissionWithHierarchy() helpers use; no
    bespoke count query is added.
    */
    const milestones = missionStore.listMilestones(id);
    const slices = milestones.flatMap((milestone) => missionStore.listSlices(milestone.id));
    const features = slices.flatMap((slice) => missionStore.listFeatures(slice.id));
    const linkedTaskCount = features.filter((feature) => Boolean(feature.taskId)).length;

    missionStore.deleteMission(id);

    auditDestructiveInvocation({
      tool: "fn_mission_delete",
      resourceId: id,
      outcome: "deleted",
    });
    console.error(
      `[fn mcp serve] DESTRUCTIVE fn_mission_delete cascade missionId=${id} title=${JSON.stringify(mission.title)} ` +
        `milestones=${milestones.length} slices=${slices.length} features=${features.length} taskLinksCleared=${linkedTaskCount}`,
    );

    return textResult(`Deleted ${id}: "${mission.title}"`, {
      structuredContent: {
        missionId: id,
        title: mission.title,
        outcome: "deleted",
        cascade: { milestones: milestones.length, slices: slices.length, features: features.length, taskLinksCleared: linkedTaskCount },
      },
    });
  },
};

function bindMissionHierarchyDeleteTool(config: {
  name: "fn_milestone_delete" | "fn_slice_delete" | "fn_feature_delete";
  paramKey: "milestoneId" | "sliceId" | "featureId";
  description: string;
  deleteOp: (missionStore: ReturnType<TaskStore["getMissionStore"]>, id: string, force: boolean) => void;
}): McpToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: {
      type: "object",
      properties: {
        [config.paramKey]: { type: "string", description: `${config.name.replace("fn_", "").replace("_delete", "")} ID to delete` },
        force: { type: "boolean", description: "Override linked-task guard" },
      },
      required: [config.paramKey],
    },
    async handler(store, args) {
      const id = String(args[config.paramKey] ?? "").trim();
      if (!id) return errorResult(`${config.paramKey} is required.`);
      const forced = args.force === true;

      const missionStore = store.getMissionStore();
      try {
        config.deleteOp(missionStore, id, forced);
      } catch (error) {
        auditDestructiveInvocation({ tool: config.name, resourceId: id, outcome: "error" });
        if (error instanceof Error) return errorResult(error.message);
        throw error;
      }

      auditDestructiveInvocation({
        tool: config.name,
        resourceId: id,
        outcome: forced ? "deleted forced=true" : "deleted",
      });
      return textResult(`Deleted ${id}`, { structuredContent: { [config.paramKey]: id, force: forced, outcome: "deleted" } });
    },
  };
}

const fnMilestoneDelete = bindMissionHierarchyDeleteTool({
  name: "fn_milestone_delete",
  paramKey: "milestoneId",
  description:
    "DESTRUCTIVE: delete a milestone and all descendant slices/features. Rejects deletion when a child feature is " +
    "linked to a live task unless force=true. Only registered when `fn mcp serve` is started with --allow-destructive.",
  deleteOp: (missionStore, id, force) => missionStore.deleteMilestone(id, force),
});

const fnSliceDelete = bindMissionHierarchyDeleteTool({
  name: "fn_slice_delete",
  paramKey: "sliceId",
  description:
    "DESTRUCTIVE: delete a slice and its features. Rejects deletion when a child feature is linked to a live task " +
    "unless force=true. Only registered when `fn mcp serve` is started with --allow-destructive.",
  deleteOp: (missionStore, id, force) => missionStore.deleteSlice(id, force),
});

const fnFeatureDelete = bindMissionHierarchyDeleteTool({
  name: "fn_feature_delete",
  paramKey: "featureId",
  description:
    "DESTRUCTIVE: delete a feature. Rejects deletion when linked to a live task unless force=true. Only registered " +
    "when `fn mcp serve` is started with --allow-destructive.",
  deleteOp: (missionStore, id, force) => missionStore.deleteFeature(id, force),
});

/*
FNXC:McpServer 2026-07-11-10:00:
FUSI-020 adds the write half of the project registry: `fn_project_create`,
`fn_project_update`, `fn_project_remove`. Every handler here constructs its
OWN `new CentralCore()` (never a ctx-provided store), always `close()`s it in
a `finally`, and dispatches to the SAME `CentralCore.registerProject` /
`ensureProjectForPath` / `updateProject` / `unregisterProject` primitives the
`fn project` CLI already uses (packages/cli/src/commands/project.ts) — no
duplicated register/reattach/patch logic is reimplemented inline.

Cross-project blast radius (why these sit in DESTRUCTIVE_TOOL_TIER even
though `fn_project_remove` alone is reversible): `CentralCore` is the GLOBAL
cross-project registry (`~/.fusion/fusion-central.db`), not the single
project `fn mcp serve` was launched for. An operator's MCP session started
for Project A can register, repath, rename, or unregister the registry
entry for Project B, C, ... ANY project on the machine — a materially
higher blast radius than a single-project board mutation. That is precisely
why these three tools require --allow-destructive (same gate, no second
confirmation hook, per the FUSI-002/FUSI-005 recorded decision) rather than
living in the base set alongside fn_project_list/fn_project_show.

`fn_project_create` covers TWO distinct outcomes from one entry point: (a)
if `path` already has a valid `.fusion/fusion.db`, it REGISTERS the existing
project (reads its identity file, calls `ensureProjectForPath` +
`updateProject(active)` + `writeProjectIdentity`, mirroring `fn project
add`'s register flow); (b) otherwise it SCAFFOLDS a brand-new project via
the shared, log-silent `scaffoldFusionProject` core (packages/cli/src/
commands/init.ts, extracted from `fn init` — see its own FNXC:McpServer
note). The scaffold path performs real filesystem writes (`.fusion/`,
`fusion.db`, optional `git init`, `.gitignore`) — it MUST emit ZERO stdout,
since stdout is the MCP protocol channel; scaffoldFusionProject is log-
silent by construction and any bundled-skill install noise is likewise
never forwarded to console.log from this handler.

`fn_project_remove` = `CentralCore.unregisterProject` — REGISTRY-ENTRY ONLY.
It NEVER deletes `.fusion/` or any on-disk file; the project directory and
its `fusion.db` are left completely untouched, and the project is re-
addable at any time via `fn_project_create` (register-existing path) or
`fn project add`. `unregisterProject` is idempotent, so removing an already-
absent id returns `outcome: "noop"` rather than erroring.

Every structured payload here is `redactSecretsDeep`-walked before being
returned (project rows can carry a cached `settings` snapshot with secret-
ref-bearing fields), and every path — success AND error — writes the
stderr-only `auditDestructiveInvocation` line.
*/

const PROJECT_ISOLATION_MODES = ["in-process", "child-process"] as const;

function resolveProjectPath(cwd: string, pathArg: unknown): string | undefined {
  if (typeof pathArg !== "string" || pathArg.trim() === "") return undefined;
  const raw = pathArg.trim();
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

const fnProjectCreate: McpToolDefinition = {
  name: "fn_project_create",
  description:
    "DESTRUCTIVE: register a project in Fusion's GLOBAL central registry — either by registering an existing " +
    "on-disk `.fusion/` project at `path`, or by scaffolding (via the same logic as `fn init`) and registering a " +
    "brand-new project folder when `path` has no valid `.fusion/fusion.db` yet. Mutates the cross-project registry, " +
    "not just the current project. Only registered when `fn mcp serve` is started with --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative path to register or scaffold+register." },
      name: { type: "string", description: "Project display name (default: git remote / directory name)." },
      isolation: { type: "string", enum: [...PROJECT_ISOLATION_MODES], description: "Execution isolation mode (default: in-process)." },
      git: { type: "boolean", description: "Initialize a git repository if one does not exist (scaffold-new path only)." },
    },
    required: ["path"],
  },
  async handler(_store, args, ctx) {
    const absPath = resolveProjectPath(ctx.cwd, args.path);
    if (!absPath) return errorResult("path is required.");
    if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
      return errorResult(`Path does not exist or is not a directory: ${absPath}`);
    }

    const isolationArg = typeof args.isolation === "string" ? args.isolation : undefined;
    if (isolationArg !== undefined && !PROJECT_ISOLATION_MODES.includes(isolationArg as (typeof PROJECT_ISOLATION_MODES)[number])) {
      return errorResult(`isolation must be one of: ${PROJECT_ISOLATION_MODES.join(", ")}.`);
    }
    const isolation = isolationArg as (typeof PROJECT_ISOLATION_MODES)[number] | undefined;
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
    const git = args.git === true;

    const dbPath = join(absPath, ".fusion", "fusion.db");
    const hasValidDb = existsSync(dbPath) && isValidSqliteDatabaseFile(dbPath);

    if (hasValidDb) {
      // Register an EXISTING on-disk .fusion/ project — mirrors `fn project add`'s register flow.
      const central = new CentralCore();
      await central.init();
      try {
        const alreadyRegistered = await central.getProjectByPath(absPath);
        if (alreadyRegistered) {
          auditDestructiveInvocation({ tool: "fn_project_create", resourceId: alreadyRegistered.id, outcome: "noop-already-registered" });
          return textResult(`Project already registered: ${alreadyRegistered.id} (${alreadyRegistered.name})`, {
            structuredContent: redactSecretsDeep({
              projectId: alreadyRegistered.id,
              name: alreadyRegistered.name,
              path: alreadyRegistered.path,
              status: alreadyRegistered.status,
              isolationMode: alreadyRegistered.isolationMode,
              outcome: "noop-already-registered",
            }),
          });
        }

        const identity = readProjectIdentity(join(absPath, ".fusion"));
        const ensured = await central.ensureProjectForPath({
          path: absPath,
          identity: identity ?? undefined,
          name,
          isolationMode: isolation,
        });
        const activated = await central.updateProject(ensured.project.id, { status: "active" });
        try {
          writeProjectIdentity(join(absPath, ".fusion"), { id: activated.id, createdAt: activated.createdAt });
        } catch {
          // Best-effort identity backfill only.
        }

        auditDestructiveInvocation({ tool: "fn_project_create", resourceId: activated.id, outcome: "registered" });
        return textResult(`Registered existing project ${activated.id} ("${activated.name}") at ${activated.path}.`, {
          structuredContent: redactSecretsDeep({
            projectId: activated.id,
            name: activated.name,
            path: activated.path,
            status: activated.status,
            isolationMode: activated.isolationMode,
            outcome: "registered",
          }),
        });
      } catch (error) {
        auditDestructiveInvocation({ tool: "fn_project_create", resourceId: absPath, outcome: "error" });
        if (error instanceof Error) return errorResult(error.message);
        throw error;
      } finally {
        await central.close();
      }
    }

    // No valid .fusion/fusion.db yet — scaffold a brand-new project via the shared, log-silent core.
    try {
      const result = await scaffoldFusionProject(absPath, { name, git, isolation });
      if (result.registrationError) {
        auditDestructiveInvocation({ tool: "fn_project_create", resourceId: absPath, outcome: "error" });
        return errorResult(`Scaffolded local files but could not register in central database: ${result.registrationError}`);
      }
      const project = result.project!;
      auditDestructiveInvocation({ tool: "fn_project_create", resourceId: project.id, outcome: result.alreadyRegistered ? "noop-already-registered" : "created" });
      return textResult(`Scaffolded and registered new project ${project.id} ("${project.name}") at ${project.path}.`, {
        structuredContent: redactSecretsDeep({
          projectId: project.id,
          name: project.name,
          path: project.path,
          status: project.status,
          isolationMode: project.isolationMode,
          outcome: result.alreadyRegistered ? "noop-already-registered" : "created",
        }),
      });
    } catch (error) {
      auditDestructiveInvocation({ tool: "fn_project_create", resourceId: absPath, outcome: "error" });
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    }
  },
};

const fnProjectUpdate: McpToolDefinition = {
  name: "fn_project_update",
  description:
    "DESTRUCTIVE: apply a shallow patch (name/path/status/isolationMode) to a project's central-registry entry. " +
    "Mutates the cross-project registry, not just the current project. Only registered when `fn mcp serve` is " +
    "started with --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Project id to update." },
      name: { type: "string", description: "New display name." },
      path: { type: "string", description: "New absolute project path." },
      status: { type: "string", description: "New project status." },
      isolationMode: { type: "string", enum: [...PROJECT_ISOLATION_MODES], description: "New execution isolation mode." },
    },
    required: ["id"],
  },
  async handler(_store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");

    const patch: Record<string, unknown> = {};
    if (typeof args.name === "string") patch.name = args.name;
    if (typeof args.path === "string") patch.path = args.path;
    if (typeof args.status === "string") patch.status = args.status;
    if (typeof args.isolationMode === "string") patch.isolationMode = args.isolationMode;

    if (Object.keys(patch).length === 0) {
      return errorResult("At least one of name, path, status, isolationMode must be provided.");
    }

    const central = new CentralCore();
    await central.init();
    try {
      const updated = await central.updateProject(id, patch as never);
      auditDestructiveInvocation({ tool: "fn_project_update", resourceId: id, outcome: "updated" });
      return textResult(`Updated project ${updated.id} ("${updated.name}").`, { structuredContent: redactSecretsDeep(updated) });
    } catch (error) {
      auditDestructiveInvocation({ tool: "fn_project_update", resourceId: id, outcome: "error" });
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    } finally {
      await central.close();
    }
  },
};

const fnProjectRemove: McpToolDefinition = {
  name: "fn_project_remove",
  description:
    "DESTRUCTIVE: unregister a project's CENTRAL-REGISTRY ENTRY only — this NEVER deletes `.fusion/` or any on-disk " +
    "project files, and the project remains fully re-addable via fn_project_create. Mutates the GLOBAL cross-project " +
    "registry. Only registered when `fn mcp serve` is started with --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Project id to unregister." } },
    required: ["id"],
  },
  async handler(_store, args) {
    const id = String(args.id ?? "").trim();
    if (!id) return errorResult("id is required.");

    const central = new CentralCore();
    await central.init();
    try {
      const existing = await central.getProject(id);
      if (!existing) {
        auditDestructiveInvocation({ tool: "fn_project_remove", resourceId: id, outcome: "noop" });
        return textResult(`No project registered with id ${id}; nothing to unregister.`, {
          structuredContent: { projectId: id, outcome: "noop" },
        });
      }

      await central.unregisterProject(id);
      auditDestructiveInvocation({ tool: "fn_project_remove", resourceId: id, outcome: "unregistered" });
      return textResult(
        `Unregistered project ${existing.id} ("${existing.name}") from the central registry. ` +
          `Data is preserved at ${existing.path} — re-add it with fn_project_create.`,
        { structuredContent: redactSecretsDeep({ projectId: id, name: existing.name, path: existing.path, outcome: "unregistered" }) },
      );
    } catch (error) {
      auditDestructiveInvocation({ tool: "fn_project_remove", resourceId: id, outcome: "error" });
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    } finally {
      await central.close();
    }
  },
};

/*
FNXC:McpServer 2026-07-11-09:30:
fn_settings_update is a DESTRUCTIVE-tier write gated behind the SAME
--allow-destructive flag as the rest of the tier (no second gate — same
local-stdio operator-privileged trust model as fn_task_delete/etc., per the
FUSI-002/FUSI-005 recorded decision). It performs a SHALLOW scope-selected
PATCH — `scope: "project"` calls `store.updateSettings(patch)` (the
project-config writer, which already filters out global-only keys and
treats a `null` value as an explicit key-delete); `scope: "global"` calls
`store.updateGlobalSettings(patch)` (merges into the global store and emits
`settings:updated`). There is no `scope: "effective"`
write target — an effective read is a merge of two independently-owned
writable scopes, so writing to it would be ambiguous.

FNXC:McpServer 2026-07-11-12:00:
Fixed (FUSI-048): the handler now filters the patch to IN-SCOPE keys
(via `isProjectSettingsKey`/`isGlobalSettingsKey`) BEFORE calling
`store.updateSettings`/`store.updateGlobalSettings` — it no longer passes
the raw full patch through. Previously the raw patch was written straight
to the store, which only strips `MOVED_SETTINGS_KEYS`; a wrong-scope key
that was NOT a moved key got silently persisted into the row (inert,
since it is stripped on read) even though the response reported it as
"dropped". Now `appliedKeys` is computed FIRST and is exactly the set of
keys handed to the store, so applied === written and `droppedKeys`
accurately reflects keys that were genuinely excluded from the write —
no wrong-scope junk ever lands in the settings row. If every key is
dropped (empty filtered patch), the store is NOT called at all — the
handler still returns an informational (non-error) result reporting all
keys as dropped and none applied, so the client gets an accurate report
without Fusion issuing a pointless empty write. The stderr audit line
carries the patched key NAMES only, never values — patch values may be
secret-bearing (e.g. an `mcpServers` secret ref) and must never be echoed
back to the client either in the audit line or in `structuredContent`.
*/
const fnSettingsUpdate: McpToolDefinition = {
  name: "fn_settings_update",
  description:
    "DESTRUCTIVE: apply a shallow PATCH to Fusion settings for a selected scope (project or global) — never a " +
    "full-object replace. A null value in the patch deletes that key. Only registered when `fn mcp serve` is " +
    "started with --allow-destructive.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["project", "global"], description: "Which settings scope to patch: 'project' or 'global'." },
      patch: {
        type: "object",
        additionalProperties: true,
        description: "Shallow key/value patch to apply. A null value for a key deletes that key.",
      },
    },
    required: ["scope", "patch"],
  },
  async handler(store, args) {
    const scope = args.scope;
    if (scope !== "project" && scope !== "global") {
      return errorResult("scope must be one of: project, global.");
    }
    const patch = args.patch;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return errorResult("patch is required and must be an object.");
    }
    const patchKeys = Object.keys(patch as Record<string, unknown>);
    if (patchKeys.length === 0) {
      return errorResult("patch must contain at least one key.");
    }

    const belongsToScope = scope === "project" ? isProjectSettingsKey : isGlobalSettingsKey;
    const appliedKeys = patchKeys.filter((key) => belongsToScope(key));
    const droppedKeys = patchKeys.filter((key) => !belongsToScope(key));

    // FNXC:McpServer 2026-07-11-12:00: filter to in-scope keys BEFORE writing,
    // so the store never sees (and never persists) a wrong-scope key.
    const rawPatch = patch as Record<string, unknown>;
    const filteredPatch: Record<string, unknown> = {};
    for (const key of appliedKeys) {
      filteredPatch[key] = rawPatch[key];
    }

    if (appliedKeys.length === 0) {
      // Every key in the patch belonged to the other scope — do not issue an
      // empty write to the store. Still return an accurate, non-error report.
      auditDestructiveInvocation({ tool: "fn_settings_update", resourceId: scope, outcome: "no-op" });
      console.error(`[fn mcp serve] DESTRUCTIVE fn_settings_update scope=${scope} keys=${patchKeys.join(",")} outcome=no-op`);

      return textResult(
        `No changes made to ${scope} settings — every key in the patch belongs to the other scope.\n` +
          `Dropped keys (not valid for ${scope} scope): ${droppedKeys.join(", ")}`,
        { structuredContent: redactSecretsDeep({ scope, appliedKeys, droppedKeys, outcome: "no-op" }) },
      );
    }

    try {
      if (scope === "project") {
        await store.updateSettings(filteredPatch);
      } else {
        await store.updateGlobalSettings(filteredPatch);
      }
    } catch (error) {
      auditDestructiveInvocation({ tool: "fn_settings_update", resourceId: scope, outcome: "error" });
      if (error instanceof Error) return errorResult(error.message);
      throw error;
    }

    auditDestructiveInvocation({ tool: "fn_settings_update", resourceId: scope, outcome: "updated" });
    console.error(`[fn mcp serve] DESTRUCTIVE fn_settings_update scope=${scope} keys=${patchKeys.join(",")}`);

    return textResult(
      `Updated ${scope} settings.\nApplied keys: ${appliedKeys.join(", ") || "(none)"}` +
        (droppedKeys.length ? `\nDropped keys (not valid for ${scope} scope): ${droppedKeys.join(", ")}` : ""),
      { structuredContent: redactSecretsDeep({ scope, appliedKeys, droppedKeys, outcome: "updated" }) },
    );
  },
};

/**
 * The destructive tier — EXACTLY eleven tools, appended to the base registry
 * only when `McpToolRuntimeContext.allowDestructive === true`. See the
 * module-level FNXC:McpServer 2026-07-10-22:10 and 2026-07-10-23:45 comments,
 * plus the FNXC:McpServer 2026-07-11-10:00 comment above the project tools,
 * for the gate rationale.
 */
export const DESTRUCTIVE_TOOL_TIER: McpToolDefinition[] = [
  fnTaskDelete,
  fnAgentDelete,
  fnWorkflowDeleteAudited,
  fnMissionDelete,
  fnMilestoneDelete,
  fnSliceDelete,
  fnFeatureDelete,
  fnSettingsUpdate,
  fnProjectCreate,
  fnProjectUpdate,
  fnProjectRemove,
];

/**
 * Single registry-construction entry point for `fn mcp serve`. Returns the
 * curated v1 {@link MCP_TOOL_REGISTRY} base set, plus
 * {@link DESTRUCTIVE_TOOL_TIER} ONLY when `ctx.allowDestructive === true`.
 * This is the ONLY place the two sets are combined — `buildMcpServer` (see
 * packages/cli/src/mcp-server/server.ts) must call this rather than reading
 * `MCP_TOOL_REGISTRY` directly, so no registration path can bypass the gate.
 */
export function buildMcpToolRegistry(ctx: Pick<McpToolRuntimeContext, "allowDestructive">): McpToolDefinition[] {
  return ctx.allowDestructive === true ? [...MCP_TOOL_REGISTRY, ...DESTRUCTIVE_TOOL_TIER] : MCP_TOOL_REGISTRY;
}
