---
"@runfusion/fusion": minor
---

summary: fn_task_update now supports per-task execution/planning/validator model overrides.
category: feature
dev: Adds model_provider/model_id, planning_model_provider/planning_model_id, validator_model_provider/validator_model_id args to the fn_task_update pi-extension MCP tool (packages/cli/src/extension.ts); paired fields must be set/cleared together (both non-empty strings applies the override, both null clears it, exactly one side is a rejected error). Dispatches through the existing store.updateTask(id, updates) call; no new store op.
