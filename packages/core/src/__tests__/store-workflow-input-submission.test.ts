import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { Task } from "../types.js";

const marker = "workflow-input:approval@1737000000000: Confirm the production rollout?";

function mutationSnapshot(store: ReturnType<typeof createTaskStoreTestHarness>["store"], task: Task) {
  return {
    task: {
      id: task.id,
      column: task.column,
      status: task.status,
      paused: task.paused,
      pausedReason: task.pausedReason,
      comments: task.comments,
      steeringComments: task.steeringComments,
      log: task.log,
    },
    audit: store.getRunAuditEvents({ taskId: task.id, mutationType: "task:workflow-input-submitted" }),
  };
}

describe("TaskStore.submitWorkflowInput", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  async function createPausedTask(pausedReason = marker) {
    const task = await harness.store().createTask({ description: "Await operator input" });
    await harness.store().updateTask(task.id, {
      paused: true,
      status: "awaiting-user-input",
      pausedReason,
    });
    return task;
  }

  it("accepts one matching marker, retains it, and records one shared steering reply", async () => {
    const task = await createPausedTask();

    const result = await harness.store().submitWorkflowInput(task.id, "Ship it", marker);

    expect(result).toEqual({
      ok: true,
      task: { id: task.id, column: "triage", paused: false },
    });
    const updated = await harness.store().getTask(task.id);
    expect(updated.paused).toBeFalsy();
    expect(updated.status).toBeUndefined();
    expect(updated.pausedReason).toBe(marker);
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments?.[0]).toMatchObject({ text: "Ship it", author: "user" });
    expect(updated.steeringComments).toHaveLength(1);
    expect(updated.steeringComments?.[0]).toMatchObject({ text: "Ship it", author: "user", id: updated.comments?.[0]?.id });
    expect(updated.log.filter((entry) => entry.action === "Comment added by user")).toHaveLength(1);

    const audits = harness.store().getRunAuditEvents({ taskId: task.id, mutationType: "task:workflow-input-submitted" });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ commentsAdded: 1, steeringCommentsAdded: 1, outcome: "resumed" });
    expect(JSON.stringify(audits[0])).not.toContain(marker);
    expect(JSON.stringify(audits[0])).not.toContain("Ship it");
  });

  it("returns not-found without creating an audit event", async () => {
    const result = await harness.store().submitWorkflowInput("FN-404", "Ship it", marker);

    expect(result).toEqual({ ok: false, code: "not-found" });
    expect(harness.store().getRunAuditEvents({ taskId: "FN-404", mutationType: "task:workflow-input-submitted" })).toEqual([]);
  });

  it("rejects an already-resumed retained marker without mutation", async () => {
    const task = await createPausedTask();
    await expect(harness.store().submitWorkflowInput(task.id, "First reply", marker)).resolves.toMatchObject({ ok: true });
    const before = mutationSnapshot(harness.store(), await harness.store().getTask(task.id));

    const result = await harness.store().submitWorkflowInput(task.id, "Second reply", marker);

    expect(result).toEqual({ ok: false, code: "not-paused", task: { id: task.id, column: "triage", paused: false } });
    expect("currentWorkflowInputMarker" in result).toBe(false);
    expect(mutationSnapshot(harness.store(), await harness.store().getTask(task.id))).toEqual(before);
  });

  it("rejects a non-workflow pause without disclosing its reason or mutating", async () => {
    const task = await createPausedTask("operator-requested-pause");
    const before = mutationSnapshot(harness.store(), await harness.store().getTask(task.id));

    const result = await harness.store().submitWorkflowInput(task.id, "Ship it", marker);

    expect(result).toEqual({ ok: false, code: "not-workflow-input", task: { id: task.id, column: "triage", status: "awaiting-user-input", paused: true } });
    expect("currentWorkflowInputMarker" in result).toBe(false);
    expect(mutationSnapshot(harness.store(), await harness.store().getTask(task.id))).toEqual(before);
  });

  it("rejects wrong and replaced markers without mutation while exposing only the active workflow marker", async () => {
    const task = await createPausedTask();
    const beforeWrong = mutationSnapshot(harness.store(), await harness.store().getTask(task.id));

    const wrong = await harness.store().submitWorkflowInput(task.id, "Ship it", `${marker} stale`);

    expect(wrong).toEqual({
      ok: false,
      code: "marker-mismatch",
      task: { id: task.id, column: "triage", status: "awaiting-user-input", paused: true },
      currentWorkflowInputMarker: marker,
    });
    expect(mutationSnapshot(harness.store(), await harness.store().getTask(task.id))).toEqual(beforeWrong);

    const replacement = "workflow-input:approval@1737000000001: Confirm the revised rollout?";
    await harness.store().updateTask(task.id, { pausedReason: replacement });
    const beforeReplacement = mutationSnapshot(harness.store(), await harness.store().getTask(task.id));
    const stale = await harness.store().submitWorkflowInput(task.id, "Ship it", marker);

    expect(stale).toMatchObject({ ok: false, code: "marker-mismatch", currentWorkflowInputMarker: replacement });
    expect(mutationSnapshot(harness.store(), await harness.store().getTask(task.id))).toEqual(beforeReplacement);
  });
});
