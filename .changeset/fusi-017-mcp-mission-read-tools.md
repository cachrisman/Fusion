---
"@runfusion/fusion": minor
---

summary: Add MCP read tools for missions, milestones, slices, and features to `fn mcp serve`.
category: feature
dev: Adds fn_mission_list, fn_mission_show, fn_milestone_list/show, fn_slice_list/show, and fn_feature_list/show to the base MCP_TOOL_REGISTRY (no --allow-destructive gate required). Each dispatches to the same MissionStore read operation the pi-extension fn_mission_list/fn_mission_show handlers already call. Base tool count moves from sixteen to twenty-four (thirty-one combined with --allow-destructive).
