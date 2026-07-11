---
"@runfusion/fusion": patch
---

summary: Fix `fn init` failing with exit 13 and leaving an empty .fusion/ in non-interactive shells.
category: fix
dev: Awaited foreground qmd executor calls (isQmdAvailable/searchWithQmd/installQmd) now keep the event loop alive until the child settles via a keepProcessAlive opt-in on getDefaultExecFileAsync; init no longer lets the qmd probe gate board-DB creation. Background scheduleQmd* refresh stays unref'd.
