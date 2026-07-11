---
"@runfusion/fusion": patch
---

summary: Rate-limit/429 errors now pause and auto-resume instead of failing the task.
category: fix
dev: Usage-limit underlying errors short-circuit the pi.ts model-selection fallback seam (no longer wrapped as terminal ModelFallbackExhaustedError); triage/executor/merger classify usage-limit first and leave tasks resumable; self-healing auto-re-drives parked tasks after globalPause('rate-limit') clears.
