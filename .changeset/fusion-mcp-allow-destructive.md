---
"@runfusion/fusion": minor
---

summary: Add `fn mcp serve --allow-destructive` to opt into MCP delete tools for tasks, agents, and workflows.
category: feature
dev: Off by default via `McpToolRuntimeContext.allowDestructive` / `buildMcpToolRegistry(ctx)` in packages/cli/src/mcp-server/tools.ts; adds `fn_task_delete`, `fn_agent_delete` (reuses `resolveAgentProvisioningPolicy`), and `fn_workflow_delete` (built-ins protected), each auditing to stderr.
