---
title: "Unguarded session.subscribe() crashes Code Review before it can produce a verdict"
date: 2026-07-13
category: docs/solutions/logic-errors
module: "engine/pi.ts (createFnAgent) + engine/executor.ts (workflow-step execution)"
problem_type: logic_error
component: engine
symptoms:
  - "Code Review workflow step fails with 'Code Review failed before producing a verdict: session.subscribe is not a function'"
  - "Task exhausts its entire retry budget (e.g. 3/3, 0 remaining) despite a sound diff"
  - "Failure is a runtime TypeError unrelated to the PR/diff contents"
  - "Only reproduces on resolved runtimes whose session lacks a pi-style subscribe(listener) API (delegated CLI runtimes: cursor/droid/grok)"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/pi.ts (createFnAgent: wireFallbackHooks, final 'Wire up event listeners' block)"
  - "packages/engine/src/executor.ts (executeWorkflowStep session listener wiring)"
  - "packages/engine/src/reviewer.ts (createReviewerSession — already-correct reference guard)"
  - "packages/engine/src/workflow-graph-executor.ts (synthesizeNonVerdictFailureOutput)"
tags:
  - session-wiring
  - subscribe
  - no-verdict
  - code-review
  - delegated-cli-runtime
  - fusi-088
  - fusion-1946
---

# Unguarded `session.subscribe()` crashes Code Review before it can produce a verdict

## Symptom

The Code Review workflow step fails with:

```
Code Review failed before producing a verdict: session.subscribe is not a function
```

and the task burns its entire retry budget (observed 3/3, 0 remaining on
FUSI-082) even though the underlying PR/diff was fine. The synthesized
message comes from `workflow-graph-executor.ts#synthesizeNonVerdictFailureOutput`
(`${stepLabel} failed before producing a verdict: ${detail}`), where `detail`
is the raw `TypeError` text. This is the same class of defect as the
documented Runfusion/Fusion#1946 `(no feedback captured)` no-verdict dispatch
issue: an infra/wiring crash gets mistaken for (and consumes retry budget
like) a real reviewer verdict failure.

## Root cause

Not every resolved runtime session implements the pi `subscribe(listener)`
API. Delegated CLI runtimes (cursor/droid/grok) stream text via their own
`onText`/`onThinking` callbacks instead of exposing `subscribe`. Several
engine call sites wired session event listeners with an **unguarded**
`session.subscribe(...)` call:

- `packages/engine/src/pi.ts` — `createFnAgent`'s `wireFallbackHooks(targetSession)` fallback-model swap path, and the final "Wire up event listeners" block that runs on every `createFnAgent` call.
- `packages/engine/src/executor.ts` — the workflow-step execution listener wiring, which was also the **sole accumulator** of the step's `output` (parsed later for a REVISE/APPROVE verdict).

When a subscribe-less session reached these call sites, the call threw
`TypeError: session.subscribe is not a function`. Even if the throw were
merely caught (without a fallback), the workflow-step `output` would have
stayed empty — still producing the `(no feedback captured)` /
"failed before producing a verdict" no-verdict signature, since the accumulator
lived exclusively inside the crashing `subscribe` callback.

`packages/engine/src/reviewer.ts`'s `createReviewerSession` already guarded
its own `subscribe` call correctly (`streamReviewTextFromOnText` fallback,
~line 468), and `pi.ts#installMessageContentGuard` was already guarded too —
but the reviewer's own guard didn't help, because `createFnAgent` (called
underneath, via `promptWithFallback`) wired its own unguarded listener first.

## Fix

Guard every session-listener-wiring `.subscribe(...)` call site with
`typeof session.subscribe === "function"`, matching the existing
`reviewer.ts` / `installMessageContentGuard` pattern:

1. **`pi.ts#createFnAgent`** — both `wireFallbackHooks(targetSession)`'s
   `targetSession.subscribe(...)` and the final listener-wiring block's
   `promptableSession.subscribe(...)` are now wrapped in the guard. When
   `subscribe` is absent, streaming still flows through
   `options.onText`/`options.onThinking`, which are always forwarded to the
   runtime at session creation regardless of `subscribe` support.

2. **`executor.ts#executeWorkflowStep`** — the workflow-step
   `session.subscribe(...)` is now guarded the same way. Critically, an
   `onText`/`onThinking` fallback (`handleWorkflowStepText`/
   `handleWorkflowStepThinking`, gated by a `streamOutputFromOnText` flag) is
   now passed into `createResolvedAgentSession(...)`'s options so `output` is
   STILL accumulated when `subscribe` is unavailable — merely swallowing the
   throw without this fallback would have left `output` empty and produced
   the same no-verdict failure through a different path. The flag pattern
   avoids double-counting streamed text when `subscribe` IS available (the
   `subscribe` listener remains the sole accumulator in that case).

## Guard pattern to copy

```ts
if (typeof session.subscribe === "function") {
  session.subscribe((event) => {
    // ... wire streaming/tool events ...
  });
} else {
  // Fall back to onText/onThinking callbacks passed at session creation.
}
```

## Prevention / detection

- Any new engine call site that wires session streaming/event listeners MUST
  guard `.subscribe` the same way, or prove the session type it receives is
  provably subscribe-capable (e.g. a session created exclusively via the pi
  runtime or the mock provider, both of which implement `subscribe`).
- Enumerate all `.subscribe(` call sites in `packages/engine/src` with
  `grep -rn "\.subscribe(" packages/engine/src` when touching this seam —
  classify each as already-guarded, needs-guard, or not-a-session-listener
  (e.g. `cli-agent/task-session.ts`'s internal no-arg `subscribe()` method is
  NOT the pi listener API and is out of scope).
- Regression tests: `packages/engine/src/__tests__/pi-subscribe-guard.test.ts`
  and `packages/engine/src/__tests__/executor-workflow-step-subscribe.test.ts`
  construct a subscribe-less session fixture and assert (a) no throw,
  (b) text still streams via `onText`, (c) a real verdict/output is produced
  — never `(no feedback captured)` or "failed before producing a verdict".

## Cross-reference

FUSI-088 / Runfusion/Fusion#1946 (`(no feedback captured)` no-verdict dispatch
defect class).
