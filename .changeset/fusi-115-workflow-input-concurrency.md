---
"@runfusion/fusion": patch
---

summary: Protect workflow-input replies from stale or competing dashboard submissions.
category: fix
dev: Uses an atomic TaskStore marker comparison and shared reply-resume mutation.
