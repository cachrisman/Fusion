/*
 * FNXC:ReloadOnShip 2026-07-11-16:40:
 * Self-host/dogfood reload-on-ship hook. On a self-hosted/dogfood Fusion
 * install, an auto-merge advances the local `main` ref inside an isolated
 * integration worktree, but the operator's PRIMARY checkout files and the
 * RUNNING build (`dist/bin.js`, `@fusion/*` dist) are never updated —
 * "shipped" silently never becomes "live". Motivating incident: FUSI-045's
 * `fusion://skill` MCP resource shipped and was marked done, yet the running
 * MCP server never had it, and rebuilding the CLI failed because stale
 * `@fusion/engine` dist lacked a newly-added export (`workflowAddEdgeParams`)
 * that a shipped task had added to engine SOURCE (the CLI prebuild reads
 * dist, so dist must be rebuilt in dependency order first).
 *
 * `runReloadOnShip` is the opt-in (default-OFF, see `ReloadOnShipConfig` in
 * `@fusion/core`), fail-soft, three-phase orchestration invoked by the
 * merger AFTER a successful isolated (`reuse-task-worktree`) auto-merge has
 * advanced the local default branch:
 *   (a) fast-forward the operator's primary checkout — refused (no clobber)
 *       unless `classifyTargetCheckoutState` proves it clean;
 *   (b) rebuild ONLY the affected `@fusion/*` dist packages in dependency
 *       order (`@fusion/core` -> `@fusion/engine`+`@fusion/dashboard` ->
 *       `@runfusion/fusion`) via `runCommandAsync` (bounded timeout,
 *       `superviseSpawn`-backed — never `execSync`, never a raw
 *       detached spawn/nohup (process-supervisor-allowlist: explanatory only), never `pnpm release`/`publish`/tags);
 *   (c) signal running Fusion client(s) to reload via an optional
 *       DI-injected callback (the engine must never import
 *       `@fusion/dashboard` directly — FUSI-057 seam pattern).
 *
 * Every phase emits `audit.git({ type: "merge:reload-on-ship-*", ... })`
 * events (see the `GitMutationType` doc block in `run-audit.ts`) and never
 * throws past the caller — a rebuild/reload failure must never wedge the
 * merge or corrupt the operator's checkout. Mirrors the structured-result,
 * no-throw shape of `merger-ref-update-advance.ts`.
 */
import { runCommandAsync, type ReloadOnShipConfig, type ReloadOnShipSetting } from "@fusion/core";
import type { RunAuditor } from "./run-audit.js";
import { classifyTargetCheckoutState } from "./merger-integration-worktree.js";
import { syncWorktreeToHead } from "./worktree-ref-sync.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_REBUILD_TIMEOUT_MS = 300_000;
/** Truncate captured stderr to a bounded preview for audit metadata. */
const STDERR_PREVIEW_MAX_CHARS = 4_000;

/**
 * FNXC:ReloadOnShip 2026-07-11-16:40:
 * Normalize the `reloadOnShip` setting (boolean shorthand or a
 * `ReloadOnShipConfig` object) into a fully-populated config. `undefined`,
 * `false`, and `{ enabled: false }` all resolve to fully-disabled — every
 * per-phase flag defaults to the master `enabled` switch so a project can
 * opt in wholesale with a single `true` and still narrow later without a
 * breaking change.
 */
export function resolveReloadOnShipConfig(setting: ReloadOnShipSetting | undefined): Required<ReloadOnShipConfig> {
  if (setting === undefined || setting === false) {
    return { enabled: false, updatePrimaryCheckout: false, rebuildDist: false, signalReload: false, rebuildTimeoutMs: DEFAULT_REBUILD_TIMEOUT_MS };
  }
  if (setting === true) {
    return { enabled: true, updatePrimaryCheckout: true, rebuildDist: true, signalReload: true, rebuildTimeoutMs: DEFAULT_REBUILD_TIMEOUT_MS };
  }
  const enabled = setting.enabled === true;
  return {
    enabled,
    updatePrimaryCheckout: enabled && setting.updatePrimaryCheckout !== false,
    rebuildDist: enabled && setting.rebuildDist !== false,
    signalReload: enabled && setting.signalReload !== false,
    rebuildTimeoutMs: setting.rebuildTimeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS,
  };
}

/** `undefined`/absent/`false` all resolve to OFF — the single read-site
 *  helper so callers agree on the disabled default. */
export function isReloadOnShipEnabled(setting: ReloadOnShipSetting | undefined): boolean {
  return resolveReloadOnShipConfig(setting).enabled;
}

/**
 * Fixed workspace dependency order for the rebuild subset: `@fusion/core`
 * builds first (both `@fusion/engine` and `@fusion/dashboard` import its
 * dist), then engine + dashboard (order between the two doesn't matter —
 * neither imports the other, per AGENTS.md package-structure rules), then
 * the published CLI last (its prebuild reads engine/core dist for exports
 * like `workflowAddEdgeParams`).
 */
const PACKAGE_BUILD_ORDER: readonly string[] = [
  "@fusion/core",
  "@fusion/engine",
  "@fusion/dashboard",
  "@runfusion/fusion",
];

/** Maps a repo-relative changed path to the `@fusion/*` package name that
 *  owns it, or `null` if the path isn't inside a rebuildable package root. */
function packageForPath(relPath: string): string | null {
  if (relPath.startsWith("packages/core/")) return "@fusion/core";
  if (relPath.startsWith("packages/engine/")) return "@fusion/engine";
  if (relPath.startsWith("packages/dashboard/")) return "@fusion/dashboard";
  if (relPath.startsWith("packages/cli/")) return "@runfusion/fusion";
  return null;
}

/**
 * FNXC:ReloadOnShip 2026-07-11-16:40:
 * Compute the affected `@fusion/*` packages from the merged diff plus their
 * fixed downstream dependents, then return them ordered per
 * `PACKAGE_BUILD_ORDER`. `@fusion/core` changes pull in engine+dashboard+cli
 * (all depend on core); `@fusion/engine`/`@fusion/dashboard` changes pull in
 * only the CLI (which depends on both for its prebuild); `@runfusion/fusion`
 * changes affect only itself.
 */
export async function resolveAffectedPackages(
  projectRootDir: string,
  previousSha: string,
  newSha: string,
): Promise<string[]> {
  let changedPaths: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", previousSha, newSha],
      { cwd: projectRootDir, encoding: "utf-8" },
    );
    changedPaths = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // Unreadable diff: fail-soft to "rebuild everything" so we never skip a
    // needed rebuild silently; the caller still bounds each build with a timeout.
    return [...PACKAGE_BUILD_ORDER];
  }

  const directlyAffected = new Set<string>();
  for (const relPath of changedPaths) {
    const pkg = packageForPath(relPath);
    if (pkg) directlyAffected.add(pkg);
  }

  if (directlyAffected.size === 0) {
    return [];
  }

  const affected = new Set<string>(directlyAffected);
  if (directlyAffected.has("@fusion/core")) {
    affected.add("@fusion/engine");
    affected.add("@fusion/dashboard");
    affected.add("@runfusion/fusion");
  }
  if (directlyAffected.has("@fusion/engine") || directlyAffected.has("@fusion/dashboard")) {
    affected.add("@runfusion/fusion");
  }

  return PACKAGE_BUILD_ORDER.filter((pkg) => affected.has(pkg));
}

/** Optional DI hook the dashboard (or another host) can register so the
 *  engine can request a client reload signal without importing
 *  `@fusion/dashboard` directly — see the FUSI-057 engine<->dashboard seam
 *  pattern. Returns `true` when a signal was actually delivered. */
export type ReloadSignalCallback = () => Promise<boolean> | boolean;

let registeredReloadSignalCallback: ReloadSignalCallback | undefined;

/** Register the process-wide reload-signal DI callback. Call with
 *  `undefined` to clear. Exported for the dashboard host and for tests. */
export function setReloadOnShipSignalCallback(callback: ReloadSignalCallback | undefined): void {
  registeredReloadSignalCallback = callback;
}

export interface RunReloadOnShipArgs {
  taskId: string;
  /** The operator's primary (non-isolated) checkout to fast-forward. */
  projectRootDir: string;
  integrationBranch: string;
  previousSha: string;
  newSha: string;
  settings: { reloadOnShip?: ReloadOnShipSetting };
  audit: RunAuditor;
  /** Test/host injection seam; defaults to the process-wide registered callback. */
  signalReloadCallback?: ReloadSignalCallback;
  /** Test injection seam for phase (b); defaults to `runCommandAsync`. */
  runCommand?: typeof runCommandAsync;
}

export interface ReloadOnShipResult {
  enabled: boolean;
  checkoutOutcome: "skipped-disabled" | "refused-dirty" | "updated" | "failed" | "skipped-nothing-to-do";
  rebuiltPackages: string[];
  rebuildOutcome: "skipped-disabled" | "skipped-nothing-affected" | "succeeded" | "failed";
  failedPackage?: string;
  reloadSignaled: boolean;
}

/**
 * Run the three-phase reload-on-ship hook. Always resolves — never throws —
 * so the merger caller's own try/catch is a defense-in-depth backstop, not
 * the primary safety mechanism.
 */
export async function runReloadOnShip(args: RunReloadOnShipArgs): Promise<ReloadOnShipResult> {
  const { taskId, projectRootDir, integrationBranch, previousSha, newSha, settings, audit } = args;
  const runCommand = args.runCommand ?? runCommandAsync;
  const config = resolveReloadOnShipConfig(settings.reloadOnShip);

  const result: ReloadOnShipResult = {
    enabled: config.enabled,
    checkoutOutcome: "skipped-disabled",
    rebuiltPackages: [],
    rebuildOutcome: "skipped-disabled",
    reloadSignaled: false,
  };

  if (!config.enabled) {
    return result;
  }

  // Phase (a) — fast-forward the primary checkout, refusing fail-soft (no
  // clobber) unless it is proven clean.
  if (config.updatePrimaryCheckout) {
    result.checkoutOutcome = await runCheckoutUpdatePhase({
      taskId,
      projectRootDir,
      integrationBranch,
      previousSha,
      newSha,
      audit,
    });
  }

  // Phase (b) — rebuild affected packages in dependency order.
  if (config.rebuildDist) {
    const affected = await resolveAffectedPackages(projectRootDir, previousSha, newSha);
    if (affected.length === 0) {
      result.rebuildOutcome = "skipped-nothing-affected";
    } else {
      const rebuildResult = await runRebuildPhase({
        taskId,
        projectRootDir,
        packages: affected,
        timeoutMs: config.rebuildTimeoutMs,
        audit,
        runCommand,
      });
      result.rebuiltPackages = rebuildResult.rebuiltPackages;
      result.rebuildOutcome = rebuildResult.outcome;
      result.failedPackage = rebuildResult.failedPackage;
    }
  }

  // Phase (c) — signal running clients to reload. Fail-soft when no DI
  // callback is registered (e.g. engine running headless/without a
  // dashboard host attached).
  if (config.signalReload) {
    result.reloadSignaled = await runReloadSignalPhase({
      taskId,
      audit,
      callback: args.signalReloadCallback ?? registeredReloadSignalCallback,
    });
  }

  return result;
}

async function runCheckoutUpdatePhase(args: {
  taskId: string;
  projectRootDir: string;
  integrationBranch: string;
  previousSha: string;
  newSha: string;
  audit: RunAuditor;
}): Promise<ReloadOnShipResult["checkoutOutcome"]> {
  const { taskId, projectRootDir, integrationBranch, previousSha, newSha, audit } = args;

  let state: Awaited<ReturnType<typeof classifyTargetCheckoutState>>;
  try {
    state = await classifyTargetCheckoutState(projectRootDir);
  } catch (err: unknown) {
    await audit.git({
      type: "merge:reload-on-ship-checkout-refused",
      target: projectRootDir,
      metadata: {
        taskId,
        rootDir: projectRootDir,
        state: "classify-failed",
        error: err instanceof Error ? err.message : String(err),
      },
    }).catch(() => undefined);
    return "failed";
  }

  if (state.state !== "clean") {
    // FNXC:ReloadOnShip 2026-07-11-16:40: never `git reset --hard`/`checkout
    // -f` a dirty/unmerged primary checkout — refuse fail-soft instead.
    await audit.git({
      type: "merge:reload-on-ship-checkout-refused",
      target: projectRootDir,
      metadata: {
        taskId,
        rootDir: projectRootDir,
        state: state.state,
        ...(state.state === "unmerged-index"
          ? { unmergedPaths: state.unmergedPaths, porcelainSample: state.porcelainSample, mergeHeadPresent: state.mergeHeadPresent }
          : {}),
        ...(state.state === "unsafe-dirty" ? { reason: state.reason, porcelainSample: state.porcelainSample } : {}),
        ...(state.state === "dirty-autostashable" ? { dirtyPaths: state.dirtyPaths } : {}),
      },
    }).catch(() => undefined);
    return "refused-dirty";
  }

  // Clean: reuse the existing `syncWorktreeToHead` primitive (the same one
  // `runMergeAdvanceAutoSync` uses for other worktrees) in `ff-only` mode —
  // clean-tree fast-forward only, no stash/reapply needed since we already
  // proved the tree clean above.
  try {
    const syncResult = await syncWorktreeToHead({
      worktreePath: projectRootDir,
      integrationBranch,
      previousSha,
      newSha,
      mode: "ff-only",
      taskId,
    });
    // FNXC:ReloadOnShip 2026-07-11-18:10: `syncWorktreeToHead` reports
    // failures as a structured `{ kind: "failed", ... }` result rather than
    // throwing — treat that (and any other non-"clean-sync" kind that isn't
    // a genuine no-op) distinctly so a real reset/apply failure is never
    // silently relabeled as a benign "skipped-nothing-to-do" outcome under a
    // success-sounding "checkout-updated" audit event.
    const outcome: ReloadOnShipResult["checkoutOutcome"] =
      syncResult.kind === "clean-sync"
        ? "updated"
        : syncResult.kind === "failed"
          ? "failed"
          : "skipped-nothing-to-do";
    await audit.git({
      type: outcome === "failed"
        ? "merge:reload-on-ship-checkout-refused"
        : "merge:reload-on-ship-checkout-updated",
      target: projectRootDir,
      metadata: {
        taskId,
        rootDir: projectRootDir,
        previousSha,
        newSha,
        outcome: syncResult.kind,
        ...(syncResult.kind === "failed" ? { state: "sync-failed", stage: syncResult.stage, error: syncResult.error } : {}),
      },
    }).catch(() => undefined);
    return outcome;
  } catch (err: unknown) {
    await audit.git({
      type: "merge:reload-on-ship-checkout-refused",
      target: projectRootDir,
      metadata: {
        taskId,
        rootDir: projectRootDir,
        state: "sync-failed",
        error: err instanceof Error ? err.message : String(err),
      },
    }).catch(() => undefined);
    return "failed";
  }
}

async function runRebuildPhase(args: {
  taskId: string;
  projectRootDir: string;
  packages: string[];
  timeoutMs: number;
  audit: RunAuditor;
  runCommand: typeof runCommandAsync;
}): Promise<{ rebuiltPackages: string[]; outcome: ReloadOnShipResult["rebuildOutcome"]; failedPackage?: string }> {
  const { taskId, projectRootDir, packages, timeoutMs, audit, runCommand } = args;

  await audit.git({
    type: "merge:reload-on-ship-rebuild-started",
    target: projectRootDir,
    metadata: { taskId, packages },
  }).catch(() => undefined);

  const rebuiltPackages: string[] = [];
  for (const pkg of packages) {
    const startedAt = Date.now();
    // FNXC:ReloadOnShip 2026-07-11-16:40: AGENTS.md forbids `execSync` for
    // user/build commands and raw detached spawn/nohup (process-supervisor-allowlist: explanatory only) — `runCommandAsync`
    // is the `superviseSpawn`-backed async wrapper with a bounded timeout.
    const commandResult = await runCommand(`pnpm --filter ${pkg} build`, {
      cwd: projectRootDir,
      timeoutMs,
    });
    const durationMs = Date.now() - startedAt;
    const succeeded = !commandResult.spawnError && !commandResult.timedOut && commandResult.exitCode === 0;
    if (!succeeded) {
      await audit.git({
        type: "merge:reload-on-ship-rebuild-failed",
        target: pkg,
        metadata: {
          taskId,
          package: pkg,
          exitCode: commandResult.exitCode,
          timedOut: commandResult.timedOut,
          spawnError: commandResult.spawnError?.message,
          stderrPreview: commandResult.stderr.slice(0, STDERR_PREVIEW_MAX_CHARS),
          durationMs,
        },
      }).catch(() => undefined);
      // Stop-on-first-failure: a downstream package's prebuild would read
      // stale/half-built dist from this failure anyway.
      return { rebuiltPackages, outcome: "failed", failedPackage: pkg };
    }
    rebuiltPackages.push(pkg);
  }

  await audit.git({
    type: "merge:reload-on-ship-rebuild-succeeded",
    target: projectRootDir,
    metadata: { taskId, packages: rebuiltPackages },
  }).catch(() => undefined);

  return { rebuiltPackages, outcome: "succeeded" };
}

async function runReloadSignalPhase(args: {
  taskId: string;
  audit: RunAuditor;
  callback: ReloadSignalCallback | undefined;
}): Promise<boolean> {
  const { taskId, audit, callback } = args;

  if (!callback) {
    await audit.git({
      type: "merge:reload-on-ship-reload-signaled",
      target: taskId,
      metadata: { taskId, signaled: false, reason: "no-signal-path-configured" },
    }).catch(() => undefined);
    return false;
  }

  let signaled = false;
  let reason: string | undefined;
  try {
    signaled = await callback();
  } catch (err: unknown) {
    signaled = false;
    reason = err instanceof Error ? err.message : String(err);
  }

  await audit.git({
    type: "merge:reload-on-ship-reload-signaled",
    target: taskId,
    metadata: { taskId, signaled, ...(reason ? { reason } : {}) },
  }).catch(() => undefined);

  return signaled;
}
