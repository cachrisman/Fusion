---
"@runfusion/fusion": patch
---

summary: Fix fn_task_file_scope_add rejecting valid appends over pre-existing File Scope prose.
category: fix
dev: TaskStore.updateTask's prompt-write branch now gates File Scope validation via a delta-aware `validateNewlyIntroducedFileScope(previousPrompt, nextPrompt)` helper — only tokens that are both invalid and newly introduced relative to the currently-persisted PROMPT.md block the write. createTask (no baseline) keeps full-strength validation.
