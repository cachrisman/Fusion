#!/usr/bin/env node
/**
 * FNXC:ProjectMemory 2026-07-11-09:15:
 * Symptom-verification fixture for FUSI-023. Invokes the AWAITED foreground
 * `isQmdAvailable()` probe (the exact call `runInit()` -> `warnIfQmdMissing()`
 * makes) against whatever `qmd` resolves on PATH. Prints a "started" marker
 * BEFORE the await and a "resolved" marker AFTER it settles. If the underlying
 * executor incorrectly unrefs the child (the pre-fix bug), Node can drain the
 * event loop and exit with code 13 ("unsettled top-level await") before the
 * "resolved" marker is ever printed — exactly reproducing the `fn init` symptom
 * in isolation, without needing the full CLI binary. Loaded via `tsx` so it can
 * import the real TypeScript source directly (no separate build step required).
 */
import { isQmdAvailable } from "../../memory-backend.ts";

console.log("qmd-available-keepalive-fixture:started");

const available = await isQmdAvailable();

console.log(`qmd-available-keepalive-fixture:resolved:${available}`);
