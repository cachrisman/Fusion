---
title: "cursor-cli plugin placeholder poisons the process-global pi-ai api dispatch table, breaking unrelated Ollama/custom-provider sessions"
date: 2026-07-13
category: docs/solutions/logic-errors
module: "engine/pi.ts (registerPluginCliProvider) + @earendil-works/pi-ai compat.js api-provider registry"
problem_type: logic_error
component: model-resolution
symptoms:
  - "A task whose resolved executor model is a non-cursor provider (e.g. Ollama, LM Studio, custom openai-compatible) fails at step-execute with: Provider \"cursor-cli\" is a plugin cliProvider with no HTTP endpoint; it must be dispatched to the \"cursor\" plugin runtime instead of pi's direct stream path."
  - "The failure happens immediately after the marker log 'Executor using model: <non-cursor provider>/<model>' — the described model and the actual stream path disagree"
  - "No cursor fallback is configured for the failing task; no concurrent cursor-cli task is required to reproduce it"
  - "The failure reproduces for ANY provider sharing the same pi-ai `api` type as the cursor-cli placeholder (by default 'openai-completions'), not just Ollama"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/pi.ts (registerPluginCliProvider, registerExtensionProviders, createFnAgent)"
  - "@earendil-works/pi-coding-agent's ModelRegistry.applyProviderConfig (calls the SDK's registerApiProvider whenever a provider config declares streamSimple)"
  - "@earendil-works/pi-ai/compat.js's apiProviderRegistry (process-global Map keyed only by `api` type string)"
tags:
  - model-resolution
  - plugin-provider
  - cursor-cli
  - session-isolation
  - pi-ai
applies_when:
  - "Authoring/reviewing a pi-ai `ModelRegistry.registerProvider()` call that declares a `streamSimple`/`stream` function for a provider that has no real HTTP endpoint (an inert placeholder, a CLI-only plugin runtime bridge, etc.)"
  - "Debugging a case where a task's described/resolved model disagrees with the error thrown at stream time"
---

## Problem

FUSI-069 registered an inert, always-throwing `streamSimple` placeholder for
`cursor-cli` (and any future CLI-only plugin `cliProviders` contribution) so
that `provider/modelId` selections would be *resolvable* in the execution
`ModelRegistry` without ever being *streamed* directly by pi (execution must
route through the plugin runtime instead). The placeholder was registered
with `api: "openai-completions"` — reusing the same `api` identifier as every
real openai-compatible provider (built-in OpenAI/OpenRouter and any custom
provider such as Ollama, LM Studio, vLLM).

`@earendil-works/pi-ai/compat.js` keeps its api-dispatch table
(`apiProviderRegistry`) as a **single process-global `Map`, keyed only by the
`api` type string** — not by provider name, and not scoped per
`ModelRegistry` instance or per task/session. `ModelRegistry.
applyProviderConfig()` calls the SDK's `registerApiProvider()` (a plain
`Map.set(api, ...)`, last-writer-wins) whenever a provider config declares a
`streamSimple` function. So registering the cursor-cli placeholder under the
shared `"openai-completions"` id silently **overwrote the dispatch slot every
other openai-compatible provider in the process depends on** — for the
remainder of the process (until something else re-registers that slot).

This requires **no concurrency** to reproduce: `registerExtensionProviders`
(which bridges plugin cliProviders) runs unconditionally inside
`createFnAgent` for every session when the plugin is installed/enabled,
BEFORE that same call's custom-provider registration loop. So a single task
whose own resolved model is Ollama poisons its own dispatch slot before it
ever streams its own model, as long as the cursor plugin happens to be
installed/enabled at all.

## Root cause

A shared, process-global dispatch key (`api` type string) was used by an
inert placeholder AND by the real generic handler for that api type. Any
provider config that declares `streamSimple`/`stream` for a shared `api` id
overwrites the dispatch for every OTHER provider using that same `api` id,
regardless of provider name, `ModelRegistry` instance, or task/session
boundary.

## Fix

Give every plugin cliProvider placeholder (or any inert/CLI-only provider
registration) a **dedicated, per-provider-unique `api` identifier** instead
of reusing a shared/real one — e.g. `` `fusion-plugin-cli:${providerId}` ``.
`@earendil-works/pi-ai`'s `Api` type is an open string type (`KnownApi |
(string & {})`), so any provider can safely mint its own dispatch-table slot.
This makes the placeholder's registration structurally incapable of
colliding with any real provider's dispatch slot, in either direction — no
session/registry pooling changes, no executor/self-healing changes needed.

```ts
// Before (poisons the shared "openai-completions" slot):
modelRegistry.registerProvider(providerId, {
  api: "openai-completions",
  streamSimple: () => { throw new Error(...); },
  // ...
});

// After (isolated slot, never collides with a real provider):
const placeholderApi = `fusion-plugin-cli:${providerId}`;
modelRegistry.registerProvider(providerId, {
  api: placeholderApi,
  streamSimple: () => { throw new Error(...); },
  // ...
});
```

## Detection / regression test pattern

Reproduce with real `ModelRegistry`/`AuthStorage` instances (no session
mocking needed) and `@earendil-works/pi-ai/compat`'s `completeSimple`/
`streamSimple` (mock `fetch`, never a real network call or CLI binary spawn):

1. Register the plugin cliProvider placeholder via the real registration
   function.
2. Register a second, real openai-compatible provider sharing the SAME `api`
   id the placeholder would otherwise use.
3. Stream/complete against the second provider's model and assert the
   placeholder's error never appears — the response's actual stream path
   must agree with its `describeModel`-style provider/id.
4. Add a concurrency variant (`Promise.allSettled` on both models at once)
   and a sequential variant (placeholder session ends right before the real
   provider's session starts) to prove the poisoning is not merely a same-tick
   race but a durable global-state clobber.

See `packages/engine/src/__tests__/fusi-090-cursor-cli-session-isolation.test.ts`
for the full pattern (FUSI-090).

## Generalization

Any inert/placeholder provider registration that must satisfy an SDK's
provider-config validation (e.g. "api is required when registering
streamSimple") should mint its OWN unique api identifier rather than reusing
a shared/real one, whenever the underlying SDK's dispatch table is
process-global and keyed by that identifier alone. Verify this by checking
whether the SDK's `registerProvider`/`registerApiProvider`-equivalent
function's underlying storage is scoped per-instance or per-process before
assuming provider-name isolation is enough.
