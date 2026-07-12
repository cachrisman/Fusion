---
category: logic-errors
module: engine-scheduler-worktree
tags: [worktree, branch-creation, dependencies, dispatch, integration-branch, git]
problem_type: stale-reference
applies_when: A freshly created git branch/worktree is derived from a resolved reference (branch name) instead of a verified commit, and that reference's local ref can be stale relative to work another dependency has already landed.
---

# Worktree branches stacking on a stale base predating a Done dependency (FUSI-078)

## Problem

A task's worktree branch (`fusion/<id>`) could be created on top of a **stale** base
commit that predated its declared dependency's landed commit — even when that
dependency was shown "Done" on the board and its landed commit **is** an ancestor of
the current default branch today.

Observed on FUSI-059 (depends on FUSI-057, "Done"): its branch `fusion/fusi-059` was
cut from `df8ad460a` — 38+ commits and ~642 files behind `main`, predating FUSI-057
(and FUSI-053/050/048) entirely. Symptom: grepping the worktree for FUSI-057's exported
symbols found nothing, even though `fn_task_show FUSI-057` reported Done. A full
`git merge main` in that worktree dragged in hundreds of unrelated files across
unrelated subsystems and had to be aborted.

## Root cause

`scheduler.resolveBaseBranch(task, allTasks)` only resolves a non-null start branch
when a dependency (explicit or implicit `blockedBy`) is **in-review AND has a live
worktree** — it returns that dependency's own branch. For every other case (dependency
Done, or no dependency at all) it returns `null`, and both dispatch call sites persist
`executionStartBranch: null ?? undefined` — i.e. the field is explicitly cleared.

`worktree-acquisition.ts`'s `freshStartPoint` derivation then falls back to
`resolveIntegrationBranch(rootDir, settings, ...)`, which resolves only a branch
**NAME** (e.g. `"main"`) — never a verified tip SHA. `git worktree add -b fusion/<id>
<path> main` then branches off whatever the **local** `refs/heads/main` ref happens to
point at in that particular checkout/rootDir.

Nothing in this path ever asked "does the resolved `main` local ref actually contain my
Done dependency's landed commit (`mergeDetails.commitSha`)?" That local ref can be
behind a dependency's actually-landed commit when:

- the merge advanced a *shared* integration ref in a different checkout than the one
  currently dispatching (isolated-root merge policy deliberately never force-updates
  every checkout that might exist — see `FNXC:MergeIsolation`);
- nothing re-synced this rootDir's local `main` between the dependency landing and this
  task's dispatch (no fetch/pull happened in between);
- history was rewritten/squashed and diverged from what this rootDir's `main` last
  observed (hundreds of commits each way, not just "behind" — see the "FUSI-05x
  stacked-branch chain pitfall" project memory note).

## Fix

Added an additive, best-effort **stale-base guard** in `worktree-acquisition.ts`'s
`freshStartPoint` derivation — the single choke point every dispatch path (the
scheduler's single-dispatch call site, the batched `dispatchPrepByTaskId` path, and the
workspace sub-repo strip, which all delegate to `acquireTaskWorktree`) converges through
before `git worktree add` runs.

The guard only activates when no explicit `task.executionStartBranch` was already
selected upstream (an in-review dependency's live branch remains trusted as-is — that
precedence is unchanged). For each Done dependency with a recorded
`mergeDetails.commitSha`, it verifies the resolved candidate start point already
contains that landed commit via `git merge-base --is-ancestor <dep-landed-sha>
<candidate>` (new `isAncestorCommit()` helper in `integration-branch.ts`, additive
alongside the existing name-only `resolveIntegrationBranch`/`resolveIntegrationBranchSync`
resolvers). If it does not:

- when the candidate is merely **behind** the landed commit (the FUSI-059 case), the
  start point is fast-forwarded to the landed commit;
- when the two have **diverged** (rewritten/squashed history), the guard best-effort
  falls back to the landed commit anyway, so the new branch is never built on a
  snapshot predating a Done dependency's work.

The correction is entirely fail-soft: any git-command failure, missing landed SHA, or
audit-emit failure simply leaves that dependency uncorrected rather than failing
dispatch — a stale base degrades gracefully, it never becomes a hard task failure
(mirrors the existing FN-2165 missing/invalid-`executionStartBranch` fallback in
`executor.ts`).

A new `task:branch-base-stale-corrected` run-audit event (`GitMutationType`) is emitted
with `{ taskId, from, to, dependencyIds, reason }` — ids/counts/shas only — for
observability, following the existing `task:reconcile-*` conventions.

## Diagnosing a recurrence

If a task's worktree is missing an expected dependency's exported symbols/types even
though the board shows that dependency as "Done":

```bash
# Find the dependency's landed commit
git log --all --oneline --grep="<DEP-TASK-ID>" | head -5

# Check whether the suspect branch's base actually contains it
git merge-base --is-ancestor <dep-landed-sha> <branch-base-or-tip> && echo "OK: contains dep" || echo "STALE: does not contain dep"

# If STALE and hundreds of commits diverge each way (not just "behind"), this is the
# rewritten-history variant -- do NOT `git merge main` blindly; isolate and re-apply
# just the missing dependency's hunks instead (see the FUSI-05x pitfall memory note).
```

## Related

- `packages/engine/src/scheduler.ts` — `resolveBaseBranch`
- `packages/engine/src/worktree-acquisition.ts` — `correctStaleBaseCandidate`
  (`FNXC:BranchBase 2026-07-12`)
- `packages/engine/src/integration-branch.ts` — `isAncestorCommit`
- `packages/engine/src/run-audit.ts` — `task:branch-base-stale-corrected`
- `packages/engine/src/__tests__/fusi-078-stale-base.real-git.test.ts` — real-git
  regression reproducing the FUSI-059 symptom
- `packages/engine/src/__tests__/worktree-acquisition.test.ts` — surface-matrix unit
  coverage (`describe("FUSI-078 stale-base guard")`)
