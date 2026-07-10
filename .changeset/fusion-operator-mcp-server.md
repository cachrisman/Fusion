---
"@runfusion/fusion": minor
---

summary: Add `fn mcp serve` to run Fusion as a local stdio MCP server for operators.
category: feature
dev: New `fn mcp serve [--project <name>]` subcommand starts a stdio `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js` + `server/stdio.js`, matching the `^1.0.0` client pin already used by `packages/engine/src/mcp-session-tools.ts`) exposing a curated v1 tool allow-list — tasks (`fn_task_create`, `fn_task_list`, `fn_task_show`, `fn_task_search`, `fn_delegate_task`), agents (`fn_list_agents`, `fn_agent_show`, `fn_agent_create`, `fn_agent_start`, `fn_agent_stop`), workflows (`fn_workflow_list`, `fn_workflow_get`, `fn_workflow_create`, `fn_workflow_update`, `fn_workflow_select`) — each bound to the same `@fusion/core`/`@fusion/engine` domain operation the pi-extension `fn_*` tools call. New `packages/cli/src/mcp-server/{tools,server}.ts`; no release/publish/version-tag or `*_delete` tools; secret-shaped fields are redacted from every tool result.
