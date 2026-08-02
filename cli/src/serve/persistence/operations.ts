/**
 * The operations behind `cognia-agent durability …`.
 *
 * One invariant governs all of them: **no tool overwrites the only valid
 * generation.** Every operation adds — a generation, a rollback bundle, a
 * manifest revision — and the single destructive operation (`finalize`)
 * requires an explicit confirmation flag and reports the watermark it leaves
 * behind.
 */
import fs from "node:fs"
import path from "node:path"

import { openBackend } from "./backend"
import {
  formatGeneration,
  generationDir,
  latestGeneration,
  listGenerations,
  nextGeneration,
  parseGeneration,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint"
import { journalFile, replayJournal, applyCommits } from "./journal"
import { manifestFile, readManifest, writeManifest, type BackendManifest } from "./manifest"
import { formatParityReport, verifyParity, type ParityReport } from "./parity"
import { sqliteFile } from "./sqlite"
import {
  DurabilityFault,
  emptyDurabilityState,
  isDurabilityBackendId,
  type DurabilityBackendId,
  type DurabilityState,
} from "./types"

export type RecoverySource = "auto" | "snapshot" | "journal" | "sqlite"

export interface DurabilityStatus {
  root: string
  manifest: BackendManifest
  generations: string[]
  latestGeneration: string | null
  checkpointSequence: number | null
  journalCommits: number
  journalSequence: number | null
  journalDiscardedBytes: number
  sqlitePresent: boolean
  sqliteSequence: number | null
  faults: Array<{ code: string; message: string; sequence: number | null }>
  parity: ParityReport | null
}

function recordFault(status: DurabilityStatus, error: unknown): void {
  if (error instanceof DurabilityFault) {
    status.faults.push({ code: error.code, message: error.message, sequence: error.sequence })
    return
  }
  status.faults.push({
    code: "manifest-corrupt",
    message: error instanceof Error ? error.message : String(error),
    sequence: null,
  })
}

/**
 * Inspect an account's durability state without changing a byte.
 *
 * Every probe is independently faulted so one broken store still yields a full
 * report — an operator choosing a recovery source needs to see *all* the
 * options, including the ones that are damaged.
 */
export async function verifyDurability(root: string): Promise<DurabilityStatus> {
  const status: DurabilityStatus = {
    root,
    manifest: readManifestSafely(root),
    generations: [],
    latestGeneration: null,
    checkpointSequence: null,
    journalCommits: 0,
    journalSequence: null,
    journalDiscardedBytes: 0,
    sqlitePresent: fs.existsSync(sqliteFile(root)),
    sqliteSequence: null,
    faults: [],
    parity: null,
  }

  let journalState: DurabilityState | null = null
  try {
    status.generations = listGenerations(root)
    status.latestGeneration = latestGeneration(root)
    if (status.latestGeneration) {
      const checkpoint = readCheckpoint(root, status.latestGeneration)
      status.checkpointSequence = checkpoint.sequence
      const file = journalFile(root, status.latestGeneration)
      if (fs.existsSync(file)) {
        const replay = replayJournal(fs.readFileSync(file, "utf8"), checkpoint.sequence)
        status.journalCommits = replay.commits.length
        status.journalDiscardedBytes = replay.discardedBytes
        applyCommits(checkpoint, replay.commits)
      }
      status.journalSequence = checkpoint.sequence
      journalState = checkpoint
    }
  } catch (error) {
    recordFault(status, error)
  }

  let sqliteState: DurabilityState | null = null
  if (status.sqlitePresent) {
    let backend: ReturnType<typeof openBackend> | null = null
    try {
      backend = openBackend("sqlite-v5", root)
      sqliteState = await backend.load()
      status.sqliteSequence = sqliteState.sequence
    } catch (error) {
      recordFault(status, error)
    } finally {
      await backend?.close()
    }
  }

  if (journalState && sqliteState) {
    status.parity = verifyParity(journalState, sqliteState)
    if (!status.parity.ok) {
      status.faults.push({
        code: "parity-mismatch",
        message: formatParityReport(status.parity),
        sequence: null,
      })
    }
  }

  return status
}

function readManifestSafely(root: string): BackendManifest {
  try {
    return readManifest(root)
  } catch {
    // A corrupt manifest must not stop the report — `verify` is precisely the
    // tool an operator reaches for when the manifest is the broken thing.
    return {
      manifestFormat: 1,
      activeBackend: "journal-v4",
      shadowBackend: null,
      rollbackWatermark: null,
      updatedAt: 0,
    }
  }
}

/** Materialise the journal stack (checkpoint + replay). */
export function readJournalState(root: string): DurabilityState {
  const generation = latestGeneration(root)
  if (!generation) return emptyDurabilityState()
  const state = readCheckpoint(root, generation)
  const file = journalFile(root, generation)
  if (fs.existsSync(file)) {
    const { commits } = replayJournal(fs.readFileSync(file, "utf8"), state.sequence)
    applyCommits(state, commits)
  }
  return state
}

// ── rollback bundles ────────────────────────────────────────────────────────

export function rollbackDir(root: string): string {
  return path.join(root, "rollback")
}

export interface RollbackBundle {
  id: string
  createdAt: number
  reason: string
  manifest: BackendManifest
  generation: string | null
  sequence: number
}

/**
 * Freeze the pre-change state so any migration can be undone.
 *
 * The bundle records the manifest and the generation/sequence in force at the
 * time; the generation itself is never deleted, so restoring the bundle is a
 * pure manifest rewrite.
 */
export function writeRollbackBundle(root: string, reason: string, now = Date.now): RollbackBundle {
  const dir = rollbackDir(root)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const existing = fs
    .readdirSync(dir)
    .filter((name) => /^bundle-\d{4,}\.json$/.test(name))
    .sort()
  const index = existing.length + 1
  const id = `bundle-${String(index).padStart(4, "0")}`
  const generation = latestGeneration(root)
  const bundle: RollbackBundle = {
    id,
    createdAt: now(),
    reason,
    manifest: readManifest(root),
    generation,
    sequence: generation ? readCheckpoint(root, generation).sequence : 0,
  }
  const file = path.join(dir, `${id}.json`)
  const descriptor = fs.openSync(file, "wx", 0o400)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(bundle), "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  return bundle
}

export function listRollbackBundles(root: string): RollbackBundle[] {
  const dir = rollbackDir(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => /^bundle-\d{4,}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RollbackBundle)
}

// ── migrate ─────────────────────────────────────────────────────────────────

export interface MigrateResult {
  from: DurabilityBackendId
  to: DurabilityBackendId
  bundle: RollbackBundle
  parity: ParityReport
  promoted: boolean
}

/**
 * Migrate an account onto `to`.
 *
 * Sequence: rollback bundle → copy the incumbent's state into the target →
 * parity gate → atomic manifest promotion. A failed parity check leaves the
 * manifest untouched and the incumbent authoritative; the half-built target
 * stays on disk for inspection and is simply rebuilt on the next attempt.
 */
export interface MigrateOptions {
  now?: () => number
  /**
   * Parity verifier seam. Production always uses {@link verifyParity}; tests
   * substitute it to exercise the refuse-to-promote path without having to
   * manufacture a real backend divergence.
   */
  verify?: (source: DurabilityState, candidate: DurabilityState) => ParityReport
}

export async function migrateDurability(
  root: string,
  to: DurabilityBackendId,
  opts: MigrateOptions = {}
): Promise<MigrateResult> {
  const now = opts.now ?? Date.now
  const verify = opts.verify ?? verifyParity
  const manifest = readManifest(root)
  const pinned = fs.existsSync(manifestFile(root))
  if (manifest.activeBackend === to) {
    if (pinned) {
      throw new DurabilityFault("parity-mismatch", `account is already on ${to}`)
    }
    // No manifest on disk yet: the account still boots on the `snapshot-v3`
    // default, and `readManifest` only *reported* the in-memory default. Pin it
    // so `serve` actually resolves this backend — that is the documented way to
    // opt an account into the ladder without an env gate.
    writeManifest(root, { ...manifest, activeBackend: to, shadowBackend: null }, now)
    return {
      from: manifest.activeBackend,
      to,
      bundle: writeRollbackBundle(root, `pin ${to}`, now),
      parity: { ok: true, mismatches: [], comparedRows: 0 },
      promoted: true,
    }
  }
  const bundle = writeRollbackBundle(root, `migrate ${manifest.activeBackend} -> ${to}`, now)

  const sourceBackend = openBackend(manifest.activeBackend, root)
  let sourceState: DurabilityState
  try {
    sourceState = await sourceBackend.load()
  } finally {
    await sourceBackend.close()
  }

  const targetBackend = openBackend(to, root)
  let parity: ParityReport
  try {
    await targetBackend.compact(sourceState)
    const targetState = await targetBackend.load()
    parity = verify(sourceState, targetState)
  } finally {
    await targetBackend.close()
  }

  if (!parity.ok) {
    return { from: manifest.activeBackend, to, bundle, parity, promoted: false }
  }

  writeManifest(
    root,
    {
      ...manifest,
      activeBackend: to,
      // Keep the incumbent live as the shadow: the compatibility window is what
      // makes `rollback` a manifest rewrite instead of a restore.
      shadowBackend: manifest.activeBackend,
      rollbackWatermark: manifest.rollbackWatermark ?? bundle.generation,
    },
    now
  )
  return { from: manifest.activeBackend, to, bundle, parity, promoted: true }
}

// ── recover ─────────────────────────────────────────────────────────────────

export interface RecoverResult {
  source: Exclude<RecoverySource, "auto">
  /** Generation the recovered state was staged into. */
  generation: string
  sequence: number
  activated: boolean
  parity: ParityReport
}

/**
 * Stage a recovered state into a **new** generation, verify it, and optionally
 * activate it.
 *
 * `auto` prefers the source that yields the highest verified sequence, which is
 * the only ordering that cannot lose committed work: a damaged journal that
 * replays to sequence 40 loses less than a pristine checkpoint at sequence 12.
 */
export async function recoverDurability(
  root: string,
  from: RecoverySource,
  opts: { activate?: boolean; now?: () => number } = {}
): Promise<RecoverResult> {
  const now = opts.now ?? Date.now
  const candidates = await collectRecoveryCandidates(root, from)
  if (candidates.length === 0) {
    throw new DurabilityFault("checkpoint-corrupt", "no readable recovery source was found")
  }
  candidates.sort((a, b) => b.state.sequence - a.state.sequence)
  const chosen = candidates[0]

  const generation = nextGeneration(root)
  writeCheckpoint(root, generation, chosen.state)
  const staged = readCheckpoint(root, generation)
  const parity = verifyParity(chosen.state, staged)
  if (!parity.ok) {
    throw new DurabilityFault(
      "parity-mismatch",
      `staged generation ${generation} does not match the recovered state:\n${formatParityReport(parity)}`
    )
  }

  let activated = false
  if (opts.activate) {
    writeRollbackBundle(root, `recover ${chosen.source} -> ${generation}`, now)
    const manifest = readManifest(root)
    writeManifest(root, { ...manifest, activeBackend: "journal-v4", shadowBackend: null }, now)
    activated = true
  }

  return { source: chosen.source, generation, sequence: staged.sequence, activated, parity }
}

async function collectRecoveryCandidates(
  root: string,
  from: RecoverySource
): Promise<Array<{ source: Exclude<RecoverySource, "auto">; state: DurabilityState }>> {
  const wanted = (source: Exclude<RecoverySource, "auto">): boolean =>
    from === "auto" || from === source
  const out: Array<{ source: Exclude<RecoverySource, "auto">; state: DurabilityState }> = []

  if (wanted("snapshot")) {
    const generation = latestGeneration(root)
    if (generation) {
      try {
        out.push({ source: "snapshot", state: readCheckpoint(root, generation) })
      } catch (error) {
        if (from !== "auto") throw error
      }
    }
  }
  if (wanted("journal")) {
    try {
      const state = readJournalState(root)
      if (Object.keys(state.dbs).length > 0) out.push({ source: "journal", state })
    } catch (error) {
      if (from !== "auto") throw error
    }
  }
  if (wanted("sqlite") && fs.existsSync(sqliteFile(root))) {
    const backend = openBackend("sqlite-v5", root)
    try {
      out.push({ source: "sqlite", state: await backend.load() })
    } catch (error) {
      if (from !== "auto") throw error
    } finally {
      await backend.close()
    }
  }
  return out
}

// ── rollback ────────────────────────────────────────────────────────────────

export interface RollbackResult {
  generation: string
  sequence: number
  manifest: BackendManifest
}

/**
 * Point the account back at an existing generation.
 *
 * Purely additive: the generation is already on disk (nothing deletes them),
 * so rollback is a bundle + a manifest rewrite. Journal records written after
 * that generation stay in their own file and are simply no longer replayed.
 */
export function rollbackDurability(
  root: string,
  generation: string,
  now = Date.now
): RollbackResult {
  if (parseGeneration(generation) === null) {
    throw new DurabilityFault("checkpoint-corrupt", `"${generation}" is not a generation id`)
  }
  if (!fs.existsSync(path.join(generationDir(root, generation), "checkpoint.json"))) {
    throw new DurabilityFault("checkpoint-corrupt", `generation ${generation} is not on disk`)
  }
  const state = readCheckpoint(root, generation)
  writeRollbackBundle(root, `rollback -> ${generation}`, now)

  // Re-cut the target as the newest generation so the journal appends against
  // it: generations are immutable, and re-opening an older one for append would
  // interleave two histories in a single file.
  const target = nextGeneration(root)
  writeCheckpoint(root, target, state)

  const manifest = readManifest(root)
  const next: BackendManifest = {
    ...manifest,
    activeBackend: "journal-v4",
    shadowBackend: null,
    rollbackWatermark: manifest.rollbackWatermark,
  }
  writeManifest(root, next, now)
  return { generation: target, sequence: state.sequence, manifest: next }
}

// ── finalize ────────────────────────────────────────────────────────────────

export interface FinalizeResult {
  keptGenerations: string[]
  prunedGenerations: string[]
  rollbackWatermark: string
  manifest: BackendManifest
}

/**
 * End a compatibility window: drop the shadow backend and prune generations
 * strictly older than `generation`.
 *
 * The named generation itself is always kept — it becomes the new rollback
 * watermark, and a finalize that left nothing to roll back to would defeat the
 * purpose of the ladder.
 */
export function finalizeDurability(
  root: string,
  generation: string,
  opts: { confirm: boolean; now?: () => number }
): FinalizeResult {
  const now = opts.now ?? Date.now
  if (!opts.confirm) {
    throw new DurabilityFault(
      "parity-mismatch",
      "finalize discards rollback generations and requires --confirm"
    )
  }
  const index = parseGeneration(generation)
  if (index === null) {
    throw new DurabilityFault("checkpoint-corrupt", `"${generation}" is not a generation id`)
  }
  const all = listGenerations(root)
  if (!all.includes(generation)) {
    throw new DurabilityFault("checkpoint-corrupt", `generation ${generation} is not on disk`)
  }
  // No "is it the newest?" guard is needed: `all.includes(generation)` already
  // proves the watermark is on disk, and everything above it is kept.
  const pruned: string[] = []
  for (const candidate of all) {
    if ((parseGeneration(candidate) ?? 0) >= index) continue
    fs.rmSync(generationDir(root, candidate), { recursive: true, force: true })
    fs.rmSync(journalFile(root, candidate), { force: true })
    pruned.push(candidate)
  }

  const manifest = readManifest(root)
  const next: BackendManifest = {
    ...manifest,
    shadowBackend: null,
    rollbackWatermark: generation,
  }
  writeManifest(root, next, now)
  return {
    keptGenerations: listGenerations(root),
    prunedGenerations: pruned,
    rollbackWatermark: generation,
    manifest: next,
  }
}

/** Shared by the CLI: parse a `--to` backend argument. */
export function parseBackendArgument(value: string | undefined): DurabilityBackendId {
  if (!isDurabilityBackendId(value)) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `--to must be one of journal-v4, sqlite-v5, snapshot-v3 (got ${String(value)})`
    )
  }
  return value
}

/** Shared by the CLI: the generation a fresh account would create first. */
export function firstGeneration(): string {
  return formatGeneration(1)
}
