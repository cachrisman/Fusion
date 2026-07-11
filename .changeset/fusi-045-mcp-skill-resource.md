---
"@runfusion/fusion": minor
---

summary: MCP clients can now read a fusion://skill resource describing the Fusion operator surface.
category: feature
dev: buildMcpServer registers a readable fusion://skill resource (capabilities.resources declared) whose read handler returns the pi-extension SKILL.md body plus a new MCP-connection section (transport model, curated tool surface, invocation conventions) as text/markdown. The curated tool list embedded in that section is auto-generated from buildMcpToolRegistry via an extended scripts/sync-fusion-skill-tools.mjs (new mcp-curated-tools marker block in packages/cli/skill/fusion/references/mcp-connection.md, plus a generated served-skill-content.generated.ts string-constant module so the tsup-bundled single dist/bin.js needs no runtime fs path resolution) — it cannot drift, proven by a parity/drift-guard test. Destructive-tier tools are statically annotated --allow-destructive-gated; served content is flag-invariant (identical whether allowDestructive is true or false). The server instructions string gets a one-line pointer to the resource. Fetchability is proven over both stdio (extended scripts/lib/mcp-smoke.mjs boot-smoke resources/list + resources/read against the real spawned binary) and HTTP (in-memory + streamable-HTTP transport tests in packages/cli/src/mcp-server/__tests__/skill-resource.test.ts).
