---
"@runfusion/fusion": minor
---

summary: Outbound MCP servers using OAuth now connect and refresh tokens non-interactively in the engine.
category: feature
dev: Adds `packages/engine/src/mcp-oauth-provider.ts` (Fusion `OAuthClientProvider` + shared `createHttpMcpTransport` helper) wired into `mcp-session-tools.ts`, `mcp-resolution.ts`'s runtime forwarding seam, and `mcp-validation-service.ts`'s HTTP probe. The engine performs proactive non-interactive refresh at session/probe creation when a stored token is expired but has a refresh token, persisting refreshed tokens only via secret refs. `redirectToAuthorization()` always throws (never opens a browser); a server with no valid/refreshable token is skipped fail-soft with an actionable "needs re-authorize" reason. Interactive authorize + DCR remain a later dashboard-side phase (FUSI-075).
