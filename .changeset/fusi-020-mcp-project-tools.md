---
"@runfusion/fusion": minor
---

summary: Add MCP project tools (list/show + create/update/remove) to `fn mcp serve`.
category: feature
dev: Adds fn_project_list/fn_project_show (base-tier reads over CentralCore.listProjects()/getProject()) and fn_project_create/fn_project_update/fn_project_remove (destructive-tier writes over CentralCore.registerProject/ensureProjectForPath/updateProject/unregisterProject) to MCP_TOOL_REGISTRY/DESTRUCTIVE_TOOL_TIER. These are the only tools in the registry that act on Fusion's GLOBAL cross-project central registry (~/.fusion/fusion-central.db) rather than the single project fn mcp serve was launched for — an MCP session started for one project can register/repath/unregister ANY registered project — which is why create/update/remove sit behind --allow-destructive even though fn_project_remove alone (a registry-entry-only unregister that never deletes on-disk .fusion/) is reversible. fn_project_create either registers an existing on-disk .fusion/ project or scaffolds+registers a brand-new one via a new log-silent scaffoldFusionProject() core extracted from fn init (runInit's own behavior/output is unchanged). Base tool count moves from twenty-five to twenty-seven (thirty-three to thirty-eight combined with --allow-destructive).
