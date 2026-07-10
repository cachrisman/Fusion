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
 * server); no `*_delete` tool exists in v1; no tool result may surface a raw
 * secret value (redacted via {@link redactSecretsDeep} before being
 * serialized into any tool response). If a genuinely destructive tool is
 * ever added, it MUST be gated behind an explicit `--allow-destructive` CLI
 * flag threaded through `McpToolRuntimeContext` — no destructive tool is
 * wired in v1.
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
fn_workflow_delete is intentionally NOT wired even though the factory
produces it: v1 excludes every *_delete tool. `stripApprovalFlags: true`
mirrors the pi extension's prompt-injectable-lane treatment since an
external MCP client is likewise untrusted input for IR authoring.
*/
function bindWorkflowTool(name: "fn_workflow_list" | "fn_workflow_get" | "fn_workflow_create" | "fn_workflow_update" | "fn_workflow_select", description: string, inputSchema: McpJsonSchema): McpToolDefinition {
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

/**
 * The curated v1 allow-list — the ONLY tools `fn mcp serve` exposes. Order
 * mirrors the task/agent/workflow grouping documented in docs/mcp.md.
 *
 * Deliberately absent: any `*_delete` tool, any release/publish/version-tag
 * tool, and any tool that could return raw secret material.
 */
export const MCP_TOOL_REGISTRY: McpToolDefinition[] = [
  fnTaskCreate,
  fnTaskList,
  fnTaskShow,
  fnTaskSearch,
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
