---
"@runfusion/fusion": minor
---

summary: Add MCP workflow settings, granular node/edge tools, task-edit, and workflow-aware task listing.
category: feature
dev: Registers base-tier `fn_workflow_settings` (dispatches to the shared `createWorkflowSettingsTool`, get returns stored+effective, set validates atomically with null=clear), `fn_workflow_add_node`/`fn_workflow_remove_node`/`fn_workflow_add_edge`/`fn_workflow_remove_edge` (whole-IR-safe via new `addNodeToIr`/`removeNodeFromIr`/`addEdgeToIr`/`removeEdgeFromIr` pure helpers in `@fusion/core`, round-tripped through `parseWorkflowIr`, also available on the pi-extension via the shared `createWorkflowAuthoringTools` factory), and `fn_task_update` (mirrors the pi-extension handler 1:1, dispatches to `store.updateTask`) on `fn mcp serve`. `fn_task_list`'s `column` filter and grouping are now workflow-aware, so custom workflow columns like `ideas` are filterable and visible instead of silently dropped. All six additions are base-tier (none entered `DESTRUCTIVE_TOOL_TIER`); tool-count references across docs/mcp.md, the skill docs, tools.test.ts, and boot-smoke are reconciled (43->49 base, 54->60 combined).
