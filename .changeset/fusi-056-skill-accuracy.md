---
"@runfusion/fusion": patch
---

summary: Fix served MCP skill doc accuracy nits (task-list column list, settings limitation)
category: fix
dev: `fn_task_list` description/schema now says `triage` (matching the real COLUMNS enum) instead of the nonexistent `planning` column; SKILL.md's `<known_limitations>` Settings bullet is now scoped to the pi-extension surface and notes the MCP `fn_settings_update` destructive-tier exception. Regenerated via `node scripts/sync-fusion-skill-tools.mjs`.
