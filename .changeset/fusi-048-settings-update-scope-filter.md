---
"@runfusion/fusion": patch
---

summary: fn_settings_update no longer persists or misreports wrong-scope keys.
category: fix
dev: Handler filters the patch to in-scope keys (isProjectSettingsKey/isGlobalSettingsKey) before store.updateSettings/updateGlobalSettings so appliedKeys === written and droppedKeys reflects only excluded keys.
