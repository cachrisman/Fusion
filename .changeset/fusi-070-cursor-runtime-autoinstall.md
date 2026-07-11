---
"@runfusion/fusion": patch
---

summary: Cursor CLI runtime plugin now auto-enables on host start — no manual dashboard step needed.
category: fix
dev: Mirrors the FN-7761 Grok CLI runtime bootstrap. `ensureBundledCursorRuntimePluginInstalled(pluginStore, pluginLoader)` is now called in `serve.ts`, `daemon.ts`, and `dashboard.ts` immediately after the existing Grok bootstrap call and before `pluginLoader.loadAllPlugins()`, fail-soft with operator-actionable logging (`console.warn` for serve/daemon, `logSink.log(..., "plugins")` for dashboard). Previously `fusion-plugin-cursor-runtime` had no eager host install, so `getRuntimeById('cursor')` returned undefined and `cursor-cli/<id>` executor selections (resolvable since FUSI-069) failed at step-execute with the missing-runtime error from `agent-session-helpers.ts`. Other bundled runtime plugins (hermes/openclaw/paperclip/droid/acp) remain lazy/manual-enable — only Grok and now Cursor are eagerly auto-installed at boot.
