import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { RunAuditor } from "../run-audit.js";
import type { RunCommandResult } from "@fusion/core";
import { runReloadOnShip, resolveReloadOnShipConfig, isReloadOnShipEnabled, resolveAffectedPackages } from "../merger-reload-on-ship.js";

// FNXC:ReloadOnShip 2026-07-11-17:00: signal-safe tmp dir sweep, mirroring
// merger-ref-update-advance.test.ts — never an unbounded find against the
// system temp root; only our own tracked "fusion-test-reload-on-ship-*" dirs.
const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const TMP_DIR_CLEANUP_HOOK_KEY = Symbol.for("fusion.engine.merger-reload-on-ship-test.tmp-cleanup-hooks-installed");
const trackedTmpDirs = new Set<string>();

function removeTmpDirSync(dir: string): void {
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort
  } finally {
    trackedTmpDirs.delete(dir);
  }
}

function cleanupTmpDirsSync(): void {
  for (const dir of Array.from(trackedTmpDirs)) removeTmpDirSync(dir);
}

const processWithCleanupFlag = process as typeof process & { [TMP_DIR_CLEANUP_HOOK_KEY]?: boolean };
if (!processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY]) {
  process.once("beforeExit", cleanupTmpDirsSync);
  process.once("exit", cleanupTmpDirsSync);
  processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY] = true;
}

afterAll(() => {
  cleanupTmpDirsSync();
});

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-test-reload-on-ship-"));
  trackedTmpDirs.add(dir);
  git(dir, "git init -b main");
  git(dir, "git config user.name tester");
  git(dir, "git config user.email tester@example.com");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git(dir, "git add tracked.txt");
  git(dir, "git commit -m init");
  return dir;
}

function fakeAuditor(events: Array<{ type: string; target: string; metadata?: Record<string, unknown> }>): RunAuditor {
  return {
    git: async (input) => {
      events.push({ type: input.type, target: input.target, metadata: input.metadata });
    },
    database: async () => undefined,
    filesystem: async () => undefined,
    sandbox: async () => undefined,
  };
}

function successResult(): RunCommandResult {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
}

function failureResult(exitCode: number, stderr = "build failed"): RunCommandResult {
  return { stdout: "", stderr, exitCode, signal: null, bufferExceeded: false, timedOut: false };
}

describe("resolveReloadOnShipConfig / isReloadOnShipEnabled", () => {
  it("resolves undefined/false to fully disabled", () => {
    expect(isReloadOnShipEnabled(undefined)).toBe(false);
    expect(isReloadOnShipEnabled(false)).toBe(false);
    expect(resolveReloadOnShipConfig(undefined).enabled).toBe(false);
    expect(resolveReloadOnShipConfig({ enabled: false }).enabled).toBe(false);
  });

  it("resolves true shorthand to all phases enabled", () => {
    const config = resolveReloadOnShipConfig(true);
    expect(config.enabled).toBe(true);
    expect(config.updatePrimaryCheckout).toBe(true);
    expect(config.rebuildDist).toBe(true);
    expect(config.signalReload).toBe(true);
  });

  it("allows narrowing individual phases when enabled", () => {
    const config = resolveReloadOnShipConfig({ enabled: true, rebuildDist: false });
    expect(config.enabled).toBe(true);
    expect(config.updatePrimaryCheckout).toBe(true);
    expect(config.rebuildDist).toBe(false);
    expect(config.signalReload).toBe(true);
  });
});

describe("runReloadOnShip — setting OFF", () => {
  it("performs zero rebuild, zero reload signal, and emits no reload-on-ship audit events", async () => {
    const dir = setupRepo();
    try {
      const events: Array<{ type: string; target: string; metadata?: Record<string, unknown> }> = [];
      let runCommandCalls = 0;
      let signalCalls = 0;

      const result = await runReloadOnShip({
        taskId: "FUSI-061-off",
        projectRootDir: dir,
        integrationBranch: "main",
        previousSha: git(dir, "git rev-parse HEAD"),
        newSha: git(dir, "git rev-parse HEAD"),
        settings: { reloadOnShip: undefined },
        audit: fakeAuditor(events),
        runCommand: async () => {
          runCommandCalls += 1;
          return successResult();
        },
        signalReloadCallback: async () => {
          signalCalls += 1;
          return true;
        },
      });

      expect(result.enabled).toBe(false);
      expect(result.rebuiltPackages).toEqual([]);
      expect(result.reloadSignaled).toBe(false);
      expect(runCommandCalls).toBe(0);
      expect(signalCalls).toBe(0);
      expect(events).toEqual([]);
    } finally {
      removeTmpDirSync(dir);
    }
  });
});

describe("resolveAffectedPackages — dependency-order rebuild", () => {
  it("orders affected packages core -> engine/dashboard -> cli", async () => {
    const dir = setupRepo();
    try {
      const previousSha = git(dir, "git rev-parse HEAD");
      mkdirSync(join(dir, "packages", "cli", "src"), { recursive: true });
      mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
      mkdirSync(join(dir, "packages", "engine", "src"), { recursive: true });
      writeFileSync(join(dir, "packages", "cli", "src", "index.ts"), "export {};\n");
      writeFileSync(join(dir, "packages", "core", "src", "index.ts"), "export {};\n");
      writeFileSync(join(dir, "packages", "engine", "src", "index.ts"), "export {};\n");
      git(dir, "git add packages");
      git(dir, "git commit -m 'touch core+engine+cli'");
      const newSha = git(dir, "git rev-parse HEAD");

      const affected = await resolveAffectedPackages(dir, previousSha, newSha);
      // core change pulls in engine + dashboard + cli as downstream dependents;
      // the direct cli change is also included; order must follow the fixed
      // topological build order regardless of diff iteration order.
      expect(affected).toEqual(["@fusion/core", "@fusion/engine", "@fusion/dashboard", "@runfusion/fusion"]);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("invokes rebuild commands in dependency order via runReloadOnShip", async () => {
    const dir = setupRepo();
    try {
      const previousSha = git(dir, "git rev-parse HEAD");
      mkdirSync(join(dir, "packages", "engine", "src"), { recursive: true });
      writeFileSync(join(dir, "packages", "engine", "src", "index.ts"), "export {};\n");
      git(dir, "git add packages");
      git(dir, "git commit -m 'touch engine'");
      const newSha = git(dir, "git rev-parse HEAD");

      const events: Array<{ type: string; target: string; metadata?: Record<string, unknown> }> = [];
      const commandsRun: string[] = [];
      let signaled = false;

      const result = await runReloadOnShip({
        taskId: "FUSI-061-order",
        projectRootDir: dir,
        integrationBranch: "main",
        previousSha,
        newSha,
        settings: { reloadOnShip: { enabled: true, updatePrimaryCheckout: false } },
        audit: fakeAuditor(events),
        runCommand: async (command) => {
          commandsRun.push(command);
          return successResult();
        },
        signalReloadCallback: async () => {
          signaled = true;
          return true;
        },
      });

      // engine change pulls in only the downstream CLI dependent (not core,
      // not dashboard) per resolveAffectedPackages' fixed dependency rules.
      expect(commandsRun).toEqual([
        "pnpm --filter @fusion/engine build",
        "pnpm --filter @runfusion/fusion build",
      ]);
      expect(result.rebuiltPackages).toEqual(["@fusion/engine", "@runfusion/fusion"]);
      expect(result.rebuildOutcome).toBe("succeeded");
      expect(result.reloadSignaled).toBe(true);
      expect(signaled).toBe(true);
      expect(events.some((e) => e.type === "merge:reload-on-ship-reload-signaled")).toBe(true);
    } finally {
      removeTmpDirSync(dir);
    }
  });
});

describe("runReloadOnShip — dirty primary checkout refusal", () => {
  it("refuses the working-file update without any destructive git op, no clobber", async () => {
    const dir = setupRepo();
    try {
      const previousSha = git(dir, "git rev-parse HEAD");
      // Real local edit — never committed. Phase (a) must refuse rather than
      // `git reset --hard`/`checkout -f` over this.
      appendFileSync(join(dir, "tracked.txt"), "uncommitted local edit\n");

      const events: Array<{ type: string; target: string; metadata?: Record<string, unknown> }> = [];
      let runCommandCalls = 0;

      const result = await runReloadOnShip({
        taskId: "FUSI-061-dirty",
        projectRootDir: dir,
        integrationBranch: "main",
        previousSha,
        newSha: previousSha,
        settings: { reloadOnShip: { enabled: true, rebuildDist: false, signalReload: false } },
        audit: fakeAuditor(events),
        runCommand: async () => {
          runCommandCalls += 1;
          return successResult();
        },
      });

      expect(result.checkoutOutcome).toBe("refused-dirty");
      expect(runCommandCalls).toBe(0);
      const refusedEvent = events.find((e) => e.type === "merge:reload-on-ship-checkout-refused");
      expect(refusedEvent).toBeDefined();
      expect(refusedEvent?.metadata?.state).toBe("dirty-autostashable");
      // The uncommitted edit must survive untouched — proof no destructive
      // git op ran against the dirty primary checkout.
      const status = git(dir, "git status --porcelain");
      expect(status).not.toBe("");
      const content = execSync("cat tracked.txt", { cwd: dir, encoding: "utf-8" });
      expect(content).toContain("uncommitted local edit");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});

describe("runReloadOnShip — rebuild failure fail-soft", () => {
  it("resolves without throwing, stops after the failing package, and reports failure", async () => {
    const dir = setupRepo();
    try {
      const previousSha = git(dir, "git rev-parse HEAD");
      mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
      writeFileSync(join(dir, "packages", "core", "src", "index.ts"), "export {};\n");
      git(dir, "git add packages");
      git(dir, "git commit -m 'touch core'");
      const newSha = git(dir, "git rev-parse HEAD");

      const events: Array<{ type: string; target: string; metadata?: Record<string, unknown> }> = [];
      const commandsRun: string[] = [];

      const result = await runReloadOnShip({
        taskId: "FUSI-061-fail",
        projectRootDir: dir,
        integrationBranch: "main",
        previousSha,
        newSha,
        settings: { reloadOnShip: { enabled: true, updatePrimaryCheckout: false, signalReload: false } },
        audit: fakeAuditor(events),
        runCommand: async (command) => {
          commandsRun.push(command);
          if (command.includes("@fusion/core")) return failureResult(1, "tsc error");
          return successResult();
        },
      });

      // core is direct + pulls in engine/dashboard/cli — but the failure on
      // the very first (core) build must stop the loop before any downstream
      // package is attempted.
      expect(commandsRun).toEqual(["pnpm --filter @fusion/core build"]);
      expect(result.rebuildOutcome).toBe("failed");
      expect(result.failedPackage).toBe("@fusion/core");
      expect(result.rebuiltPackages).toEqual([]);
      const failedEvent = events.find((e) => e.type === "merge:reload-on-ship-rebuild-failed");
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.metadata?.package).toBe("@fusion/core");
      expect(failedEvent?.metadata?.exitCode).toBe(1);
    } finally {
      removeTmpDirSync(dir);
    }
  });
});
