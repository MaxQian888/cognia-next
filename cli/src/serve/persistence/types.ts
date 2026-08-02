/**
 * Headless durability backend contract (ADR-0059, durability ladder v3→v5).
 *
 * fake-indexeddb/Dexie stays the business-logic runtime; only the *persistence*
 * of that runtime moves behind {@link HeadlessDurabilityBackend}. Three
 * implementations ship:
 *
 * - `snapshot-v3` — the per-table JSON store `cli/src/db/bootstrap.ts` already
 *   writes. Whole-table re-dumps, debounced: the last debounce window is lost
 *   on a crash.
 * - `journal-v4` — an immutable `snapshot-v3` checkpoint plus checksummed,
 *   monotonically sequenced transaction commit records appended and `fsync`ed
 *   from the Dexie transaction-complete path, closing that crash window.
 * - `sqlite-v5` — Node's built-in SQLite (WAL) holding generic
 *   database/table/key/value rows. No second hand-maintained Cognia schema.
 *
 * Every id is wire format: it appears in the on-disk backend manifest and in
 * `durability` CLI output. Append-only, never renamed.
 */

/** Persisted backend implementations, ordered oldest → newest. */
export const DURABILITY_BACKEND_IDS = ["snapshot-v3", "journal-v4", "sqlite-v5"] as const

export type DurabilityBackendId = (typeof DURABILITY_BACKEND_IDS)[number]

export function isDurabilityBackendId(value: unknown): value is DurabilityBackendId {
  return typeof value === "string" && (DURABILITY_BACKEND_IDS as readonly string[]).includes(value)
}

/**
 * One row-level effect inside a committed transaction.
 *
 * `value === null` is a deletion. Keys are the canonical string encoding from
 * `./canonical.ts` — IndexedDB keys may be numbers, strings, dates or arrays,
 * and the backends need one total order and one equality that survives JSON.
 */
export interface DurabilityMutation {
  database: string
  table: string
  key: string
  value: unknown | null
}

/** A complete, durable transaction. Sequences are per-account and gapless. */
export interface DurabilityCommit {
  sequence: number
  /** Wall clock at append time. Diagnostics only — never used for ordering. */
  committedAt: number
  mutations: DurabilityMutation[]
}

/** Schema identity of one Dexie database, pinned so replay cannot cross versions. */
export interface DurabilitySchema {
  version: number
  /** Table names the backend persists (post-exclusion), sorted. */
  tables: string[]
}

/** Full materialised state: `dbs[database].rows[table][key] = value`. */
export interface DurabilityState {
  /** Highest applied commit sequence; 0 when only a checkpoint exists. */
  sequence: number
  dbs: Record<
    string,
    {
      schema: DurabilitySchema
      rows: Record<string, Record<string, unknown>>
    }
  >
}

export function emptyDurabilityState(): DurabilityState {
  return { sequence: 0, dbs: {} }
}

/**
 * The persistence port the headless brain writes through.
 *
 * `commit` MUST be durable (appended and `fsync`ed) before it resolves: the
 * Dexie transaction-complete path awaits nothing, so the *synchronous* variant
 * `commitSync` is what actually runs on that path. `commit` exists for tooling
 * and tests that operate off the hot path.
 */
export interface HeadlessDurabilityBackend {
  readonly id: DurabilityBackendId
  /** Materialise everything persisted so far. */
  load(): Promise<DurabilityState>
  /** Durably record one transaction. Throws if the sequence is not `last + 1`. */
  commitSync(commit: DurabilityCommit): void
  /** Async wrapper over {@link commitSync}, for tooling and tests. */
  commit(commit: DurabilityCommit): Promise<void>
  /** Highest durably recorded sequence. */
  lastSequence(): number
  /** Fold the journal (if any) into a fresh verified generation. */
  compact(state: DurabilityState): Promise<CompactionResult>
  /** Release file handles. Safe to call more than once. */
  close(): Promise<void>
}

export interface CompactionResult {
  /** Generation id the compaction produced, e.g. `gen-0003`. */
  generation: string
  /** Generation that stays on disk as the rollback watermark. */
  previousGeneration: string | null
  sequence: number
}

/** Errors the recovery tooling distinguishes; `code` is wire format. */
export type DurabilityFaultCode =
  | "journal-sequence-gap"
  | "journal-checksum-mismatch"
  | "journal-torn-record"
  | "checkpoint-corrupt"
  | "checkpoint-schema-mismatch"
  | "sqlite-integrity-failure"
  | "manifest-corrupt"
  | "parity-mismatch"

export class DurabilityFault extends Error {
  readonly code: DurabilityFaultCode
  /** Sequence the fault was detected at, when the fault has one. */
  readonly sequence: number | null

  constructor(code: DurabilityFaultCode, message: string, sequence: number | null = null) {
    super(message)
    this.name = "DurabilityFault"
    this.code = code
    this.sequence = sequence
  }
}
