---
"@runfusion/fusion": minor
---

summary: Add optional OAuth config for outbound MCP HTTP servers (foundation only; no authorize UI yet).
category: feature
dev: Adds `McpOAuthAuth`/`isMcpOAuthAuth` to `packages/core/src/types.ts`, extends `McpSseTransport`/`McpStreamableHttpTransport` with an optional `auth` field, teaches `validateMcpServerDefinitionDetailed`, `materializeMcpServerSecrets`/`ResolvedMcp*Transport`, `sanitizeMcpServerDefinition`, and `importMcpServersJson`/`exportMcpServersJson` to round-trip it. All oauth credential fields (`clientSecret`/`accessToken`/`refreshToken`) are Fusion secret references only, never inline plaintext. `stdio` is unaffected. Engine `OAuthClientProvider` wiring (Phase 2) and dashboard authorize/DCR UI (Phase 3) are separate follow-up tasks under FUSI-072.
