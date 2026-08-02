/**
 * The seam between Dexie and a {@link HeadlessDurabilityBackend}.
 *
 * Boot order matters and is not negotiable:
 *
 *   1. install capture middleware (BEFORE Dexie opens — the DBCore stack is
 *      generated at open time, so a later `use()` is inert)
 *   2. open the backend and materialise its state
 *   3. restore that state into Dexie **with capture suppressed**
 *   4. from here on, every committed transaction is journalled synchronously
 *
 * Compaction runs off a commit counter, never on a timer: a brain that is idle
 * has nothing to compact, and one that is hot should fold its journal on write
 * volume rather than wall clock.
 */
import { decodeKey, encodeKey } from "./canonical"
import { installTransactionCapture, type CaptureDexieLike, type CaptureHandle } from "./capture"
import { durabilityRoot, resolveBackend, type ResolvedBackend } from "./backend"
import type { DurabilityMutation, DurabilityState, HeadlessDurabilityBackend } from "./types"

/** Dexie `Table` surface the store needs. */
export interface DurabilityTableLike {
  name: string
  schema?: { primKey?: { keyPath?: string | string[] | null } }
  toArray(): Promise<unknown[]>
  clear(): Promise<unknown>
  bulkPut(rows: unknown[], keys?: unknown[]): Promise<unknown>
  toCollection?(): { primaryKeys(): Promise<unknown[]> }
}

/** Dexie `Dexie` surface the store needs. */
export interface DurabilityDbLike extends CaptureDexieLike {
  name?: string
  verno: number
  tables: DurabilityTableLike[]
  open?(): Promise<unknown>
  /** Dexie exposes this; used to refuse a too-late middleware install. */
  isOpen?(): boolean
}

export interface DurabilitySourceLike {
  name: string
  db: DurabilityDbLike
  excludeTables?: readonly string[]
}

export interface DurabilityStoreOptions {
  home: string
  accountId: string
  /** Opened lazily so the capture middleware installs before Dexie opens. */
  getSources: () => Promise<readonly DurabilitySourceLike[]>
  /** Await Dexie readiness (seeding) between middleware install and restore. */
  whenReady?: () => Promise<void>
  /** Commits between automatic compactions. 0 disables auto-compaction. */
  compactEveryCommits?: number
  /** Injected clock (tests). */
  now?: () => number
}

export interface DurabilityStore {
  backend: HeadlessDurabilityBackend
  sources: readonly DurabilitySourceLike[]
  /** Highest durably recorded sequence. */
  sequence(): number
  /** Commits recorded since the store opened. */
  commitCount(): number
  /** Fold the journal into a fresh verified generation. */
  compact(): Promise<void>
  /** Materialise the live Dexie content in backend form (parity/tooling). */
  readLiveState(): Promise<DurabilityState>
  close(): Promise<void>
}

function includedTables(source: DurabilitySourceLike): DurabilityTableLike[] {
  const excluded = new Set(source.excludeTables ?? [])
  return source.db.tables.filter((table) => !excluded.has(table.name))
}

function keyPathOf(table: DurabilityTableLike): string | string[] | null {
  return table.schema?.primKey?.keyPath ?? null
}

function extractByKeyPath(value: unknown, keyPath: string | string[]): unknown {
  if (Array.isArray(keyPath)) return keyPath.map((part) => extractByKeyPath(value, part))
  let cursor: unknown = value
  for (const segment of keyPath.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** Dump one table into `{ encodedKey: row }`, handling outbound-key tables. */
export async function readTableRows(table: DurabilityTableLike): Promise<Record<string, unknown>> {
  const rows = await table.toArray()
  const keyPath = keyPathOf(table)
  const out: Record<string, unknown> = {}
  if (keyPath) {
    for (const row of rows) {
      const key = extractByKeyPath(row, keyPath)
      if (key === undefined) continue
      out[encodeKey(key)] = row
    }
    return out
  }
  const keys = (await table.toCollection?.().primaryKeys()) ?? []
  for (let index = 0; index < rows.length; index += 1) {
    const key = keys[index]
    if (key === undefined) continue
    out[encodeKey(key)] = rows[index]
  }
  return out
}

/** Materialise every included table of every source. */
export async function readSourcesState(
  sources: readonly DurabilitySourceLike[],
  sequence: number
): Promise<DurabilityState> {
  const state: DurabilityState = { sequence, dbs: {} }
  for (const source of sources) {
    const tables = includedTables(source)
    const rows: Record<string, Record<string, unknown>> = {}
    for (const table of tables) rows[table.name] = await readTableRows(table)
    state.dbs[source.name] = {
      schema: { version: source.db.verno, tables: tables.map((t) => t.name).sort() },
      rows,
    }
  }
  return state
}

/** Overlay persisted rows onto the (already open, already seeded) databases. */
export async function restoreState(
  sources: readonly DurabilitySourceLike[],
  state: DurabilityState
): Promise<void> {
  for (const source of sources) {
    const entry = state.dbs[source.name]
    if (!entry) continue
    if (entry.schema.version !== source.db.verno) {
      const { DurabilityFault } = await import("./types")
      throw new DurabilityFault(
        "checkpoint-schema-mismatch",
        `persisted schema version ${entry.schema.version} does not match database ${source.name} version ${source.db.verno}`
      )
    }
    for (const table of includedTables(source)) {
      const rows = entry.rows[table.name]
      if (!rows) continue
      await table.clear()
      const encodedKeys = Object.keys(rows)
      if (encodedKeys.length === 0) continue
      const values = encodedKeys.map((key) => rows[key])
      if (keyPathOf(table)) await table.bulkPut(values)
      else await table.bulkPut(values, encodedKeys.map(decodeKey))
    }
  }
}

/**
 * Open the durability store for one account.
 *
 * The returned handle owns the backend; `close()` compacts nothing and simply
 * releases handles — a journal that is not compacted is still complete.
 */
export async function openDurabilityStore(opts: DurabilityStoreOptions): Promise<DurabilityStore> {
  const now = opts.now ?? Date.now
  const compactEvery = opts.compactEveryCommits ?? 2_000
  const root = durabilityRoot(opts.home, opts.accountId)

  let backendRef: HeadlessDurabilityBackend | null = null
  let sequence = 0
  let commits = 0
  let sinceCompaction = 0
  const captures: CaptureHandle[] = []

  let compacting: Promise<void> | null = null

  function onCommit(mutations: DurabilityMutation[]): void {
    const backend = backendRef
    if (!backend) return
    sequence += 1
    backend.commitSync({ sequence, committedAt: now(), mutations })
    commits += 1
    sinceCompaction += 1
    // Compaction is off the commit path on purpose: the transaction is already
    // durable, so folding it into a checkpoint is background work. A failure
    // here is not data loss — the journal still holds every commit — so it is
    // swallowed rather than propagated into an event listener.
    if (compactEvery > 0 && sinceCompaction >= compactEvery && !compacting) {
      compacting = compact()
        .catch(() => {})
        .finally(() => {
          compacting = null
        })
    }
  }

  const sources = await opts.getSources()
  for (const source of sources) {
    // Dexie generates its DBCore stack at open time, so a `use()` after open is
    // inert — the brain would run with a journal that records nothing and no
    // symptom until a crash. Refuse instead.
    if (source.db.isOpen?.()) {
      const { DurabilityFault } = await import("./types")
      throw new DurabilityFault(
        "manifest-corrupt",
        `database ${source.name} was already open when durability capture was installed; ` +
          "the capture middleware must be installed before Dexie opens"
      )
    }
    captures.push(
      installTransactionCapture(source.db, {
        database: source.name,
        excludeTables: source.excludeTables,
        onCommit,
      })
    )
  }

  await opts.whenReady?.()
  for (const source of sources) await source.db.open?.()

  // Seed the immutable generation from whatever the freshly-opened (seeded)
  // databases hold, so a first boot has a checkpoint to append against.
  const seed = await readSourcesState(sources, 0)
  const resolved: ResolvedBackend = await resolveBackend({ root, seed })
  backendRef = resolved.backend
  sequence = resolved.backend.lastSequence()

  await withAllSuppressed(captures, () => restoreState(sources, resolved.state))

  async function compact(): Promise<void> {
    const backend = backendRef
    if (!backend) return
    const live = await readSourcesState(sources, sequence)
    await backend.compact(live)
    sinceCompaction = 0
  }

  return {
    backend: resolved.backend,
    sources,
    sequence: () => sequence,
    commitCount: () => commits,
    async compact() {
      await compact()
    },
    readLiveState: () => readSourcesState(sources, sequence),
    async close() {
      if (compacting) await compacting
      await resolved.backend.close()
      backendRef = null
    },
  }
}

async function withAllSuppressed(
  captures: readonly CaptureHandle[],
  fn: () => Promise<void>
): Promise<void> {
  if (captures.length === 0) {
    await fn()
    return
  }
  const [head, ...rest] = captures
  await head.suppress(() => withAllSuppressed(rest, fn))
}
