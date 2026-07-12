---
"@runfusion/fusion": minor
---

summary: Add Settings → MCP "Connect / Authorize" to complete OAuth-only MCP server setup.
category: feature
dev: New engine helpers `startMcpOAuthAuthorize`/`completeMcpOAuthCallback` (packages/engine/src/mcp-oauth-authorize.ts) drive the SDK auth() flow (PKCE, RFC 8414 discovery, RFC 7591 DCR) via the existing FusionMcpOAuthProvider. New dashboard routes `POST /api/mcp/oauth/authorize` and `GET /api/mcp/oauth/callback` mint/consume a CSRF state and persist tokens/DCR client info as Fusion secret refs. McpServersCard.tsx gains an oauth-only Connect/Authorize action reflecting needs-authorize/connected/refresh-failed states.
