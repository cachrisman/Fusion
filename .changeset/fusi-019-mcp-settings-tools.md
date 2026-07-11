---
"@runfusion/fusion": minor
---

summary: Add settings read/write tools to the `fn mcp serve` MCP server (write gated by --allow-destructive).
category: feature
dev: Adds fn_settings_get (base-tier, scope-selected read of project/global/effective settings via TaskStore.getSettings()/getSettingsByScope(), always redacted via redactSecretsDeep) and fn_settings_update (destructive-tier, gated behind the SAME --allow-destructive flag as the rest of the tier — no second gate) to MCP_TOOL_REGISTRY/DESTRUCTIVE_TOOL_TIER. fn_settings_update performs a shallow scope-selected PATCH via store.updateSettings(patch) (project) / store.updateGlobalSettings(patch) (global) — never a read-then-replace of the whole settings object — so a null patch value deletes that key per the store's existing semantics. Rather than rejecting a patch key that belongs to the other scope, the handler lets the store's own silent key-filter run and reports which keys were applied vs. dropped back to the caller. The stderr audit line carries only the patched key NAMES, never values, since patch values may be secret-bearing. Base tool count moves from twenty-four to twenty-five (thirty-one to thirty-three combined with --allow-destructive).
