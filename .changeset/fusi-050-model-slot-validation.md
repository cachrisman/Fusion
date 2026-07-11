---
"@runfusion/fusion": minor
---

summary: Reject/warn on unresolvable model-slot saves; degrade unresolvable fallbacks at runtime instead of failing tasks.
category: fix
dev: New `@fusion/core` `validateModelSlotSelection` + `@fusion/engine` `buildExecutionModelRegistry` wired into `PUT /settings`, `PUT /settings/global`, and `PATCH /workflows/:id/setting-values`. `createFnAgent`'s fallback resolution now catches a registry-not-found fallback and degrades to the runtime's built-in default (`AgentResult.fallbackModelDegraded`), surfaced through the existing FN-7787 `session:runtime-resolved` audit channel.
