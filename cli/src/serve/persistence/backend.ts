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

import { openJournalBackend, seedCheckpoint } from "./journal"
import { readManifest, type BackendManifest } from "./manifest"
import { openSqliteBackend } from "./sqlite"
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
      const result = await primary.compact(state)
      await shadow.compact(state)
      return result
    },
    async close() {
      await primary.close()
      await shadow.close()
    },
  }
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
}

/**
 * Open the account's durability stack exactly as the manifest describes it,
 * including catching a lagging shadow up from the journal.
 */
export async function resolveBackend(opts: ResolveBackendOptions): Promise<ResolvedBackend> {
  const root = ensureDurabilityRoot(opts.root)
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
