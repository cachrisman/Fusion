---
"@runfusion/fusion": minor
---

summary: Expose live subscription-usage snapshot to the engine control plane for upcoming usage-limit controls.
category: feature
dev: Adds `resolveUsageControlSnapshot(providers)` in `packages/dashboard/src/usage.ts`, a `getUsageControlSnapshot?` DI callback on `SelfHealingOptions` (`packages/engine/src/self-healing.ts`), and dashboard-side wiring via `engine.getRuntime().setUsageControlSnapshotProvider(...)` (`packages/dashboard/src/server.ts`). Adds project settings `usagePauseThresholdPercent` / `usageThrottleThresholdPercent` (undefined = off) and a reserved `globalPauseReason: "usage-threshold"` value; scaffolding only, consumed by FUSI-058 (pause) and FUSI-059 (throttle).
