---
"@runfusion/fusion": patch
---

summary: fn_models_list now surfaces plugin-runtime providers like cursor-cli
category: fix
dev: Reuses @fusion/engine's buildExecutionModelRegistry(cwd) seam (introduced by FUSI-050 for model-slot validation) instead of a built-in-only ModelRegistry.create() + registerBuiltInZaiProvider/registerBuiltInGrokProvider construction, so the MCP tool enumerates the same resolvable provider set createFnAgent resolves at runtime. An absent/unauthenticated plugin degrades to zero rows for that provider only; handler stays stdout-clean.
