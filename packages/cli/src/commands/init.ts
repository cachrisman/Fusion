/**
 * Init command for fn CLI.
 *
 * Initializes a new fn project in the current directory by:
 * 1. Creating the .fusion/ directory with fusion.db
 * 2. Registering the project in the central database
 *
 * Idempotent: if already initialized, reports success without recreating.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import {
  CentralCore,
  GitRepositoryInitializationError,
  QMD_INSTALL_COMMAND,
  isQmdAvailable,
  isValidSqliteDatabaseFile,
  readProjectIdentity,
  writeProjectIdentity,
  type RegisteredProject,
  type IsolationMode,
} from "@fusion/core";
import { maybeInstallClaudeSkillForNewProject } from "./claude-skills-runner.js";
import { isGitRepo } from "./git.js";
import {
  installBundledFusionSkill,
  type SkillInstallResult,
} from "./skill-installation.js";

/** Options for the init command */
export interface InitOptions {
  /** Override the auto-detected project name */
  name?: string;
  /** Path to initialize (defaults to cwd) */
  path?: string;
  /** Initialize a git repository if one does not exist */
  git?: boolean;
}

/**
 * FNXC:McpServer 2026-07-11-10:00:
 * Options for {@link scaffoldFusionProject} — the log-silent scaffolding
 * core shared by `fn init` (CLI, keeps its own console logging) and
 * `fn_project_create`'s init-new MCP path (which must emit ZERO stdout,
 * since stdout is the JSON-RPC transport channel for `fn mcp serve`).
 */
export interface ScaffoldFusionProjectOptions {
  /** Override the auto-detected project name */
  name?: string;
  /** Initialize a git repository if one does not exist */
  git?: boolean;
  /** Execution isolation mode for the newly registered project (default: "in-process"). */
  isolation?: IsolationMode;
}

/**
 * Structured result of {@link scaffoldFusionProject}. Callers (runInit / the
 * MCP fn_project_create handler) render their OWN log lines from this result
 * — the function itself performs no console output.
 */
export interface ScaffoldFusionProjectResult {
  /** The registered central-registry project row, when registration succeeded. */
  project?: RegisteredProject;
  /** Resolved project name used for scaffolding/registration. */
  projectName: string;
  /** Whether this call created `.fusion/` (false if it already existed). */
  fusionDirCreated: boolean;
  /** Whether this call created `fusion.db` (false if it already existed). */
  dbCreated: boolean;
  /** `"initialized"` when `--git` triggered a fresh `git init` for this call. */
  gitInitializedByFlag: boolean;
  /** `"initialized"` when CentralCore's own ensureGitRepositoryForProjectPath
   * step (independent of the `--git` flag) set up the repository during
   * registration. */
  gitRepository?: "initialized";
  /** `.gitignore` entries added by this call (empty if none were missing). */
  gitignoreEntriesAdded: string[];
  /** Whether `qmd` is available on PATH for indexed memory search. */
  qmdAvailable: boolean;
  /** Bundled Fusion skill install outcomes (one per detected client). */
  bundledSkillResults: SkillInstallResult[];
  /** True when the path was already registered in the central database. */
  alreadyRegistered: boolean;
  /** Set when the local files were scaffolded but central registration failed
   * for a reason OTHER than {@link GitRepositoryInitializationError} (which
   * is thrown, not returned, matching runInit's original hard-failure path). */
  registrationError?: string;
  /** Non-fatal identity-file persistence failure message, if any. */
  identityPersistError?: string;
}

/**
 * FNXC:McpServer 2026-07-11-10:00:
 * Log-silent scaffolding core extracted from `runInit` (FUSI-020). Performs
 * the create-`.fusion/`/create-`fusion.db`/optional-git/`.gitignore`-update/
 * `ensureProjectForPath`+`updateProject(active)`+`writeProjectIdentity`
 * sequence with NO `console.log`/`console.warn` calls — every observable
 * outcome is returned in {@link ScaffoldFusionProjectResult} so callers
 * render their own messaging (`runInit` keeps its existing stdout lines;
 * the `fn_project_create` MCP handler renders a single tool-result summary
 * and writes ZERO stdout, since stdout is the JSON-RPC transport channel).
 * Callers are expected to have already confirmed there is NO existing valid
 * `.fusion/fusion.db` at `cwd` — this function always scaffolds fresh; it
 * does not implement the "already initialized" / "has .fusion/ but
 * unregistered" early-return branches that live in `runInit` itself.
 */
export async function scaffoldFusionProject(
  cwd: string,
  opts: ScaffoldFusionProjectOptions = {},
): Promise<ScaffoldFusionProjectResult> {
  const fusionDir = join(cwd, ".fusion");
  const dbPath = join(fusionDir, "fusion.db");
  const projectName = opts.name ?? await detectProjectName(cwd);

  let fusionDirCreated = false;
  if (!existsSync(fusionDir)) {
    mkdirSync(fusionDir, { recursive: true });
    fusionDirCreated = true;
  }

  let gitInitializedByFlag = false;
  if (opts.git && !(await isGitRepo(cwd))) {
    await initializeGitRepo(cwd);
    gitInitializedByFlag = true;
  }

  const gitignoreEntriesAdded = addLocalStorageToGitignoreSilent(cwd);

  /**
   * FNXC:ProjectMemory 2026-07-11-10:30:
   * Durable board-DB creation must happen on the critical path BEFORE the
   * informational qmd probe (FUSI-023 invariant, preserved through FUSI-020's
   * extraction into scaffoldFusionProject). The qmd probe (`isQmdAvailable`) is
   * defense-in-depth non-fatal: if it ever throws or hangs for any reason,
   * `fn init` / fn_project_create must still have already written `fusion.db`
   * rather than leaving `.fusion/` empty.
   */
  let dbCreated = false;
  if (!existsSync(dbPath)) {
    // A zero-byte bootstrap file is a valid SQLite starting point.
    writeFileSync(dbPath, "");
    dbCreated = true;
  }

  /**
   * FNXC:ProjectMemory 2026-07-11-10:30:
   * The qmd probe is purely informational and must NEVER gate or abort
   * scaffolding (FUSI-023). It runs AFTER durable `fusion.db` creation above,
   * and its rejection is swallowed here (reported as `qmdAvailable: false`) so
   * a future qmd CLI change that throws/hangs can never stop central
   * registration from proceeding on a valid, already-written board DB.
   */
  let qmdAvailable = false;
  try {
    qmdAvailable = await isQmdAvailable();
  } catch {
    qmdAvailable = false;
  }

  const bundledSkillInstall = installBundledFusionSkill();

  const central = new CentralCore();
  await central.init();

  try {
    const existing = await central.getProjectByPath(cwd);
    if (existing) {
      return {
        project: existing,
        projectName,
        fusionDirCreated,
        dbCreated,
        gitInitializedByFlag,
        gitignoreEntriesAdded,
        qmdAvailable,
        bundledSkillResults: bundledSkillInstall.results,
        alreadyRegistered: true,
      };
    }

    const identity = existsSync(dbPath) ? readProjectIdentity(fusionDir) : null;
    const ensured = await central.ensureProjectForPath({
      path: cwd,
      identity: identity ?? undefined,
      name: projectName,
      isolationMode: opts.isolation,
    });

    const project = ensured.project;
    await central.updateProject(project.id, { status: "active" });

    let identityPersistError: string | undefined;
    try {
      writeProjectIdentity(fusionDir, { id: project.id, createdAt: project.createdAt });
    } catch (identityError) {
      identityPersistError = identityError instanceof Error ? identityError.message : String(identityError);
    }

    return {
      project: { ...project, status: "active" },
      projectName,
      fusionDirCreated,
      dbCreated,
      gitInitializedByFlag,
      gitRepository: ensured.gitRepository === "initialized" ? "initialized" : undefined,
      gitignoreEntriesAdded,
      qmdAvailable,
      bundledSkillResults: bundledSkillInstall.results,
      identityPersistError,
      alreadyRegistered: false,
    };
  } catch (err) {
    if (err instanceof GitRepositoryInitializationError) {
      throw err;
    }
    return {
      projectName,
      fusionDirCreated,
      dbCreated,
      gitInitializedByFlag,
      gitignoreEntriesAdded,
      qmdAvailable,
      bundledSkillResults: bundledSkillInstall.results,
      alreadyRegistered: false,
      registrationError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await central.close();
  }
}

/**
 * Run the init command.
 *
 * @param options - Optional configuration for init
 * @returns Promise that resolves when initialization is complete
 */
export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = options.path ? resolve(options.path) : process.cwd();
  const fusionDir = join(cwd, ".fusion");
  const dbPath = join(fusionDir, "fusion.db");
  const hasDbPath = existsSync(dbPath);
  const hasValidDb = hasDbPath && isValidSqliteDatabaseFile(dbPath);

  // Check if already initialized
  if (existsSync(fusionDir) && hasDbPath && hasValidDb) {
    // Check if registered in central DB
    const central = new CentralCore();
    await central.init();

    const existing = await central.getProjectByPath(cwd);
    if (existing) {
      try {
        writeProjectIdentity(join(cwd, ".fusion"), {
          id: existing.id,
          createdAt: existing.createdAt,
        });
      } catch {
        // Best-effort backfill only.
      }
      console.log(`✓ fn project already initialized: "${existing.name}"`);
      console.log(`  Path: ${cwd}`);
      console.log(`\n  Project is registered in the central registry.`);
      console.log(`  To re-initialize with a different name, run:`);
      console.log(`    fn project remove ${existing.name}`);
      console.log(`    fn init --name <new-name>`);
      await central.close();
      return;
    }

    // Has .fusion/ but not registered - offer to register
    const projectName = options.name ?? await detectProjectName(cwd);
    console.log(`⚠ Project directory exists but not registered.`);
    console.log(`  Run: fn project add ${projectName} ${cwd}`);
    console.log(`  Or: rm -rf ${fusionDir} && fn init`);
    await central.close();
    return;
  }

  if (existsSync(fusionDir) && hasDbPath && !hasValidDb) {
    throw new Error(
      `Existing database at ${dbPath} is not a valid SQLite database. ` +
      "Restore it from .fusion/backups or move it aside before re-running fn init.",
    );
  }

  // Get or generate project name (also used as the fallback in log lines
  // below if scaffolding fails before its own name resolution runs).
  const projectName = options.name ?? await detectProjectName(cwd);

  console.log(`Initializing fn project: "${projectName}"`);
  console.log(`  Path: ${cwd}`);

  /*
  FNXC:McpServer 2026-07-11-10:00:
  FUSI-020 extracted the create-.fusion/create-db/git/.gitignore/register
  sequence into the log-silent scaffoldFusionProject() core (shared with the
  fn_project_create MCP tool's init-new path). runInit renders ALL of its
  original console.log lines from the returned ScaffoldFusionProjectResult
  so this function's observable CLI output and idempotency are unchanged.
  */
  const result = await scaffoldFusionProject(cwd, { name: options.name, git: options.git });

  if (result.fusionDirCreated) {
    console.log(`  ✓ Created .fusion/ directory`);
  }
  if (result.gitInitializedByFlag) {
    console.log(`  ✓ Initialized git repository`);
  }
  if (result.gitignoreEntriesAdded.length > 0) {
    console.log(`  ✓ Updated .gitignore (added: ${result.gitignoreEntriesAdded.join(", ")})`);
  }
  if (result.qmdAvailable) {
    console.log(`  ✓ qmd available for memory search`);
  } else {
    console.log(`  ⚠ qmd not found; memory search will use local file fallback`);
    console.log(`    Install qmd for indexed retrieval: ${QMD_INSTALL_COMMAND}`);
  }
  if (result.dbCreated) {
    console.log(`  ✓ Created fusion.db`);
  }
  logBundledSkillInstallResults(result.bundledSkillResults);

  if (result.registrationError) {
    // If central DB registration fails, still report success since local files are created
    console.log(`  ⚠ Could not register in central database: ${result.registrationError}`);
    console.log(`\n✓ Project initialized locally (central registration can be done later)`);
    console.log(`\n  To register later, run:`);
    console.log(`    fn project add ${result.projectName} ${cwd}`);
    return;
  }

  const project = result.project!;

  if (result.alreadyRegistered) {
    console.log(`  ✓ Already registered in central database`);
    maybeInstallClaudeSkillForNewProject(cwd);
    console.log(`\n✓ Project "${result.projectName}" is ready!`);
    console.log(`\n  Next steps:`);
    console.log(`    fn task list       # View tasks`);
    console.log(`    fn task create    # Create a task`);
    console.log(`    fn dashboard      # Open the web UI`);
    return;
  }

  if (result.identityPersistError) {
    console.warn(`  ⚠ Could not persist project identity: ${result.identityPersistError}`);
  }

  maybeInstallClaudeSkillForNewProject(cwd);

  if (result.gitRepository === "initialized") {
    console.log(`  ✓ Initialized git repository`);
  }
  console.log(`  ✓ Registered in central database`);
  console.log(`\n✓ Project "${project.name}" initialized successfully!`);
  console.log(`\n  Next steps:`);
  console.log(`    fn task list       # View tasks`);
  console.log(`    fn task create    # Create a task`);
  console.log(`    fn dashboard      # Open the web UI`);
}

/**
 * Detect a project name from git remote or directory name.
 */
async function detectProjectName(dir: string): Promise<string> {
  // Fast-path for non-git directories to avoid spawning git unnecessarily.
  // (This also prevents occasional command stalls in constrained CI envs.)
  if (!existsSync(join(dir, ".git"))) {
    return basename(dir) || "my-project";
  }

  // Try git remote first
  try {
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin", {
      cwd: dir,
      timeout: 10_000,
    });

    const trimmed = remoteUrl.trim();
    if (trimmed) {
      // Extract repo name from URL
      // Handles: https://github.com/user/repo.git, git@github.com:user/repo.git
      const match = trimmed.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) {
        return match[2];
      }
    }
  } catch {
    // Not a git repo or no origin remote
  }

  // Fallback to directory name
  return basename(dir) || "my-project";
}

/**
 * Add local Fusion/Pi storage directories to .gitignore if not already present.
 * Idempotent: only adds missing entries.
 */
/**
 * Add local Fusion/Pi storage directories to .gitignore if not already
 * present. Idempotent: only adds missing entries. Log-silent — returns the
 * entries actually added so callers (runInit / scaffoldFusionProject) render
 * their own messaging; failures are swallowed (best-effort, matching the
 * original behavior) and simply yield an empty result.
 */
function addLocalStorageToGitignoreSilent(cwd: string): string[] {
  const gitignorePath = join(cwd, ".gitignore");

  let content = "";
  if (existsSync(gitignorePath)) {
    try {
      content = readFileSync(gitignorePath, "utf-8");
    } catch {
      // Best-effort: if we can't read, treat as empty
    }
  }

  const lines = content.split(/\r?\n/);
  const existingEntries = new Set(lines.map((line) => line.trim()));
  const missingEntries = [".fusion", ".pi", "fusion.db", "fusion.db-wal", "fusion.db-shm"]
    .filter((entry) => !existingEntries.has(entry));

  if (missingEntries.length === 0) {
    return [];
  }

  const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  const newContent = `${content}${prefix}${missingEntries.join("\n")}\n`;
  try {
    writeFileSync(gitignorePath, newContent);
    return missingEntries;
  } catch {
    // Best-effort: don't fail init if we can't write to .gitignore
    return [];
  }
}

async function initializeGitRepo(cwd: string): Promise<void> {
  await execAsync("git init", { cwd, timeout: 10_000 });

  try {
    const { stdout } = await execAsync("git symbolic-ref --quiet --short HEAD", {
      cwd,
      timeout: 10_000,
    });
    if (stdout.trim() !== "main") {
      await execAsync("git checkout -b main", { cwd, timeout: 10_000 });
    }
  } catch {
    // Older git versions or detached/unborn states may fail symbolic-ref.
    // Best-effort: create/switch to main.
    try {
      await execAsync("git checkout -b main", { cwd, timeout: 10_000 });
    } catch {
      await execAsync("git checkout main", { cwd, timeout: 10_000 });
    }
  }

  await ensureGitConfig(cwd, "user.name", "Fusion");
  await ensureGitConfig(cwd, "user.email", "noreply@runfusion.ai");

  const gitkeepPath = join(cwd, ".gitkeep");
  if (!existsSync(gitkeepPath)) {
    writeFileSync(gitkeepPath, "\n");
  }

  await execAsync("git add .gitkeep", { cwd, timeout: 10_000 });
  await execAsync('git commit --allow-empty -m "chore: initial commit"', {
    cwd,
    timeout: 10_000,
  });
}

async function ensureGitConfig(cwd: string, key: string, value: string): Promise<void> {
  try {
    const { stdout } = await execAsync(`git config --get ${key}`, { cwd, timeout: 10_000 });
    if (stdout.trim().length > 0) {
      return;
    }
  } catch {
    // Missing config; set a local default.
  }

  await execAsync(`git config ${key} "${value}"`, { cwd, timeout: 10_000 });
}

function logBundledSkillInstallResults(results: SkillInstallResult[]): void {
  for (const result of results) {
    const clientLabel = result.client[0].toUpperCase() + result.client.slice(1);
    if (result.outcome === "installed") {
      console.log(`  ✓ Installed bundled Fusion skill for ${clientLabel}: ${result.targetDir}`);
      continue;
    }

    if (result.outcome === "skipped") {
      console.log(`  ✓ Existing ${clientLabel} Fusion skill preserved: ${result.targetDir}`);
      continue;
    }

    console.warn(
      `  ⚠ Could not install bundled Fusion skill for ${clientLabel}: ${result.reason ?? "unknown error"}`,
    );
  }
}
