---
"@runfusion/fusion": patch
---

summary: MCP OAuth token refreshes now persist across restarts in all remaining AI lanes.
category: fix
dev: Threads FUSI-076's mcpSettingsStore/mcpServerScopeByName from merger-ai and the dashboard helper lanes (chat, planning, ai-refine, pr-conflict-resolver, pr-metadata-generator, insights, agent-generation, agent-onboarding, milestone/mission/subtask interviews) into createFnAgent/createResolvedAgentSession so the settings-backed McpOAuthTokenStore replaces the warn-only default. Completes the FUSI-076/077/080 rollout; engine lanes are FUSI-077.
