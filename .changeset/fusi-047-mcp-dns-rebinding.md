---
"@runfusion/fusion": patch
---

summary: Reject DNS-rebinding requests (foreign Host/Origin) on the loopback `fn mcp serve --transport http` listener.
category: security
dev: `packages/cli/src/mcp-server/http-transport.ts` now validates `Host` (and, when present, `Origin`) against the existing `LOOPBACK_HOSTS` allow-list before dispatching to `transport.handleRequest`, returning `403` on mismatch. The check runs before the bearer-token check and is gated to loopback binds only — explicit `--host` + token deployments are unaffected. See `packages/cli/src/mcp-server/__tests__/http-transport.test.ts`'s "DNS-rebinding protection (FUSI-047)" suite.
