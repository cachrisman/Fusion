---
"@runfusion/fusion": minor
---

summary: Add mission/milestone/slice/feature delete tools to `fn mcp serve --allow-destructive`.
category: feature
dev: Extends the FUSI-002 `McpToolRuntimeContext.allowDestructive`-gated destructive tier with four MissionStore-backed tools — `fn_mission_delete` (no `force`, unconditional cascade), `fn_milestone_delete`/`fn_slice_delete`/`fn_feature_delete` (optional `force` mirroring the pi-extension handlers, live-task-link guard honored). No second gate; stderr-only audit lines, enriched with a cascade summary for `fn_mission_delete` and a `forced=true` marker for the guarded tools.
