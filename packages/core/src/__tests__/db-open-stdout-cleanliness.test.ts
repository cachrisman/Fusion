/*
 * FNXC:StdioProtocolSafety 2026-07-10-00:00:
 * Regression coverage for FUSI-016. `fn mcp serve` uses stdout as the stdio
 * JSON-RPC transport, so any DB-open/migration diagnostic that reaches stdout
 * (e.g. a stray `console.log("[title-id-drift] ...")`) corrupts the protocol
 * stream for strict clients (Claude Desktop rejected the session with
 * "Unexpected token 'i', [title-id-dr... is not valid JSON"). This test locks
 * the invariant broader than the single reported line: opening a board DB or
 * an archive DB — including every migration/backfill/plugin-schema-init path
 * — must never write to stdout. Diagnostics must still reach stderr via the
 * `createLogger` sink so they remain visible to operators.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../db.js";
import { ArchiveDatabase } from "../archive-db.js";

describe("DB open stdout cleanliness (FUSI-016)", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const createdTmpDirs: string[] = [];

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const dir of createdTmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archive DB open + normalizeDriftedTitlesOnce() (populated/drifted + idempotent branches) writes nothing to stdout", () => {
    const archiveDb = new ArchiveDatabase("/tmp/fusion-archive-stdout-cleanliness-test", { inMemory: true });
    archiveDb.init();

    const rawDb = (archiveDb as any).db;
    const archivedAt = new Date().toISOString();
    const entry = {
      id: "FN-9001",
      title: "Refinement: FN-8000: fix drift",
      description: "desc",
      comments: [],
      createdAt: archivedAt,
      updatedAt: archivedAt,
      archivedAt,
      columnMovedAt: archivedAt,
    };

    rawDb
      .prepare(
        `INSERT INTO archived_tasks (id, taskJson, prompt, archivedAt, title, description, comments, createdAt, updatedAt, columnMovedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        JSON.stringify(entry),
        null,
        archivedAt,
        entry.title,
        entry.description,
        "[]",
        archivedAt,
        archivedAt,
        archivedAt,
      );

    // Populated/drifted branch: at least one row needs normalization.
    (archiveDb as any).normalizeDriftedTitlesOnce();
    // Idempotent second-open (already-normalized) branch.
    (archiveDb as any).normalizeDriftedTitlesOnce();

    archiveDb.close();

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleInfoSpy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
    // The diagnostic must still be observable via the stderr-backed logger.
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("board DB open through the real constructor + init() (migration + plugin-schema-init paths) writes nothing to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-db-stdout-cleanliness-"));
    createdTmpDirs.push(dir);

    // Fresh on-disk DB: schemaVersion starts below the current SCHEMA_VERSION,
    // so init()'s migrate() runs the full cumulative migration chain for
    // real — including the title-id-drift (empty/early-return branch) and
    // done-paused-backfill migrations enumerated in FUSI-016 — for a truly
    // empty tasks table (the "fresh DB / count 0" data state).
    const db = new Database(dir, {});
    db.init();

    // Also exercise the plugin-schema-init path, which fires during DB open
    // when plugins register schema hooks (both success and failure legs).
    await db.runPluginSchemaInits([
      { pluginId: "fusi-016-test-plugin", hook: async () => {} },
      {
        pluginId: "fusi-016-test-plugin-failing",
        hook: async () => {
          throw new Error("boom");
        },
      },
    ]);

    db.close();

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleInfoSpy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
    // Diagnostics (including the plugin-init failure) still reach stderr.
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
