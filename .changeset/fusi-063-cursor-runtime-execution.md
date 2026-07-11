---
"@runfusion/fusion": minor
---

summary: Cursor CLI runtime now executes tasks end-to-end via cursor-agent, not just probe/discovery.
category: feature
dev: Implements `CursorRuntimeAdapter.createSession()`/`promptWithFallback()`/`describeModel()` (plugins/fusion-plugin-cursor-runtime) against the `AgentRuntime` contract. `promptWithFallback` spawns `cursor-agent -p --output-format stream-json --force --trust --workspace <cwd> --model <id> [--resume <chatId>] [--mode plan|ask] "<prompt>"` via the new long-lived `execution-process-manager.ts` (distinct from `cli-spawn.ts`'s bounded probe runner), parses NDJSON events line-by-line via the new tolerant `stream-parser.ts`, bridges `thinking`/`assistant` events to `onThinking`/`onText`, maps `result.usage` into a `TaskTokenUsage`-shaped object, honors abort signals (SIGTERM then bounded SIGKILL), and rejects (does not swallow) `is_error:true` results so the caller's fallback/retry path can act. `createSession` gates on `probeCursorBinary`'s auth state and throws a `CursorRuntimeBlockedError` carrying a distinct `kind` (`unavailable`/`keychain-locked`/`missing-ide`/`unauthenticated`) rather than a generic error. `docs/cursor-cli-contract.md` gains the "Execution / streaming contract" section.
