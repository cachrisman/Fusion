/**
 * FNXC:ProjectMemory 2026-07-11-09:15:
 * FUSI-023 symptom-based subprocess smoke test.
 *
 * Original symptom: in a non-TTY shell, `node packages/cli/bin.mjs init --name X`
 * with a working (or fake) `qmd` on PATH printed early progress lines, then died
 * with "Detected unsettled top-level await at bin.mjs:20" and exit code 13,
 * leaving `.fusion/` empty (no `fusion.db`). Root cause: `getDefaultExecFileAsync()`
 * in `packages/core/src/memory-backend.ts` synchronously unref'd the spawned qmd
 * child so the awaited `isQmdAvailable()` promise (via `runInit()` ->
 * `warnIfQmdMissing()`) never kept the event loop alive long enough to settle
 * before Node drained the loop and exited.
 *
 * This test reproduces the EXACT failure condition against the BUILT binary
 * (`packages/cli/bin.mjs` -> `dist/bin.js`, not the compiled bun executable used by
 * build-exe.test.ts): a fake `qmd` shim on PATH whose `--help` exits 0 forces the
 * previously-fatal qmd-available branch, spawned non-interactively (stdio piped,
 * never inherited from a TTY). It asserts the fix holds: exit code 0, a valid
 * `.fusion/fusion.db`, and no "unsettled top-level await" in the captured output.
 *
 * Gated behind FUSION_RUN_INIT_SMOKE=1 (mirrors the opt-in conventions of
 * build-exe.test.ts / scripts/boot-smoke.mjs) since it requires a real build of
 * `packages/cli/dist/bin.js` (`pnpm --filter @runfusion/fusion build`) and spawns a
 * real child process. Never spawns a server or touches port 4040.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidSqliteDatabaseFile } from "@fusion/core";

const cliRoot = join(import.meta.dirname!, "..", "..");
const binMjsPath = join(cliRoot, "bin.mjs");
const distEntryPath = join(cliRoot, "dist", "bin.js");

const shouldRun = process.env.FUSION_RUN_INIT_SMOKE === "1";

function writeFakeQmdShim(binDir: string): void {
  // A minimal fake `qmd` whose `--help` exits 0 (the branch that was previously
  // fatal). Anything else exits non-zero so `installQmd`/refresh calls fail
  // harmlessly and fall back to the local file backend.
  const shimPath = join(binDir, process.platform === "win32" ? "qmd.cmd" : "qmd");
  const script = process.platform === "win32"
    ? ["@echo off", 'if "%1"=="--help" (echo qmd fake help & exit /b 0)', "exit /b 1", ""].join("\r\n")
    : [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--help" ]; then',
        '  echo "qmd fake help"',
        "  exit 0",
        "fi",
        'echo "qmd fake: unsupported $*" >&2',
        "exit 1",
        "",
      ].join("\n");
  writeFileSync(shimPath, script, "utf8");
  if (process.platform !== "win32") {
    chmodSync(shimPath, 0o755);
  }
}

async function runInitNonInteractively(
  projectDir: string,
  pathWithFakeQmd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const child = spawn(
      process.execPath,
      [binMjsPath, "init", "--name", "InitSmokeRepro", "--path", projectDir],
      {
        env: {
          ...process.env,
          PATH: `${pathWithFakeQmd}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          VITEST: "false",
          NODE_ENV: "production",
        },
        // stdio explicitly NOT inherited from a TTY — pipes only, matching the
        // reported non-interactive repro.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ code, output });
    });
  });
}

describe.runIf(shouldRun)("fn init non-TTY subprocess smoke (FUSI-023)", () => {
  const tempDirs: string[] = [];

  beforeAll(() => {
    if (!existsSync(distEntryPath)) {
      throw new Error(
        `FUSION_RUN_INIT_SMOKE=1 requires a built CLI at ${distEntryPath}. Run \`pnpm --filter @runfusion/fusion build\` first.`,
      );
    }
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "exits 0 and persists a valid fusion.db when qmd IS available (forces the previously-fatal branch)",
    async () => {
      const fakeQmdDir = mkdtempSync(join(tmpdir(), "fusi-023-fakebin-"));
      const projectDir = mkdtempSync(join(tmpdir(), "fusi-023-proj-"));
      tempDirs.push(fakeQmdDir, projectDir);
      writeFakeQmdShim(fakeQmdDir);

      const { code, output } = await runInitNonInteractively(projectDir, fakeQmdDir);

      expect(output).not.toMatch(/unsettled top-level await/i);
      expect(code).toBe(0);

      const dbPath = join(projectDir, ".fusion", "fusion.db");
      expect(existsSync(dbPath)).toBe(true);
      expect(isValidSqliteDatabaseFile(dbPath)).toBe(true);
    },
    30_000,
  );
});
