/**
 * `sqlite-v5` — Node's built-in SQLite as the headless durability store.
 *
 * Deliberately **generic**: three tables holding database/table/key/value rows
 * plus commit sequence and schema metadata. Mirroring the Dexie schema into
 * SQL would create a second hand-maintained Cognia schema that drifts on every
 * Dexie version bump — the exact failure ADR-0059 D3 rejects.
 *
 * Durability posture: WAL + `synchronous=FULL` so a returned `COMMIT` survives
 * process *and* OS loss, `foreign_keys=ON` so a row can never outlive its
 * schema row, and `integrity_check` on open so corruption surfaces as a typed
 * fault instead of as missing rows. The database directory is `0700` and every
 * SQLite file in it is `0600`.
 */
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { canonicalJson } from "./canonical"
import {
  DurabilityFault,
  type CompactionResult,
  type DurabilityCommit,
  type DurabilitySchema,
  type DurabilityState,
  type HeadlessDurabilityBackend,
} from "./types"

export function sqliteDir(root: string): string {
  return path.join(root, "sqlite")
}

export function sqliteFile(root: string): string {
  return path.join(sqliteDir(root), "store.sqlite")
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS durability_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS durability_schema (
  database TEXT PRIMARY KEY,
  version  INTEGER NOT NULL,
  tables   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS durability_rows (
  database   TEXT NOT NULL REFERENCES durability_schema(database) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_key    TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (database, table_name, row_key)
) STRICT, WITHOUT ROWID;
`

/** The `node:sqlite` surface used here, narrowed so tests can substitute it. */
export interface SqliteDatabaseLike {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  close(): void
}

export interface SqliteBackendOptions {
  root: string
  /** Injected database factory (tests). */
  open?: (file: string) => SqliteDatabaseLike
}

function defaultOpen(file: string): SqliteDatabaseLike {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file) as unknown as SqliteDatabaseLike
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = FULL;")
  db.exec("PRAGMA foreign_keys = ON;")
  return db
}

function restrictPermissions(file: string): void {
  if (process.platform === "win32") return
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600)
    } catch {
      // Permission tightening is best-effort on exotic filesystems; the parent
      // directory is already 0700, which is the boundary that matters.
    }
  }
}

/** Run `PRAGMA integrity_check` and raise a typed fault on anything but `ok`. */
export function assertIntegrity(db: SqliteDatabaseLike): void {
  const rows = db.prepare("PRAGMA integrity_check;").all() as Array<Record<string, unknown>>
  const verdicts = rows.map((row) => String(Object.values(row)[0] ?? "")).filter(Boolean)
  if (verdicts.length !== 1 || verdicts[0] !== "ok") {
    throw new DurabilityFault(
      "sqlite-integrity-failure",
      `sqlite integrity_check reported: ${verdicts.join("; ") || "no result"}`
    )
  }
}

export function openSqliteBackend(opts: SqliteBackendOptions): HeadlessDurabilityBackend {
  const file = sqliteFile(opts.root)
  const db = (opts.open ?? defaultOpen)(file)
  db.exec(SCHEMA_SQL)
  assertIntegrity(db)
  restrictPermissions(file)

  const selectSequence = db.prepare("SELECT value FROM durability_meta WHERE key = 'sequence'")
  const upsertSequence = db.prepare(
    "INSERT INTO durability_meta (key, value) VALUES ('sequence', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
  const upsertSchema = db.prepare(
    "INSERT INTO durability_schema (database, version, tables) VALUES (?, ?, ?) " +
      "ON CONFLICT(database) DO UPDATE SET version = excluded.version, tables = excluded.tables"
  )
  const selectSchemas = db.prepare("SELECT database, version, tables FROM durability_schema")
  const selectRows = db.prepare("SELECT database, table_name, row_key, value FROM durability_rows")
  const upsertRow = db.prepare(
    "INSERT INTO durability_rows (database, table_name, row_key, value) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(database, table_name, row_key) DO UPDATE SET value = excluded.value"
  )
  const deleteRow = db.prepare(
    "DELETE FROM durability_rows WHERE database = ? AND table_name = ? AND row_key = ?"
  )

  function readSequence(): number {
    const row = selectSequence.get() as { value?: string } | undefined
    return row?.value ? Number(row.value) : 0
  }

  let sequence = readSequence()
  let closed = false

  function writeSchemas(state: DurabilityState): void {
    for (const [database, entry] of Object.entries(state.dbs)) {
      upsertSchema.run(
        database,
        entry.schema.version,
        canonicalJson([...entry.schema.tables].sort())
      )
    }
  }

  async function load(): Promise<DurabilityState> {
    const state: DurabilityState = { sequence, dbs: {} }
    for (const raw of selectSchemas.all() as Array<Record<string, unknown>>) {
      const database = String(raw.database)
      let tables: string[] = []
      try {
        const parsed: unknown = JSON.parse(String(raw.tables))
        if (Array.isArray(parsed)) tables = parsed.filter((t): t is string => typeof t === "string")
      } catch {
        throw new DurabilityFault(
          "sqlite-integrity-failure",
          `sqlite schema row for ${database} has an unreadable table list`
        )
      }
      const schema: DurabilitySchema = { version: Number(raw.version), tables }
      const rows: Record<string, Record<string, unknown>> = {}
      for (const table of tables) rows[table] = {}
      state.dbs[database] = { schema, rows }
    }
    for (const raw of selectRows.all() as Array<Record<string, unknown>>) {
      const entry = state.dbs[String(raw.database)]
      if (!entry) continue
      const table = (entry.rows[String(raw.table_name)] ??= {})
      try {
        table[String(raw.row_key)] = JSON.parse(String(raw.value))
      } catch {
        throw new DurabilityFault(
          "sqlite-integrity-failure",
          `sqlite row ${String(raw.database)}.${String(raw.table_name)} holds unreadable JSON`
        )
      }
    }
    return state
  }

  function commitSync(commit: DurabilityCommit): void {
    if (closed) throw new DurabilityFault("sqlite-integrity-failure", "sqlite backend is closed")
    if (commit.sequence <= sequence) {
      // Idempotent redelivery during the dual-write window: the journal is the
      // ordering authority and may replay a sequence SQLite already holds.
      return
    }
    if (commit.sequence !== sequence + 1) {
      throw new DurabilityFault(
        "journal-sequence-gap",
        `sqlite expected sequence ${sequence + 1} but was handed ${commit.sequence}`,
        sequence + 1
      )
    }
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const mutation of commit.mutations) {
        if (mutation.value === null) {
          deleteRow.run(mutation.database, mutation.table, mutation.key)
        } else {
          upsertRow.run(
            mutation.database,
            mutation.table,
            mutation.key,
            canonicalJson(mutation.value)
          )
        }
      }
      upsertSequence.run(String(commit.sequence))
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    sequence = commit.sequence
  }

  /**
   * Replace SQLite's whole content with `state`, inside one transaction.
   *
   * Used by `durability migrate` to seed SQLite from the journal, and by
   * `compact` — SQLite has no journal to fold, so "compaction" is a verified
   * rewrite that also re-pins the schema rows.
   */
  function replaceAll(state: DurabilityState): void {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec("DELETE FROM durability_rows")
      db.exec("DELETE FROM durability_schema")
      writeSchemas(state)
      for (const [database, entry] of Object.entries(state.dbs)) {
        for (const [table, rows] of Object.entries(entry.rows)) {
          for (const [key, value] of Object.entries(rows)) {
            upsertRow.run(database, table, key, canonicalJson(value))
          }
        }
      }
      upsertSequence.run(String(state.sequence))
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    sequence = state.sequence
  }

  const backend: HeadlessDurabilityBackend & { replaceAll(state: DurabilityState): void } = {
    id: "sqlite-v5",
    load,
    commitSync,
    async commit(commit) {
      commitSync(commit)
    },
    lastSequence: () => sequence,
    replaceAll,
    async compact(state: DurabilityState): Promise<CompactionResult> {
      replaceAll(state)
      assertIntegrity(db)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
      return { generation: "sqlite", previousGeneration: null, sequence }
    },
    async close() {
      if (closed) return
      closed = true
      db.close()
      restrictPermissions(file)
    },
  }
  return backend
}

/** Narrowing helper: `replaceAll` only exists on the SQLite backend. */
export function asSqliteBackend(
  backend: HeadlessDurabilityBackend
): (HeadlessDurabilityBackend & { replaceAll(state: DurabilityState): void }) | null {
  return backend.id === "sqlite-v5"
    ? (backend as HeadlessDurabilityBackend & { replaceAll(state: DurabilityState): void })
    : null
}
