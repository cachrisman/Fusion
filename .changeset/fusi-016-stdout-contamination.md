---
"@runfusion/fusion": patch
---

summary: Fix stray DB-diagnostic output corrupting the stdio MCP protocol stream.
category: fix
dev: Route [title-id-drift]/[done-paused-backfill]/[fusion:db] DB-open diagnostics in @fusion/core (db.ts, archive-db.ts) through createLogger (stderr) so `fn mcp serve` stdout stays valid JSON-RPC. Regression test asserts DB open writes nothing to stdout.
