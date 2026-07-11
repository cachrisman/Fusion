import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  describe("attachments", () => {
    const TINY_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    it("adds an attachment and persists metadata in task.json", async () => {
      const task = await harness.createTestTask();
      const attachment = await harness.store().addAttachment(task.id, "screenshot.png", TINY_PNG, "image/png");

      expect(attachment.originalName).toBe("screenshot.png");
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.size).toBe(TINY_PNG.length);
      expect(attachment.filename).toMatch(/^\d+-screenshot\.png$/);

      // Verify metadata persisted
      const updated = await harness.store().getTask(task.id);
      expect(updated.attachments).toHaveLength(1);
      expect(updated.attachments![0].filename).toBe(attachment.filename);

      // Verify file on disk
      const filePath = join(harness.rootDir(), ".fusion", "tasks", task.id, "attachments", attachment.filename);
      const content = await readFile(filePath);
      expect(content).toEqual(TINY_PNG);
    });

    /*
     * FNXC:ArtifactRegistry 2026-07-10-00:00:
     * FN-7791 pins the operator requirement that an image created through the task attachment path becomes exactly one task-associated image artifact, while non-image attachments remain attachment-only and do not pollute the image artifact gallery.
     */
    it("bridges image attachments into task-associated image artifacts only", async () => {
      const emptyTask = await harness.store().createTask({ title: "No attachment artifacts", description: "No attachment artifacts" });
      expect(await harness.store().listArtifacts({ taskId: emptyTask.id })).toEqual([]);

      const task = await harness.store().createTask({ title: "Mixed attachment artifacts", description: "Mixed attachment artifacts" });
      const first = await harness.store().addAttachment(task.id, "first.png", TINY_PNG, "image/png");
      const text = await harness.store().addAttachment(task.id, "notes.txt", Buffer.from("not an image"), "text/plain");
      const second = await harness.store().addAttachment(task.id, "second.webp", TINY_PNG, "image/webp");

      const artifacts = await harness.store().listArtifacts({ taskId: task.id });
      expect(artifacts).toHaveLength(2);
      expect(artifacts.map((artifact) => artifact.type)).toEqual(["image", "image"]);
      expect(artifacts.map((artifact) => artifact.title).sort()).toEqual(["first.png", "second.webp"]);
      expect(artifacts.map((artifact) => artifact.taskId)).toEqual([task.id, task.id]);
      expect(artifacts.map((artifact) => artifact.taskTitle)).toEqual([task.title, task.title]);
      expect(artifacts.find((artifact) => artifact.title === text.originalName)).toBeUndefined();
      expect(artifacts.find((artifact) => artifact.title === "first.png")).toMatchObject({
        mimeType: "image/png",
        sizeBytes: first.size,
        uri: `attachments/${first.filename}`,
        authorId: "attachment",
        authorType: "system",
        metadata: {
          source: "attachment",
          attachmentFilename: first.filename,
          originalName: "first.png",
        },
      });
      expect(artifacts.find((artifact) => artifact.title === "second.webp")).toMatchObject({
        mimeType: "image/webp",
        sizeBytes: second.size,
        uri: `attachments/${second.filename}`,
      });
    });

    /*
     * FNXC:ArtifactRegistry 2026-07-10-00:00:
     * registerArtifact() rejects task-linked writes for archived tasks. addAttachment must not let that rejection propagate and undo/orphan the already-written attachment file + task.json entry: addAttachment's own contract (succeeds for a valid image regardless of task lifecycle state) predates this bridge and must be preserved, with only the artifact-gallery bridge skipped.
     */
    it("still succeeds and returns the attachment when the task is archived (artifact bridge is best-effort)", async () => {
      const task = await harness.createTestTask();
      await harness.store().archiveTask(task.id, false);

      const attachment = await harness.store().addAttachment(task.id, "archived-shot.png", TINY_PNG, "image/png");
      expect(attachment.originalName).toBe("archived-shot.png");

      const updated = await harness.store().getTask(task.id, { includeDeleted: true });
      expect(updated.attachments).toHaveLength(1);
    });

    it("accepts text/plain mime type", async () => {
      const task = await harness.createTestTask();
      const attachment = await harness.store().addAttachment(task.id, "error.log", Buffer.from("log content"), "text/plain");
      expect(attachment.originalName).toBe("error.log");
      expect(attachment.mimeType).toBe("text/plain");
      expect(await harness.store().listArtifacts({ taskId: task.id })).toEqual([]);
    });

    it("accepts application/json mime type", async () => {
      const task = await harness.createTestTask();
      const attachment = await harness.store().addAttachment(task.id, "config.json", Buffer.from('{"key":"val"}'), "application/json");
      expect(attachment.mimeType).toBe("application/json");
    });

    it("accepts text/yaml mime type", async () => {
      const task = await harness.createTestTask();
      const attachment = await harness.store().addAttachment(task.id, "config.yaml", Buffer.from("key: val"), "text/yaml");
      expect(attachment.mimeType).toBe("text/yaml");
    });

    it("rejects unsupported mime types", async () => {
      const task = await harness.createTestTask();
      await expect(
        harness.store().addAttachment(task.id, "file.bin", Buffer.from("data"), "application/octet-stream"),
      ).rejects.toThrow("Invalid mime type");
    });

    it("rejects oversized files", async () => {
      const task = await harness.createTestTask();
      const bigBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
      await expect(
        harness.store().addAttachment(task.id, "big.png", bigBuffer, "image/png"),
      ).rejects.toThrow("File too large");
    });

    it("gets attachment path and mime type", async () => {
      const task = await harness.createTestTask();
      const attachment = await harness.store().addAttachment(task.id, "shot.png", TINY_PNG, "image/png");

      const result = await harness.store().getAttachment(task.id, attachment.filename);
      expect(result.mimeType).toBe("image/png");
      expect(result.path).toContain(attachment.filename);
    });

    it("deletes an attachment from disk, metadata, and its bridged artifact", async () => {
      const task = await harness.createTestTask();
      const attachment = await harness.store().addAttachment(task.id, "del.png", TINY_PNG, "image/png");
      expect(await harness.store().listArtifacts({ taskId: task.id })).toHaveLength(1);

      const updated = await harness.store().deleteAttachment(task.id, attachment.filename);
      expect(updated.attachments).toBeUndefined();

      // Verify file removed from disk
      const filePath = join(harness.rootDir(), ".fusion", "tasks", task.id, "attachments", attachment.filename);
      expect(existsSync(filePath)).toBe(false);
      expect(await harness.store().listArtifacts({ taskId: task.id })).toEqual([]);
    });

    it("throws ENOENT when getting non-existent attachment", async () => {
      const task = await harness.createTestTask();
      await expect(
        harness.store().getAttachment(task.id, "nonexistent.png"),
      ).rejects.toThrow("not found");
    });

    it("throws ENOENT when deleting non-existent attachment", async () => {
      const task = await harness.createTestTask();
      await expect(
        harness.store().deleteAttachment(task.id, "nonexistent.png"),
      ).rejects.toThrow("not found");
    });
  });

  // ── Settings tests ────────────────────────────────────────────────
});
