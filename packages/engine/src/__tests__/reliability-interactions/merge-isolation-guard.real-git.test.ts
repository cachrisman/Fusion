/**
 * FNXC:MergeIsolation 2026-07-11-15:30:
 * Symptom-based regression coverage for FUSI-060. On 2026-07-11 the merger
 * left the operator's PRIMARY checkout with UU/AA unmerged-stage index
 * entries and no MERGE_HEAD after a merge run that indexed against (or
 * failed to isolate from) the primary checkout. These real-git tests
 * reproduce the failure conditions directly (not the single narrow repro)
 * and assert the invariant across every enumerated surface: ref-advance
 * project-root refusal, the pre-merge unmerged-index guard (refuse, never
 * autostash), and the no-orphaned-conflict-stage cleanup invariant.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, hasGit } from "./_helpers.js";
import { advanceIntegrationBranchRef } from "../../merger-ref-update-advance.js";
import {
  acquireReuseHandoff,
  classifyTargetCheckoutState,
  MergeHandoffRefusedError,
} from "../../merger-integration-worktree.js";
import { __test__ as mergerTestHooks } from "../../merger.js";

const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const trackedTmpDirs = new Set<string>();

function mintTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedTmpDirs.add(dir);
  return dir;
}

function removeTmpDirSync(dir: string): void {
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort
  } finally {
    trackedTmpDirs.delete(dir);
  }
}

afterAll(() => {
  for (const dir of Array.from(trackedTmpDirs)) removeTmpDirSync(dir);
});

describe.skipIf(!hasGit)("FUSI-060: merge isolation + dirty/unmerged-index guard (real git)", () => {
  it("advanceIntegrationBranchRef refuses to run update-ref when rootDir resolves to the project root", async () => {
    const projectRootDir = mintTmpDir("fusion-test-fusi060-selfdogfood-");
    try {
      git(projectRootDir, "git init -b main");
      git(projectRootDir, "git config user.name tester");
      git(projectRootDir, "git config user.email tester@example.com");
      writeFileSync(join(projectRootDir, "tracked.ts"), "export const a = 1;\n");
      git(projectRootDir, "git add tracked.ts");
      git(projectRootDir, "git commit -m init");
      const expectedCurrentSha = git(projectRootDir, "git rev-parse refs/heads/main");

      git(projectRootDir, "git checkout -b feature");
      writeFileSync(join(projectRootDir, "feature.ts"), "export const feature = true;\n");
      git(projectRootDir, "git add feature.ts");
      git(projectRootDir, "git commit -m feature");
      const newSha = git(projectRootDir, "git rev-parse HEAD");
      git(projectRootDir, "git checkout main");

      const events: any[] = [];
      // Self-dogfood / misconfigured-reuse simulation: rootDir === projectRootDir.
      const result = await advanceIntegrationBranchRef({
        rootDir: projectRootDir,
        projectRootDir,
        integrationBranch: "main",
        newSha,
        expectedCurrentSha,
        taskId: "FUSI-060-selfdogfood",
        audit: { git: async (event: any) => events.push(event) } as any,
        requireIsolatedRoot: true,
      });

      expect(result.advanced).toBe(false);
      if (result.advanced) throw new Error("expected refusal");
      expect(result.reason).toBe("rootdir-equals-project-root");
      // The ref must NOT have moved — the refusal fired before any git op.
      expect(git(projectRootDir, "git rev-parse refs/heads/main")).toBe(expectedCurrentSha);
    } finally {
      removeTmpDirSync(projectRootDir);
    }
  });

  it("classifyTargetCheckoutState detects unmerged-index entries with NO MERGE_HEAD (the reported symptom)", async () => {
    const rootDir = mintTmpDir("fusion-test-fusi060-unmerged-");
    try {
      git(rootDir, "git init -b main");
      git(rootDir, "git config user.name tester");
      git(rootDir, "git config user.email tester@example.com");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 1;\n");
      git(rootDir, "git add file.ts");
      git(rootDir, "git commit -m init");

      git(rootDir, "git checkout -b feature");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 2;\n");
      git(rootDir, "git commit -am feature-change");
      git(rootDir, "git checkout main");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 3;\n");
      git(rootDir, "git commit -am main-change");

      // Produce a real conflict, then simulate the reported incident: strip
      // MERGE_HEAD without resolving, leaving orphaned UU conflict-stage
      // entries with no active merge for `git merge --abort` to find.
      try {
        git(rootDir, "git merge feature");
      } catch {
        // expected — conflict
      }
      // Confirm MERGE_HEAD exists right after the conflicting merge.
      expect(() => git(rootDir, "git rev-parse -q --verify MERGE_HEAD")).not.toThrow();
      rmSync(join(rootDir, ".git", "MERGE_HEAD"), { force: true });

      const state = await classifyTargetCheckoutState(rootDir);
      expect(state.state).toBe("unmerged-index");
      if (state.state !== "unmerged-index") throw new Error("expected unmerged-index");
      expect(state.unmergedPaths).toContain("file.ts");
      expect(state.mergeHeadPresent).toBe(false);
    } finally {
      removeTmpDirSync(rootDir);
    }
  });

  it("acquireReuseHandoff REFUSES (never autostashes) an unmerged-index worktree", async () => {
    const projectRootDir = mintTmpDir("fusion-test-fusi060-handoff-project-");
    const worktreePath = join(projectRootDir, "..", "fusion-test-fusi060-handoff-worktree");
    try {
      git(projectRootDir, "git init -b main");
      git(projectRootDir, "git config user.name tester");
      git(projectRootDir, "git config user.email tester@example.com");
      writeFileSync(join(projectRootDir, "file.ts"), "export const a = 1;\n");
      git(projectRootDir, "git add file.ts");
      git(projectRootDir, "git commit -m init");
      git(projectRootDir, "git branch fusion/fusi-060-handoff main");
      git(projectRootDir, `git worktree add ${JSON.stringify(worktreePath)} fusion/fusi-060-handoff`);
      trackedTmpDirs.add(worktreePath);

      // Produce a real unmerged-index conflict INSIDE the isolated worktree.
      git(worktreePath, "git checkout -b feature-local");
      writeFileSync(join(worktreePath, "file.ts"), "export const a = 2;\n");
      git(worktreePath, "git commit -am feature-local-change");
      git(worktreePath, "git checkout fusion/fusi-060-handoff");
      writeFileSync(join(worktreePath, "file.ts"), "export const a = 3;\n");
      git(worktreePath, "git commit -am handoff-change");
      try {
        git(worktreePath, "git merge feature-local");
      } catch {
        // expected — conflict
      }
      // Strip MERGE_HEAD to reproduce the orphaned-conflict-stage symptom
      // (a worktree's .git is a FILE pointing at the real git-dir, so resolve
      // it via `git rev-parse --git-dir` rather than assuming a .git directory).
      const worktreeGitDir = git(worktreePath, "git rev-parse --git-dir");
      const absoluteGitDir = worktreeGitDir.startsWith("/") ? worktreeGitDir : join(worktreePath, worktreeGitDir);
      rmSync(join(absoluteGitDir, "MERGE_HEAD"), { force: true });

      const preState = await classifyTargetCheckoutState(worktreePath);
      expect(preState.state).toBe("unmerged-index");

      const events: any[] = [];
      await expect(
        acquireReuseHandoff({
          task: {
            id: "FUSI-060-HANDOFF",
            branch: "fusion/fusi-060-handoff",
            worktree: worktreePath,
          } as any,
          store: {
            listTasks: async () => [],
          } as any,
          projectRoot: projectRootDir,
          settings: {} as any,
          worktreePath,
          auditEmit: (event) => {
            events.push(event);
          },
        }),
      ).rejects.toThrow(MergeHandoffRefusedError);

      const refusalEvent = events.find((e) => e.type === "merge:integration-root-unmerged-index-refused");
      expect(refusalEvent).toBeTruthy();
      // Must NEVER have attempted `git stash` on the unmerged index — assert
      // the conflict-stage entries are still exactly as they were (no
      // autostash mutation ran `git add -A` / `git reset --hard` over them).
      const postState = await classifyTargetCheckoutState(worktreePath);
      expect(postState.state).toBe("unmerged-index");
    } finally {
      removeTmpDirSync(projectRootDir);
    }
  });

  it("assertConflictStageCleaned leaves ZERO unmerged index entries and no MERGE_HEAD after a conflicted-then-aborted merge", async () => {
    const rootDir = mintTmpDir("fusion-test-fusi060-cleanup-");
    try {
      git(rootDir, "git init -b main");
      git(rootDir, "git config user.name tester");
      git(rootDir, "git config user.email tester@example.com");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 1;\n");
      git(rootDir, "git add file.ts");
      git(rootDir, "git commit -m init");

      git(rootDir, "git checkout -b feature");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 2;\n");
      git(rootDir, "git commit -am feature-change");
      git(rootDir, "git checkout main");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 3;\n");
      git(rootDir, "git commit -am main-change");

      try {
        git(rootDir, "git merge feature");
      } catch {
        // expected — conflict; MERGE_HEAD present, UU entry present
      }
      const preStatus = git(rootDir, "git status --porcelain");
      expect(preStatus).toContain("UU file.ts");

      const events: any[] = [];
      await mergerTestHooks.resetMergeWithWarn(rootDir, "FUSI-060-cleanup", "test-conflict-cleanup", {
        git: async (event: any) => events.push(event),
      } as any);

      const postStatus = git(rootDir, "git status --porcelain");
      expect(postStatus.trim()).toBe("");
      // No MERGE_HEAD-less conflict stage: MERGE_HEAD must also be gone.
      expect(() => git(rootDir, "git rev-parse -q --verify MERGE_HEAD")).toThrow();

      const cleanedEvent = events.find((e) => e.type === "merge:conflict-stage-cleaned");
      expect(cleanedEvent).toBeTruthy();
      expect(cleanedEvent?.metadata?.verifiedClean).toBe(true);
      expect(cleanedEvent?.metadata?.remainingUnmergedCount).toBe(0);
    } finally {
      removeTmpDirSync(rootDir);
    }
  });

  it("ordinary tracked-dirty state remains dirty-autostashable (no regression to the unmerged-index refusal)", async () => {
    const rootDir = mintTmpDir("fusion-test-fusi060-ordinary-dirty-");
    try {
      git(rootDir, "git init -b main");
      git(rootDir, "git config user.name tester");
      git(rootDir, "git config user.email tester@example.com");
      writeFileSync(join(rootDir, "file.ts"), "export const a = 1;\n");
      git(rootDir, "git add file.ts");
      git(rootDir, "git commit -m init");

      writeFileSync(join(rootDir, "file.ts"), "export const a = 2;\n");
      writeFileSync(join(rootDir, "untracked.txt"), "scratch\n");

      const state = await classifyTargetCheckoutState(rootDir);
      expect(state.state).toBe("dirty-autostashable");
    } finally {
      removeTmpDirSync(rootDir);
    }
  });
});
