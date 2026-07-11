/**
 * SQLite adapter that picks the runtime's native SQLite at construction time:
 *   - Bun runtime  → `bun:sqlite` (built-in, no native module dance)
 *   - Node runtime → `node:sqlite` (Node 22+ built-in)
 *
 * Exports a `DatabaseSync` class with the subset of node:sqlite's API that the
 * fn codebase actually uses: `prepare`, `exec`, `close`, and prepared
 * statement methods `all`, `get`, `run`.
 *
 * The adapter exists because Bun's --compile bundler does not implement
 * `node:sqlite` (require returns undefined silently; import throws), so a
 * standalone Bun binary cannot use the same module that plain `node` uses.
 */

import { createRequire } from "node:module";
import { assertOutsideRealFusionPath } from "./test-safety.js";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Use createRequire so the bundler does not statically trace these specifiers.
// Bun's bundler will skip require() calls whose argument it cannot resolve at
// build time, which keeps `node:sqlite` from being eagerly pulled into the
// compiled binary (where it would fail to resolve at runtime).
const requireFromHere = createRequire(import.meta.url);

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
}

interface RawStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
  // Optional snapshot API (node:sqlite ≥ 22.x, bun:sqlite). Both runtimes
  // expose `serialize()` → Uint8Array and `deserialize(buf)` that replaces the
  // open database's contents in place. Used only by the test snapshot harness.
  serialize?: () => Uint8Array;
  deserialize?: (data: Uint8Array) => void;
}

type DatabaseCtor = new (path: string) => RawDatabase;

let cachedCtor: DatabaseCtor | null = null;

function loadDatabaseCtor(): DatabaseCtor {
  if (cachedCtor) return cachedCtor;

  if (isBun) {
    const mod = requireFromHere("bun:sqlite") as { Database: DatabaseCtor };
    cachedCtor = mod.Database;
  } else {
    const mod = requireFromHere("node:sqlite") as { DatabaseSync: DatabaseCtor };
    cachedCtor = mod.DatabaseSync;
  }
  return cachedCtor;
}

/*
FNXC:SqliteConnectionReopen 2026-07-10-22:50:
A long-lived connection can wedge in-process: SQLite's pager/WAL-index view goes
inconsistent (observed 2026-07-10 during checkpoint activity on the 293MB WAL-mode
fusion.db), one query fails "database disk image is malformed", and every query
after that returns SQLITE_NOTADB ("file is not a database") forever — while the
on-disk file stays fully intact. Before this fix the only recovery was restarting
the whole dashboard/engine process, because all corruption-recovery machinery runs
at connection-OPEN time only.

The adapter now heals in place: on a connection-corruption error it closes the dead
handle, opens a fresh one on the same path, replays recorded assignment-style
PRAGMAs (connection-scoped settings like busy_timeout/foreign_keys/synchronous),
verifies the file with PRAGMA quick_check, and retries the failed operation once.
Statements returned by prepare() are generation-tracked so ones created before the
reopen transparently re-prepare on the new connection.

Safety rules:
- Retry only outside an explicit transaction. A statement inside a broken
  transaction must NOT be retried on the fresh connection (it would commit as an
  orphan autocommit write); the connection is still healed but the original error
  is rethrown so the caller's transaction fails loudly.
- After a mid-transaction reopen, the caller's unwind statements
  (ROLLBACK/ROLLBACK TO/RELEASE/COMMIT) are absorbed as no-ops — the fresh
  connection has no transaction, and letting ROLLBACK throw would mask the
  original corruption error in Database.transaction()'s catch path.
- quick_check failing on the fresh connection means real on-disk corruption:
  no retry, the original error propagates, and the open-time recovery machinery
  (Database.recoverIfCorrupt) remains the owner of that case.
- Reopen attempts are rate-limited (default 30s cooldown) so a persistently bad
  file cannot cause a tight reopen loop.
*/

/** Matches errors indicating the CONNECTION's view of the db is broken (SQLITE_NOTADB / SQLITE_CORRUPT). */
function isConnectionCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const text = message.toLowerCase();
  // FTS5 index corruption is an on-disk shadow-table problem with its own
  // recovery path (rebuildFts5Index); a connection reopen would not help.
  if (text.includes("fts5")) return false;
  return text.includes("file is not a database") || text.includes("database disk image is malformed");
}

type TxControlKind = "begin" | "savepoint" | "commit" | "rollback" | "rollback-to" | "release" | null;

/** Classify a SQL string that is purely a transaction-control statement (trigger bodies etc. start with CREATE and never match). */
function classifyTxControl(sql: string): TxControlKind {
  const head = sql.trimStart().slice(0, 32).toUpperCase();
  if (head.startsWith("BEGIN")) return "begin";
  if (head.startsWith("SAVEPOINT")) return "savepoint";
  if (head.startsWith("COMMIT") || head.startsWith("END TRANSACTION")) return "commit";
  if (head.startsWith("ROLLBACK TO")) return "rollback-to";
  if (head.startsWith("ROLLBACK")) return "rollback";
  if (head.startsWith("RELEASE")) return "release";
  return null;
}

/** Assignment-style PRAGMA (`PRAGMA name = value`) — the connection-scoped setup kind worth replaying on reopen. */
const SETUP_PRAGMA_RE = /^\s*PRAGMA\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/i;

const DEFAULT_REOPEN_COOLDOWN_MS = 30_000;

/**
 * Drop-in replacement for `node:sqlite`'s `DatabaseSync`. Backed by
 * `bun:sqlite` under Bun and `node:sqlite` under Node.
 */
export class DatabaseSync {
  private impl: RawDatabase;
  private readonly path: string;
  private readonly diskBacked: boolean;
  private readonly reopenCooldownMs: number;
  /** Bumped on every successful reopen so cached prepared statements re-prepare. */
  private generation = 0;
  private userClosed = false;
  /** Explicit-transaction depth as observed through exec() (BEGIN/SAVEPOINT/...). */
  private txDepth = 0;
  /** >0 while absorbing a caller's unwind of a transaction lost to a reopen. */
  private orphanedTxUnwind = 0;
  /** Last assignment-style PRAGMA per name, replayed onto a reopened connection. */
  private readonly setupPragmas = new Map<string, string>();
  private lastReopenAttemptAt = 0;

  constructor(path: string, options?: { reopenCooldownMs?: number }) {
    assertOutsideRealFusionPath(path, "SQLite database open");
    const Ctor = loadDatabaseCtor();
    this.impl = new Ctor(path);
    this.path = path;
    this.diskBacked = path !== ":memory:";
    this.reopenCooldownMs = Math.max(0, options?.reopenCooldownMs ?? DEFAULT_REOPEN_COOLDOWN_MS);
  }

  /**
   * Heal a wedged connection in place. Returns whether the reopen happened and
   * whether it is safe for the caller to retry the failed operation.
   */
  private attemptCorruptionReopen(cause: unknown): { reopened: boolean; retrySafe: boolean } {
    if (!this.diskBacked || this.userClosed) return { reopened: false, retrySafe: false };
    const now = Date.now();
    if (now - this.lastReopenAttemptAt < this.reopenCooldownMs) return { reopened: false, retrySafe: false };
    this.lastReopenAttemptAt = now;

    const wasInTransaction = this.txDepth > 0;
    try {
      this.impl.close();
    } catch {
      // The dead handle may refuse to close; abandon it either way.
    }

    let fresh: RawDatabase;
    try {
      const Ctor = loadDatabaseCtor();
      fresh = new Ctor(this.path);
    } catch (openError) {
      console.error(
        `[fusion:sqlite] Connection wedged (${cause instanceof Error ? cause.message : String(cause)}) and reopen of ${this.path} failed:`,
        openError,
      );
      return { reopened: false, retrySafe: false };
    }
    this.impl = fresh;
    this.generation++;
    // The old connection's transaction died with it; absorb the caller's unwind.
    this.orphanedTxUnwind = wasInTransaction ? this.txDepth : 0;
    this.txDepth = 0;

    for (const pragma of this.setupPragmas.values()) {
      try {
        fresh.exec(pragma);
      } catch (pragmaError) {
        console.warn(`[fusion:sqlite] Failed to replay "${pragma}" on reopened ${this.path}:`, pragmaError);
      }
    }

    let quickCheckOk = false;
    try {
      const row = fresh.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      quickCheckOk = typeof row?.quick_check === "string" && row.quick_check.toLowerCase() === "ok";
    } catch {
      quickCheckOk = false;
    }
    if (!quickCheckOk) {
      console.error(
        `[fusion:sqlite] Reopened ${this.path} after connection corruption, but quick_check failed — on-disk corruption; leaving recovery to the open-time machinery`,
      );
      return { reopened: true, retrySafe: false };
    }

    console.warn(
      `[fusion:sqlite] Healed wedged connection to ${this.path} (${cause instanceof Error ? cause.message : String(cause)}); reopened in place${wasInTransaction ? "; active transaction was lost and its unwind will be absorbed" : ""}`,
    );
    return { reopened: true, retrySafe: !wasInTransaction };
  }

  /**
   * Run an operation; on a connection-corruption error, heal the connection and
   * retry once when safe. `retry` runs against the reopened connection.
   */
  private runWithCorruptionReopen<T>(op: () => T, retry: () => T): T {
    try {
      return op();
    } catch (error) {
      if (this.userClosed || !isConnectionCorruptionError(error)) throw error;
      const { reopened, retrySafe } = this.attemptCorruptionReopen(error);
      if (!reopened || !retrySafe) throw error;
      return retry();
    }
  }

  exec(sql: string): void {
    const txKind = classifyTxControl(sql);
    if (this.orphanedTxUnwind > 0 && txKind !== null) {
      // Unwind of a transaction that died with the previous connection: the
      // fresh connection has no transaction, so these must be no-ops (a real
      // ROLLBACK here would throw and mask the original corruption error).
      if (txKind === "commit" || txKind === "rollback") {
        this.orphanedTxUnwind = 0;
      } else if (txKind === "release") {
        this.orphanedTxUnwind--;
      } else if (txKind === "begin" || txKind === "savepoint") {
        // A new transaction is starting; the orphaned unwind never completed
        // (caller swallowed the error) — drop the stale state and execute.
        this.orphanedTxUnwind = 0;
        this.execTracked(sql, txKind);
      }
      // "rollback-to" keeps the savepoint alive: pure no-op here.
      return;
    }

    if (this.diskBacked) {
      const pragmaMatch = SETUP_PRAGMA_RE.exec(sql);
      if (pragmaMatch) {
        this.setupPragmas.set(pragmaMatch[1].toLowerCase(), sql);
      }
    }

    this.execTracked(sql, txKind);
  }

  private execTracked(sql: string, txKind: TxControlKind): void {
    this.runWithCorruptionReopen(
      () => this.impl.exec(sql),
      () => this.impl.exec(sql),
    );
    if (txKind === "begin") this.txDepth = 1;
    else if (txKind === "savepoint") this.txDepth++;
    else if (txKind === "commit" || txKind === "rollback") this.txDepth = 0;
    else if (txKind === "release") this.txDepth = Math.max(0, this.txDepth - 1);
  }

  close(): void {
    this.userClosed = true;
    this.impl.close();
  }

  /**
   * FNXC:CoreTests 2026-06-25-16:30:
   * Snapshot the entire database into a byte buffer. Backs the test-only
   * migrated-DB snapshot harness so the 129-migration init() runs once per
   * test file instead of once per test. Throws if the runtime lacks the API.
   */
  serialize(): Uint8Array {
    if (typeof this.impl.serialize !== "function") {
      throw new Error("SQLite runtime does not support serialize()");
    }
    return this.impl.serialize();
  }

  /**
   * FNXC:CoreTests 2026-06-25-16:30:
   * Replace this (in-memory) database's contents with a previously serialized
   * snapshot. Restores a fully-migrated schema without replaying migrations.
   */
  deserialize(data: Uint8Array): void {
    if (typeof this.impl.deserialize !== "function") {
      throw new Error("SQLite runtime does not support deserialize()");
    }
    this.impl.deserialize(data);
  }

  prepare(sql: string): SqliteStatement {
    // Prepare eagerly so SQL syntax errors still surface at prepare() time,
    // but track the connection generation: a statement created before a
    // corruption reopen transparently re-prepares on the new connection.
    let stmt = this.runWithCorruptionReopen(
      () => this.impl.prepare(sql),
      () => this.impl.prepare(sql),
    );
    let stmtGeneration = this.generation;

    const invoke = <T>(call: (s: RawStatement) => T): T =>
      this.runWithCorruptionReopen(
        () => {
          if (stmtGeneration !== this.generation) {
            stmt = this.impl.prepare(sql);
            stmtGeneration = this.generation;
          }
          return call(stmt);
        },
        () => {
          stmt = this.impl.prepare(sql);
          stmtGeneration = this.generation;
          return call(stmt);
        },
      );

    // Both node:sqlite and bun:sqlite expose the same .all/.get/.run shape.
    // Normalize `get` to return undefined (not null) when no row matches, and
    // pass run() through unchanged — both runtimes already produce the same
    // { changes, lastInsertRowid } shape.
    return {
      all: (...params: unknown[]) => invoke((s) => s.all(...params)),
      get: (...params: unknown[]) => {
        const row = invoke((s) => s.get(...params));
        return row ?? undefined;
      },
      run: (...params: unknown[]) => invoke((s) => s.run(...params)),
    };
  }
}
