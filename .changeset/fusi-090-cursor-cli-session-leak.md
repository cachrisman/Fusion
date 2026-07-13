---
"@runfusion/fusion": patch
---

summary: Fix a spurious "cursor-cli" plugin-runtime error on tasks using a local/custom provider like Ollama.
category: fix
dev: Isolate/execution-resolve sessions per task and key them to the resolved provider/model so the FUSI-069 cursor-cli placeholder streamSimple can never back a non-cursor session; adds isolation + concurrency regression tests. Root cause documented in the FUSI-090 root-cause task doc.
