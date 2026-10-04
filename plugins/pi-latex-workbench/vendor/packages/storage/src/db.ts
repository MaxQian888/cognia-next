/**
 * Connection handling for the workbench SQLite metadata store.
 * Every connection enforces foreign_keys, WAL journal and a busy timeout.
 */
import { DatabaseSync } from "node:sqlite";
import { WorkbenchError, ERROR_CODES } from "@latexwb/contracts";

export interface OpenDatabaseOptions {
  /** Milliseconds SQLite waits on a locked database before SQLITE_BUSY. */
  busyTimeoutMs?: number;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  const timeout = Math.trunc(options.busyTimeoutMs ?? 5000);
  db.exec(`PRAGMA busy_timeout = ${timeout}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

export function isBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("errcode" in error || "code" in error) &&
    /SQLITE_BUSY|database is locked/i.test(error.message)
  );
}

/**
 * Run `fn` inside BEGIN IMMEDIATE … COMMIT. The immediate lock is taken up
 * front so read-then-write sequences (e.g. event_seq allocation) cannot be
 * silently invalidated by a concurrent writer between statements.
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `transaction failed and rollback failed: ${String(error)}; rollback: ${String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
