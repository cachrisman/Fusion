---
"@runfusion/fusion": minor
---

summary: Reduce task concurrency as Claude usage nears the limit, instead of running full-speed until a hard pause.
category: feature
dev: Adds `computeEffectiveMaxConcurrent` (packages/engine/src/adaptive-concurrency.ts), wired into both `Scheduler.schedule()` and `runHoldReleaseSweepPass()` maxConcurrent reads via a new `SchedulerOptions.getUsageControlSnapshot` DI callback (fed by the FUSI-057 usage-control snapshot seam). New settings `usageThrottleThresholdPercent`/`usagePauseThresholdPercent` (undefined = feature off, byte-for-byte legacy behavior). A weekly-pace reading of "ahead" shaves one additional concurrency step. Never touches the hard-429 `UsageLimitPauser` path.
