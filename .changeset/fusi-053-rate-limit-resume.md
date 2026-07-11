---
"@runfusion/fusion": minor
---

summary: Reset-time-aware rate-limit auto-resume plus a live ETA countdown on the global-pause banner.
category: feature
dev: Adds `autoUnpauseResetBufferMs` setting; `SelfHealingManager.setRateLimitResetProvider()` DI seam (dashboard `usage.ts`'s `resolveRateLimitResetAt` injected via `server.ts`, reusing the existing 30s usage cache); falls back to the existing exponential backoff when reset time is unknown. New `GlobalPauseBanner` component renders only for `globalPauseReason === "rate-limit"`.
