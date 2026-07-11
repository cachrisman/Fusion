---
"@runfusion/fusion": minor
---

summary: Add opt-in self-host reload-on-ship: rebuild + client-reload after Fusion self-merges.
category: feature
dev: New `reloadOnShip` project setting (default OFF, self-host/dogfood only). New module `packages/engine/src/merger-reload-on-ship.ts` (`runReloadOnShip`, `resolveReloadOnShipConfig`, `isReloadOnShipEnabled`, `resolveAffectedPackages`, `setReloadOnShipSignalCallback`). New run-audit event names: `merge:reload-on-ship-checkout-refused`, `merge:reload-on-ship-checkout-updated`, `merge:reload-on-ship-rebuild-started`, `merge:reload-on-ship-rebuild-succeeded`, `merge:reload-on-ship-rebuild-failed`, `merge:reload-on-ship-reload-signaled`.
