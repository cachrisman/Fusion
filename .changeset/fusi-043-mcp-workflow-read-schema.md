---
"@runfusion/fusion": patch
---

summary: MCP fn_workflow_get now returns the full workflow graph, and fn_workflow_create/update expose a typed authoring schema.
category: fix
dev: fn_workflow_get details now carry the full IR (nodes/edges/columns/artifacts/fields/settings + layout) so structuredContent enables clone; workflowCreate/UpdateParams replace Type.Unknown ir with a typed TypeBox schema, and the mcp-server JSON-Schema→zod adapter recurses into nested object/array props so the schema reaches the wire. Handlers still dispatch to the shared @fusion/engine authoring ops; redactSecretsDeep preserved.
