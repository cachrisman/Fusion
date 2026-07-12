---
"@runfusion/fusion": minor
---

summary: The operator MCP server can switch its active project mid-session without relaunching.
category: feature
dev: Adds base-tier fn_project_use / fn_project_current to `fn mcp serve`; a per-server McpProjectSession retargets store-backed tool calls at the switched-to project (correct id prefix), switches are stderr-logged, switched stores closed on server close. Base tool count 66→68, combined 77→79.
