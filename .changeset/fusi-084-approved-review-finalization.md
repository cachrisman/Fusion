---
"@runfusion/fusion": patch
---

summary: A passed-and-landed review no longer strands a task in "Task Failed"; no manual Bypass required.
category: fix
dev: Fixes the bug class where a pre-merge review recorded `status="failed"` despite an approve-family `verdict` (`APPROVE`/`APPROVE_WITH_NOTES`), permanently blocking finalization of an already-landed merge. (1) `workflow-graph-executor.ts`'s optional-group outcome→status mapping now reconciles an approve-family verdict to `status="passed"` even under a `failure` outcome — a genuine `REVISE`/verdict-absent failure is unchanged. (2) `getTaskMergeBlocker` (`packages/core/src/task-merge.ts`) is now verdict-aware defense-in-depth: it never blocks on an approve-verdict `failed` step, but still blocks `REVISE`/verdict-absent failures. (3) `auto-merge-finalization.ts`'s hard-blocker park now persists `mergeDetails` (including the landed `commitSha`) instead of dropping it, so a genuinely-blocked landed merge retains its provenance. Reproduced on FUSI-083 (commit efd7a5a8).
