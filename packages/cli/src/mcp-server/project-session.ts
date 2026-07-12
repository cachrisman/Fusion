/**
 * Session-scoped active-project selector for `fn mcp serve`.
 *
 * FNXC:McpProjectSession 2026-07-12-00:00:
 * `fn mcp serve` binds to exactly one project at launch (`--project <name>`
 * or CWD auto-detection), and every store-backed mutating tool
 * (`fn_task_create`, `fn_workflow_create`, ...) always acted on that single
 * launch-bound project's `TaskStore`. An agent driving the operator server
 * while it was bound to project "Fusion" could not create a task/workflow
 * in another registered project without relaunching the server against the
 * right project (hit in practice 2026-07-12; see FUSI-083). This module
 * lets an operator MCP session retarget subsequent store-backed tool calls
 * at any registered project WITHOUT relaunching the server — switching only
 * happens via an explicit `fn_project_use` tool call (see tools.ts), never
 * implicitly, so an agent can't silently write to the wrong project.
 *
 * Ownership split (deliberate, see FUSI-083 Do-NOT list):
 * - The INITIAL (launch-bound) project's `TaskStore` is owned by the
 *   caller (`runMcpServe` / a test) — this session NEVER closes it, even on
 *   `close()`. Its lifecycle is already governed by `closeMcpContext`.
 * - SWITCHED-TO stores are opened lazily (`new TaskStore(path); await
 *   init()`), cached per `projectId` for the life of this session, and are
 *   OWNED by this session — `close()` closes every one of them.
 * - This session deliberately does NOT reuse `project-context.ts`'s shared
 *   module-level `storeCache`: that cache is process-global and would
 *   accumulate across the long-lived serve process, cross-contaminating
 *   other in-process CLI callers. Each session owns its own map instead.
 * - Switching back to the initial project's id reuses the initial store
 *   (no reopen); switching to an already-cached project reuses the cached
 *   store (no reopen, no duplicate handle).
 */
import { TaskStore } from "@fusion/core";

/** The fully-resolved active project: id/name/path plus its live store. */
export interface McpActiveProject {
  projectId: string;
  projectName: string;
  projectPath: string;
  store: TaskStore;
}

/** Just the identity of a project — enough to report or to target a switch. */
export interface McpProjectTarget {
  projectId: string;
  projectName: string;
  projectPath: string;
}

function toDescriptor(project: McpActiveProject): McpProjectTarget {
  return { projectId: project.projectId, projectName: project.projectName, projectPath: project.projectPath };
}

/**
 * Holds the operator MCP session's currently-active project, plus a
 * per-session cache of stores opened for projects switched to via
 * `activate()`. See the module-level FNXC:McpProjectSession comment above
 * for the ownership split this class enforces.
 */
export class McpProjectSession {
  private readonly initial: McpActiveProject;
  private active: McpActiveProject;
  /** Switched-to stores only, keyed by projectId — NEVER contains the initial project's store. */
  private readonly switchedStores = new Map<string, TaskStore>();

  constructor(initial: McpActiveProject) {
    this.initial = initial;
    this.active = initial;
  }

  /** The active project's store/cwd/id/name for the next tool call. */
  current(): McpActiveProject {
    return this.active;
  }

  /** The active project's id/name/path only (for `fn_project_current`). */
  currentDescriptor(): McpProjectTarget {
    return toDescriptor(this.active);
  }

  /**
   * Switch the active project to `target`, opening (and caching) a new
   * `TaskStore` if this session has not switched to that project before.
   * Switching back to the initial project reuses the initial store rather
   * than reopening it.
   */
  async activate(target: McpProjectTarget): Promise<McpProjectTarget> {
    if (target.projectId === this.initial.projectId) {
      this.active = this.initial;
      return toDescriptor(this.active);
    }

    const cached = this.switchedStores.get(target.projectId);
    if (cached) {
      this.active = { projectId: target.projectId, projectName: target.projectName, projectPath: target.projectPath, store: cached };
      return toDescriptor(this.active);
    }

    const store = new TaskStore(target.projectPath);
    await store.init();
    this.switchedStores.set(target.projectId, store);
    this.active = { projectId: target.projectId, projectName: target.projectName, projectPath: target.projectPath, store };
    return toDescriptor(this.active);
  }

  /**
   * Close every switched-to store this session opened. Best-effort and
   * idempotent (mirrors `closeProjectStore`'s swallow-on-close discipline
   * in project-context.ts) — never throws, never closes the caller-owned
   * initial store.
   */
  async close(): Promise<void> {
    for (const store of this.switchedStores.values()) {
      try {
        await store.close();
      } catch {
        // Best-effort: an already-closed store must not throw here.
      }
    }
    this.switchedStores.clear();
  }
}
