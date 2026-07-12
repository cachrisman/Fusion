import { exec, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings } from "@fusion/core";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type IntegrationBranchSettings =
  | ProjectSettings
  | (Pick<ProjectSettings, "integrationBranch"> & { baseBranch?: unknown })
  | undefined
  | null;

export const INTEGRATION_BRANCH_FALLBACK = "main";
const warnedFallbackRootDirs = new Set<string>();

function normalize(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

/*
FNXC:IntegrationBranch 2026-07-02-11:59:
Auto-detect deliberately reads origin/HEAD only. When operators use another remote such as gitlab, fallback diagnostics must name discovered remotes and guide them to add an origin alias or set integrationBranch manually instead of silently choosing an arbitrary remote.
*/
function warnFallback(rootDir: string, logger: Pick<Console, "warn">, remotes: string[] = []): void {
  if (warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  if (remotes.length > 0) {
    const remoteList = remotes.join(", ");
    const originState = remotes.includes("origin") ? "origin/HEAD is unset" : "origin is absent";
    logger.warn(`[integration-branch] falling back to 'main' — auto-detect checks origin/HEAD, but ${originState}; found remote ${remoteList}. Add an origin alias or set integrationBranch manually.`);
    return;
  }
  logger.warn("[integration-branch] falling back to 'main' — origin/HEAD unset and no project override");
}

function resolveFromSettings(settings: IntegrationBranchSettings): string {
  const fromIntegration = normalize(settings?.integrationBranch);
  if (fromIntegration.length > 0) {
    return fromIntegration;
  }

  return normalize((settings as { baseBranch?: unknown } | null | undefined)?.baseBranch);
}

async function resolveFromOriginHead(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function resolveFromOriginHeadSync(rootDir: string): string {
  try {
    const stdout = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function parseRemotes(stdout: string): string[] {
  return [...new Set(stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))];
}

async function listGitRemotes(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git remote", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return parseRemotes(stdout);
  } catch {
    return [];
  }
}

function listGitRemotesSync(rootDir: string): string[] {
  try {
    const stdout = execSync("git remote", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRemotes(stdout);
  } catch {
    return [];
  }
}

export async function resolveIntegrationBranch(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): Promise<string> {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = await resolveFromOriginHead(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  const remotes = await listGitRemotes(rootDir);
  warnFallback(rootDir, logger, remotes);
  return INTEGRATION_BRANCH_FALLBACK;
}

export function resolveIntegrationBranchSync(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): string {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = resolveFromOriginHeadSync(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  const remotes = listGitRemotesSync(rootDir);
  warnFallback(rootDir, logger, remotes);
  return INTEGRATION_BRANCH_FALLBACK;
}

/*
FNXC:BranchBase 2026-07-12-18:40:
FUSI-078: a dispatched task's worktree branch base must contain its Done dependencies'
landed commits — never a stale snapshot predating them. `resolveIntegrationBranch` only ever
resolves a branch NAME; whatever the local ref of that branch currently points at becomes the
new worktree's start point, and that local ref can be un-advanced/stale relative to a
dependency's actually-landed commit (observed: `fusion/fusi-059` cut from a commit 38+ commits
behind main, predating its Done dependency FUSI-057's landed work). This additive helper answers
"does `descendantRef` already contain `ancestorSha`?" via `git merge-base --is-ancestor`, so a
caller can detect and correct a stale candidate base before creating a branch on top of it.
Uses `execFile` (argv array, no shell) since `ancestorSha`/`descendantRef` may originate from
stored task metadata and must never be shell-interpolated.
*/
export async function isAncestorCommit(rootDir: string, ancestorSha: string, descendantRef: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantRef], {
      cwd: rootDir,
      timeout: 5_000,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

export function __resetIntegrationBranchCacheForTests(): void {
  warnedFallbackRootDirs.clear();
}
