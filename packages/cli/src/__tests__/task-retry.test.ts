import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { runTaskRetry } from "../commands/task.js";

describe("runTaskRetry", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fusion-task-retry-"));
    process.chdir(tmpDir);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createStore() {
    const store = new TaskStore(tmpDir);
    await store.init();
    return store;
  }

  it("retries merge-active missing-worktree session failures by clearing phantom metadata", async () => {
    const store = await createStore();
    const task = await store.createTask({
      title: "missing worktree merge-active task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
      worktree: "/tmp/fusion-missing-worktree",
      branch: `fusion/${task.id}`,
      sessionFile: "/tmp/fusion-session.json",
      steps: [{ name: "implemented", status: "done" }, { name: "fix", status: "pending" }],
      worktreeSessionRetryCount: 3,
      mergeRetries: 3,
    });

    await runTaskRetry(task.id);

    const verificationStore = await createStore();
    const updated = await verificationStore.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.worktree).toBeUndefined();
    expect(updated.branch).toBeUndefined();
    expect(updated.sessionFile).toBeUndefined();
    expect(updated.worktreeSessionRetryCount).toBe(0);
    expect(updated.mergeRetries).toBe(0);
    expect(updated.steps?.[0]?.status).toBe("done");
  });

  it("rejects unrelated merge-active tasks without the missing-worktree signature", async () => {
    const store = await createStore();
    const task = await store.createTask({ title: "ordinary merge", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "ordinary merge still running",
      steps: [{ name: "implemented", status: "done" }],
    });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state/);
  });

  it("clears the deadlock auto-pause when retrying a failed task", async () => {
    const store = await createStore();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const verificationStore = await createStore();
    const updated = await verificationStore.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.paused).toBeUndefined();
    expect(updated.pausedReason).toBeUndefined();
    expect(updated.mergeRetries).toBe(0);
  });

});
