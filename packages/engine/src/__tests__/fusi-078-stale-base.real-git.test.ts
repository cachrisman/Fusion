/**
 * FUSI-078: worktree branches stacking on stale base.
 *
 * Reproduces the exact FUSI-059 symptom in a real (temp) git repo end-to-end through
 * `acquireTaskWorktree` (the single choke point all scheduler dispatch paths flow
 * through before `git worktree add` runs): a dependency task's squash lands onto the
 * shared integration branch elsewhere, this checkout's local `main` ref never observes
 * it (stays stale), and a dependent task whose declared dependency is Done is dispatched
 * while that stale ref is still what resolves as the candidate start point.
 *
 * Pre-fix: the created `fusion/<dependent>` branch would be cut from the stale `main`
 * tip, which does NOT contain the dependency's landed commit
 * (`git merge-base --is-ancestor <dep-landed-sha> <dependent-base>` fails) -- this is
 * the FUSI-059 bug condition.
 *
 * Post-fix: the created branch base DOES contain the dependency's landed commit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { acquireTaskWorktree } from "../worktree-acquisition.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(cwd, file), content, "utf-8");
  git(cwd, `git add ${JSON.stringify(file)}`);
  git(cwd, `git commit -m ${JSON.stringify(message)}`);
  return git(cwd, "git rev-parse HEAD");
}

describeIfGit("FUSI-078: dependent branch base must not predate a Done dependency's landed commit", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function initRepo(): Promise<string> {
    const repoDir = await mkdtemp(join(tmpdir(), "fusi-078-stale-base-"));
    dirs.push(repoDir);
    git(repoDir, "git init -b main");
    git(repoDir, 'git config user.email "test@example.com"');
    git(repoDir, 'git config user.name "Test User"');
    await commitFile(repoDir, "README.md", "base\n", "chore: init");
    return repoDir;
  }

  function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "pipe" });
    return result.status === 0;
  }

  const store = {
    updateTask: async () => undefined,
    logEntry: async () => undefined,
    getTask: async (id: string) => {
      if (id === "FUSI-057") {
        return {
          id: "FUSI-057",
          column: "done",
          mergeDetails: { commitSha: (store as any).__landedSha },
        } as any;
      }
      return null;
    },
  } as any;

  it("reproduces the FUSI-059 symptom and asserts it is gone after the fix", async () => {
    const repoDir = await initRepo();
    const staleMainHead = git(repoDir, "git rev-parse main");

    // Land FUSI-057's squash onto the shared integration branch (simulating the merger
    // advancing `refs/heads/main` in a different checkout/isolated root than the one
    // that will dispatch FUSI-059 below -- per FNXC:MergeIsolation, the merger never
    // force-updates every checkout that might exist).
    const landedSha = await commitFile(
      repoDir,
      "fusi-057-feature.ts",
      "export const fusi057 = true;\n",
      "feat(FUSI-057): land dependency work",
    );

    // Arrange this rootDir's own local `main` ref to still be stale -- it never observed
    // FUSI-057 landing. This exactly matches FUSI-059's `df8ad460a` symptom: 38+ commits
    // behind main, predating its Done dependency's landed commit.
    git(repoDir, `git update-ref refs/heads/main ${staleMainHead}`);
    expect(git(repoDir, "git rev-parse main")).toBe(staleMainHead);
    (store as any).__landedSha = landedSha;

    // Pre-fix bug condition: the stale candidate base does NOT contain the dependency's
    // landed commit.
    expect(isAncestor(repoDir, landedSha, staleMainHead)).toBe(false);

    const createWorktree = async (
      branchName: string,
      worktreePath: string,
      _taskId: string,
      startPoint?: string,
    ) => {
      git(repoDir, `git worktree add -b ${branchName} ${JSON.stringify(worktreePath)} ${startPoint ?? ""}`);
      return { path: worktreePath, branch: branchName };
    };

    const result = await acquireTaskWorktree({
      task: {
        id: "FUSI-059",
        title: "Dependent task",
        description: "depends on FUSI-057",
        worktree: null,
        branch: null,
        dependencies: ["FUSI-057"],
      } as any,
      rootDir: repoDir,
      store,
      settings: {},
      createWorktree,
    });
    dirs.push(result.worktreePath);

    const dependentBase = git(result.worktreePath, "git rev-parse HEAD");

    // Assertion it is gone: the dependency's landed commit is now an ancestor of the
    // dependent branch's base -- a real automated regression, not just a green build.
    expect(isAncestor(repoDir, landedSha, dependentBase)).toBe(true);
    expect(dependentBase).toBe(landedSha);
    expect(dependentBase).not.toBe(staleMainHead);
  });
});
