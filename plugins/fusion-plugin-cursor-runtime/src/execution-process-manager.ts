import { spawn, type ChildProcess } from "node:child_process";
import type { CursorExecutionOptions } from "./types.js";

/*
FNXC:CursorCli 2026-07-11-00:00:
FUSI-063: this module is the LONG-LIVED streaming counterpart to
`cli-spawn.ts`'s `runCursorCommand`. `runCursorCommand` fully buffers stdout
and resolves once on `close` — unsuitable for line-by-line NDJSON event
bridging or abort-signal kill semantics mid-stream (see PROMPT.md "Context to
Read First"). Do not reuse it for execution; this module owns its own spawn.
*/

/**
 * Build the `cursor-agent` argv for a headless streaming execution turn.
 *
 * Deliberately does NOT pass cursor's own `-w`/`--worktree` flag — Fusion
 * already owns the worktree via `--workspace <cwd>`, and `--worktree` would
 * have cursor-agent create ANOTHER isolated worktree under
 * `~/.cursor/worktrees/...`, diverging from the task's actual checkout.
 */
export function buildCursorExecutionArgs(options: CursorExecutionOptions): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--force",
    "--trust",
    "--workspace",
    options.cwd,
    "--model",
    options.model,
  ];

  if (options.resumeChatId) {
    args.push("--resume", options.resumeChatId);
  }

  if (options.mode === "plan" || options.mode === "ask") {
    args.push("--mode", options.mode);
  }

  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  if (options.approveMcps) {
    args.push("--approve-mcps");
  }

  args.push(options.prompt);

  return args;
}

const STDERR_DIAGNOSTIC_CAP = 4000;

/**
 * Spawn a long-lived `cursor-agent -p --output-format stream-json` execution
 * turn. Piped stdio, NOT fully buffered — the caller attaches `node:readline`
 * to `child.stdout` for line-by-line NDJSON parsing.
 *
 * Mirrors `cli-spawn.ts`'s Windows-shell-only rule: Windows Cursor installs
 * can expose `.cmd`/`.bat` shims on PATH that Node cannot direct-spawn.
 */
export function spawnCursorExecution(binary: string, args: string[], cwd: string): ChildProcess {
  return spawn(binary, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

/**
 * Capture stderr into a bounded buffer for diagnostics-only logging. Never
 * routed to the MCP/stdout protocol channel or unbounded — mirrors the
 * security rule already established for probe/discovery in
 * `docs/cursor-cli-contract.md` ("Fusion does not dump PATH, environment
 * variables, or unbounded stdout/stderr").
 */
export function captureBoundedStderr(child: ChildProcess): () => string {
  let buffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (buffer.length >= STDERR_DIAGNOSTIC_CAP) return;
    buffer += chunk.toString("utf-8");
    if (buffer.length > STDERR_DIAGNOSTIC_CAP) {
      buffer = `${buffer.slice(0, STDERR_DIAGNOSTIC_CAP)}…`;
    }
  });
  return () => buffer;
}

/**
 * Kill a running cursor-agent child process: SIGTERM first, then an escalated
 * SIGKILL if the process hasn't exited within `graceMs` — mirrors
 * `cli-spawn.ts`'s timeout-kill escalation pattern. Safe to call multiple
 * times or after the process has already exited.
 */
export function killCursorExecution(child: ChildProcess, graceMs = 3000): void {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }
  const timer = setTimeout(() => {
    if (child.killed || child.exitCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }, graceMs);
  child.once("exit", () => clearTimeout(timer));
}
