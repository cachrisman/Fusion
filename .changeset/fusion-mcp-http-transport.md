---
"@runfusion/fusion": minor
---

summary: Add an authenticated HTTP transport to `fn mcp serve` for remote MCP clients.
category: feature
dev: Adds `--transport http --port <n> [--host <addr>] [--token <t>]` to `fn mcp serve`, wiring `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` over a Node `http.createServer` listener in `packages/cli/src/mcp-server/http-transport.ts`. Binds loopback (`127.0.0.1`) by default and requires a bearer token (`--token` or `FN_MCP_TOKEN`, constant-time compared) on every request; refuses to start on a non-loopback bind without a token. `--transport stdio` (default) is unchanged. Tool allow-list, secret redaction, and release/`*_delete` exclusions are reused unchanged from FUSI-001/FUSI-002 across both transports.
