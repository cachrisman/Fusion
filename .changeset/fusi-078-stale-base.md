---
"@runfusion/fusion": patch
---

summary: Fix dispatched task worktree branches sometimes stacking on a stale base that predates a Done dependency's landed work.
category: fix
dev: Added a fail-soft stale-base guard in `worktree-acquisition.ts`'s `freshStartPoint` derivation (single choke point for all dispatch paths): verifies the resolved integration-branch candidate contains every Done dependency's `mergeDetails.commitSha` via `git merge-base --is-ancestor` (new `isAncestorCommit()` in `integration-branch.ts`), correcting the start point when stale/diverged. Emits `task:branch-base-stale-corrected` run-audit event. Never hard-fails dispatch.
