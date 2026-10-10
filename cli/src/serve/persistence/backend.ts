/**
 * Backend resolution and the dual-write compatibility window.
 *
 * During a `journal-v4 → sqlite-v5` migration both stores are live: the journal
 * is appended **first** (it stays the ordering authority and the rollback
 * source), and the identical sequence is applied to SQLite **second**. If the
 * process dies between the two, SQLite is behind by at most one commit and
 * startup replays the missing tail from the journal — so the window can be
 * interrupted at any point without losing a transaction.
 *
 * Only after a full parity verification does `durability migrate` promote the
 * shadow to active. Nothing here promotes anything on its own.
 */
import fs from "node:fs"
import path from "node:path"

import { latestGeneration } from "./checkpoint"
import { openJournalBackend, seedCheckpoint } from "./journal"
import {
  defaultManifest,
  manifestFile,
  readManifest,
  writeManifest,
  type BackendManifest,
} from "./manifest"
import { openSqliteBackend, sqliteFile } from "./sqlite"
import {
  DurabilityFault,
  type DurabilityBackendId,
  type DurabilityCommit,
  type DurabilityState,
  type HeadlessDurabilityBackend,
} from "./types"

/** Per-account durability root: `<home>/durability/<accountId>`. */
export function durabilityRoot(home: string, accountId: string): string {
  return path.join(home, "durability", encodeURIComponent(accountId))
}

export function ensureDurabilityRoot(root: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

export function openBackend(id: DurabilityBackendId, root: string): HeadlessDurabilityBackend {
  switch (id) {
    case "journal-v4":
    case "snapshot-v3":
      // `snapshot-v3` is the journal backend's checkpoint half. Opening it as a
      // journal is exactly "read the checkpoint, append nothing yet"; the
      // distinction only matters to the manifest and the CLI's reporting.
      return openJournalBackend({ root })
    case "sqlite-v5":
      return openSqliteBackend({ root })
  }
}

/**
 * A backend that writes through to a primary and mirrors into a shadow.
 *
 * `lastSequence()` and `load()` answer from the **primary** — the shadow is
 * never authoritative until a migration promotes it.
 */
export function createDualWriteBackend(
  primary: HeadlessDurabilityBackend,
  shadow: HeadlessDurabilityBackend
): HeadlessDurabilityBackend {
  return {
    id: primary.id,
    load: () => primary.load(),
    commitSync(commit: DurabilityCommit) {
      primary.commitSync(commit)
      shadow.commitSync(commit)
    },
    async commit(commit) {
      primary.commitSync(commit)
      shadow.commitSync(commit)
    },
    lastSequence: () => primary.lastSequence(),
    async compact(state) {
      // Both backends publish their checkpoint synchronously. Invoke both
      // before yielding so a dual write cannot land between the primary's
      // checkpoint and a stale shadow replacement.
      const [result] = await Promise.all([primary.compact(state), shadow.compact(state)])
      return result
    },
    async close() {
      await primary.close()
      await shadow.close()
    },
  }
}

/** What an account's durability root already holds, before anything is opened. */
export interface DurabilityRootInventory {
  manifest: boolean
  /** At least one journal checkpoint generation exists. */
  journal: boolean
  /** The SQLite store file exists. */
  sqlite: boolean
}

export function inspectDurabilityRoot(root: string): DurabilityRootInventory {
  return {
    manifest: fs.existsSync(manifestFile(root)),
    journal: fs.existsSync(root) && latestGeneration(root) !== null,
    sqlite: fs.existsSync(sqliteFile(root)),
  }
}

/** A root that has never persisted anything: no manifest and no backend data. */
export function isFreshDurabilityRoot(inventory: DurabilityRootInventory): boolean {
  return !inventory.manifest && !inventory.journal && !inventory.sqlite
}

/**
 * The ledger backend whose data an un-pinned root already holds, if any.
 *
 * A root without a manifest is not necessarily empty: before manifests were
 * written on first boot, an env-gated account journalled with no pointer at
 * all. Its files are what they are, whatever the gate says now. Both kinds of
 * data with no manifest cannot be told apart safely, so that is a fault.
 */
export function backendHeldByUnpinnedRoot(
  inventory: DurabilityRootInventory
): Exclude<DurabilityBackendId, "snapshot-v3"> | null {
  if (inventory.manifest) return null
  if (inventory.journal && inventory.sqlite) {
    throw new DurabilityFault(
      "manifest-corrupt",
      "durability root holds both journal and sqlite data but no backend manifest; " +
        "restore the manifest or remove the stale store before starting"
    )
  }
  if (inventory.sqlite) return "sqlite-v5"
  if (inventory.journal) return "journal-v4"
  return null
}

function isEmptyState(state: DurabilityState): boolean {
  return state.sequence === 0 && Object.keys(state.dbs).length === 0
}

export interface ResolvedBackend {
  backend: HeadlessDurabilityBackend
  manifest: BackendManifest
  /** The materialised state the caller should restore into Dexie. */
  state: DurabilityState
  /** Commits replayed into the shadow because it lagged the journal. */
  shadowCatchUp: number
}

export interface ResolveBackendOptions {
  root: string
  /** Seed state for a first boot with no checkpoint yet (schema + rows). */
  seed?: DurabilityState
  /**
   * The ledger backend to open and pin when the root has no manifest yet.
   *
   * Without it an un-pinned root opens as the manifest default (`journal-v4`)
   * and stays un-pinned, which is how a `sqlite-v5` rollout gate used to be
   * silently ignored on a fresh account.
   */
  initialBackend?: Exclude<DurabilityBackendId, "snapshot-v3">
}

/**
 * Open the account's durability stack exactly as the manifest describes it,
 * including catching a lagging shadow up from the journal.
 */
export async function resolveBackend(opts: ResolveBackendOptions): Promise<ResolvedBackend> {
  const root = ensureDurabilityRoot(opts.root)
  if (opts.initialBackend && !fs.existsSync(manifestFile(root))) {
    return pinInitialBackend(root, opts.initialBackend, opts.seed)
  }
  const manifest = readManifest(root)
  if (opts.seed) seedCheckpoint(root, opts.seed)

  const primary = openBackend(manifest.activeBackend, root)
  const state = await primary.load()

  if (!manifest.shadowBackend) {
    return { backend: primary, manifest, state, shadowCatchUp: 0 }
  }
  if (manifest.shadowBackend === manifest.activeBackend) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `backend manifest shadows ${manifest.shadowBackend} onto itself`
    )
  }

  const shadow = openBackend(manifest.shadowBackend, root)
  const shadowState = await shadow.load()
  const catchUp = await catchUpShadow(root, shadow, shadowState, state)
  return {
    backend: createDualWriteBackend(primary, shadow),
    manifest,
    state,
    shadowCatchUp: catchUp,
  }
}

/**
 * Open `id` on an un-pinned root, seed it if it holds nothing, then pin it.
 *
 * The manifest is written last, after the seed is durable: a crash before the
 * pin leaves a root that {@link backendHeldByUnpinnedRoot} resolves back to the
 * same backend, and a seeded store is never seeded twice because seeding only
 * happens while the backend is empty. SQLite has no checkpoint to read a seed
 * from, so an empty SQLite store is seeded by compaction; without that its
 * first commit would reference a database with no schema row.
 */
async function pinInitialBackend(
  root: string,
  id: Exclude<DurabilityBackendId, "snapshot-v3">,
  seed: DurabilityState | undefined
): Promise<ResolvedBackend> {
  if (id === "journal-v4" && seed) seedCheckpoint(root, seed)
  const primary = openBackend(id, root)
  try {
    let state = await primary.load()
    if (seed && isEmptyState(state)) {
      await primary.compact({ ...seed, sequence: 0 })
      state = await primary.load()
    }
    writeManifest(root, { ...defaultManifest(), activeBackend: id })
    return { backend: primary, manifest: readManifest(root), state, shadowCatchUp: 0 }
  } catch (error) {
    await primary.close()
    throw error
  }
}

/**
 * Bring a lagging shadow up to the primary's sequence.
 *
 * The journal holds the ordered commits, but a shadow can also be arbitrarily
 * far behind (a migration that was interrupted before the initial copy). Two
 * regimes, one rule — never leave the shadow at a sequence it did not actually
 * reach:
 *
 * - **Behind by a replayable tail** → apply the missing commits one by one.
 * - **Behind the checkpoint** (its sequence predates the journal's base, so the
 *   tail cannot bridge the gap) → rewrite it wholesale from the primary state.
 */
async function catchUpShadow(
  root: string,
  shadow: HeadlessDurabilityBackend,
  shadowState: DurabilityState,
  primaryState: DurabilityState
): Promise<number> {
  if (shadowState.sequence === primaryState.sequence) return 0
  if (shadowState.sequence > primaryState.sequence) {
    throw new DurabilityFault(
      "parity-mismatch",
      `shadow backend is ahead of the journal (${shadowState.sequence} > ${primaryState.sequence})`,
      primaryState.sequence
    )
  }

  const tail = await readJournalTail(root, shadowState.sequence)
  if (tail === null) {
    await shadow.compact(primaryState)
    return primaryState.sequence - shadowState.sequence
  }
  for (const commit of tail) shadow.commitSync(commit)
  return tail.length
}

/**
 * Commits strictly after `fromSequence`, or `null` when the journal cannot
 * bridge the gap (its checkpoint already sits above `fromSequence`).
 */
async function readJournalTail(
  root: string,
  fromSequence: number
): Promise<DurabilityCommit[] | null> {
  const { latestGeneration, readCheckpoint } = await import("./checkpoint")
  const { journalFile, replayJournal } = await import("./journal")
  const generation = latestGeneration(root)
  if (!generation) return null
  const checkpoint = readCheckpoint(root, generation)
  if (checkpoint.sequence > fromSequence) return null
  const file = journalFile(root, generation)
  if (!fs.existsSync(file)) return []
  const { commits } = replayJournal(fs.readFileSync(file, "utf8"), checkpoint.sequence)
  return commits.filter((commit) => commit.sequence > fromSequence)
}
