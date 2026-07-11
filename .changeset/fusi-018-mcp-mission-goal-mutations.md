---
"@runfusion/fusion": minor
---

summary: fn mcp serve can now create and update missions, milestones, slices, features, and goals.
category: feature
dev: Adds 16 base-tier MCP tools (fn_mission_create/update, fn_milestone_add/update, fn_slice_add/activate, fn_feature_add/update/link_task, fn_goal_list/show/create/archive, fn_mission_link_goal/unlink_goal/list_goals) to MCP_TOOL_REGISTRY in packages/cli/src/mcp-server/tools.ts, each dispatching to the shared MissionStore/GoalStore ops the pi-extension uses. Unblocks the FUSI-006-deferred fn_goal_archive.
