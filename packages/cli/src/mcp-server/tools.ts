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
 */
import {
  TaskStore,
  AgentStore,
  ApprovalRequestStore,
  AGENT_VALID_TRANSITIONS,
  resolveAgentProvisioningPolicy,
  resolveTaskGithubTracking,
  formatCurrentTaskLine,
  TASK_PRIORITIES,
  COLUMNS,
  COLUMN_LABELS,
  type Task,
  type ColumnId,
  type TaskPriority,
} from "@fusion/core";
import { workflowDeleteParams } from "@fusion/engine";
import {
  createWorkflowAuthoringTools,
  workflowListParams,
  workflowGetParams,
  workflowCreateParams,
  workflowUpdateParams,
  workflowSelectParams,
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

const fnTaskList: McpToolDefinition = {
  name: "fn_task_list",
  description: "List all tasks on the Fusion board, grouped by column.",
  inputSchema: {
    type: "object",
    properties: {
      column: { type: "string", enum: [...COLUMNS], description: "Filter to a specific column" },
      limit: { type: "number", description: "Max tasks to show per column (default: 10)" },
    },
  },
  async handler(store, args) {
    const tasks = await store.listTasks({ slim: true });
    if (tasks.length === 0) return textResult("No tasks yet.", { structuredContent: { count: 0 } });

    const perColumn = typeof args.limit === "number" ? args.limit : 10;
    const requestedColumn = typeof args.column === "string" ? (args.column as ColumnId) : undefined;
    const lines: string[] = [];
    for (const col of COLUMNS) {
      if (requestedColumn && requestedColumn !== col) continue;
      const colTasks = tasks.filter((t) => t.column === col);
      if (colTasks.length === 0) continue;
      lines.push(`${(COLUMN_LABELS as Record<string, string>)[col] ?? col} (${colTasks.length}):`);
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
function bindWorkflowTool(name: "fn_workflow_list" | "fn_workflow_get" | "fn_workflow_create" | "fn_workflow_update" | "fn_workflow_select" | "fn_workflow_delete", description: string, inputSchema: McpJsonSchema): McpToolDefinition {
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
export const MCP_TOOL_REGISTRY: McpToolDefinition[] = [
  fnTaskCreate,
  fnTaskList,
  fnTaskShow,
  fnTaskSearch,
  fnTaskArchive,
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

/**
 * The destructive tier — EXACTLY seven tools, appended to the base registry
 * only when `McpToolRuntimeContext.allowDestructive === true`. See the
 * module-level FNXC:McpServer 2026-07-10-22:10 and 2026-07-10-23:45 comments
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
