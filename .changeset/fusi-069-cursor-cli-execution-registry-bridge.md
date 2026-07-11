---
"@runfusion/fusion": patch
---

summary: cursor-cli model selections now resolve and run via the Cursor CLI runtime instead of failing at session start.
category: fix
dev: Bridges enabled Fusion-plugin `cliProviders` (e.g. cursor-cli) into the pi execution `ModelRegistry` seeded by `registerExtensionProviders` (packages/engine/src/pi.ts), guarded per-provider so an unavailable/unauthenticated provider degrades to zero rows without disturbing zai/grok/pi-extension registration. Adds a `cursor-cli` -> `cursor` runtime routing derivation in `agent-session-helpers.ts` (mirrors the existing grok-cli seam) so cursor-cli selections dispatch to the FUSI-063 `CursorRuntimeAdapter` plugin runtime instead of pi's direct HTTP stream path, since `cursor-agent` has no HTTP endpoint. Threads `pluginRunner` through `AgentRuntimeOptions` -> `DefaultPiRuntime` -> `createFnAgent`.
