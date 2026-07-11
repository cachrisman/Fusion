---
"@runfusion/fusion": patch
---

summary: Harden `fn mcp serve` registry with a cross-cutting invariant test suite and doc count reconciliation.
category: internal
dev: Adds `packages/cli/src/mcp-server/__tests__/registry-invariants.test.ts`, which structurally enforces the registry's six safety invariants (single combine point, destructive gating, `DESTRUCTIVE:` marker, stderr-only ids/counts/outcomes-only audit, `redactSecretsDeep` on all output, no release/publish/version-tag/changeset tooling) over the whole resolved `MCP_TOOL_REGISTRY`/`DESTRUCTIVE_TOOL_TIER` set, plus a source-derived count-parity check against `docs/mcp.md`, `tools.test.ts`, `http-transport.test.ts`, and the FUSI-013 boot-smoke. Reconciled `docs/mcp.md`'s stale "seven" destructive-tool-count reference to the real eleven (43 base / 11 destructive / 54 combined at HEAD after merging with FUSI-018's mission/goal mutation base tools). No new tool, no behavior change.
