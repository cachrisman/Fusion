---
"@runfusion/fusion": patch
---

summary: MCP OAuth token refreshes now persist across restarts in all core AI lanes and the validation probe.
category: fix
dev: Threads FUSI-076's mcpSettingsStore/scopeByServerName (and scope for validateMcpServer) from createFnAgent (pi.ts), the ten named engine lanes, and the dashboard /mcp/validate route into connectMcpSessionTools/validateMcpServer so the settings-backed McpOAuthTokenStore replaces the warn-only default (FUSI-077). Remaining helper lanes tracked by FUSI-080.
