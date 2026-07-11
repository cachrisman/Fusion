---
"@runfusion/fusion": patch
---

summary: Rate-limited tasks now show a calm "waiting for reset" state instead of a red FAILED with raw JSON.
category: fix
dev: New rateLimitedTaskState classifier + RateLimitedTaskNotice branch TaskCard/TaskDetailModal/ListView to a warning-tier affordance (--color-warning) with a reset ETA (shared resolveRateLimitResetAt/useUsageData) and collapsed raw-JSON details; genuine terminal failures keep the red error treatment. UI-only; pairs with FUSI-064 (usage-limit must never be terminal).
