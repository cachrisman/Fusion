---
"@runfusion/fusion": minor
---

summary: Add `fn_task_archive` to the `fn mcp serve` base tools so MCP clients can archive tasks.
category: feature
dev: `fn_task_archive` is added to the base `MCP_TOOL_REGISTRY` (packages/cli/src/mcp-server/tools.ts), not `DESTRUCTIVE_TOOL_TIER` — it is a reversible soft-move restorable via `fn_task_unarchive`, dispatching to the same `store.archiveTask(id, { removeLineageReferences })` operation the pi-extension `fn_task_archive` handler uses. `fn_goal_archive` was evaluated and explicitly deferred: the base registry has no `fn_goal_list`/`fn_goal_show` tools yet to discover goal IDs, so a standalone archive-only goal tool would be incoherent; a follow-up task to ship a coherent goal tool set (list/show + archive) should be filed.
