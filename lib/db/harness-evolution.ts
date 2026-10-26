/**
 * Persistence for Harness Evolution (ADR-0237): snapshots, runs, steps and the
 * experience library.
 *
 * Runs are written only through compare-and-swap on `version` (the state
 * machine in `lib/harness/machine.ts` bumps it on every transition), so two
 * drivers that both believe they own a run cannot both write it. Ownership is a
 * lease: a driver claims a run for a while and renews; a run whose lease lapsed
 * while it was active is orphaned and can be resumed by anyone.
 *
 * Retention is enforced here, on every finished run: each agent keeps its
 * newest {@link RUNS_KEPT_PER_AGENT} finished runs plus every run whose
 * adoption is still in effect; older runs go with their steps, and snapshots
 * nothing references any more go after them.
 */

import { getDb } from "./schema"
import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import type { HarnessExperience, HarnessExperienceStatus } from "@/types/harness/experience"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { isActiveRunStatus, isTerminalRunStatus } from "@/lib/harness/machine"

export const RUNS_KEPT_PER_AGENT = 100

export class HarnessRunConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | undefined
  ) {
    super(
      actualVersion === undefined
        ? `harness run ${runId} does not exist`
        : `harness run ${runId} is at version ${actualVersion}, expected ${expectedVersion}`
    )
    this.name = "HarnessRunConflictError"
  }
}

// ── snapshots ────────────────────────────────────────────────────────────────

export async function putHarnessSnapshot(snapshot: HarnessSnapshotV1): Promise<void> {
  await getDb().harnessSnapshots.put(snapshot)
}

export async function getHarnessSnapshot(id: string): Promise<HarnessSnapshotV1 | undefined> {
  return getDb().harnessSnapshots.get(id)
}

export async function getHarnessSnapshots(
  ids: readonly string[]
): Promise<Map<string, HarnessSnapshotV1>> {
  const rows = await getDb().harnessSnapshots.bulkGet([...new Set(ids)])
  return new Map(rows.filter((r): r is HarnessSnapshotV1 => Boolean(r)).map((r) => [r.id, r]))
}

/** Snapshots of one agent, newest first. */
export async function listHarnessSnapshots(
  characterId: string,
  limit = 200
): Promise<HarnessSnapshotV1[]> {
  const rows = await getDb()
    .harnessSnapshots.where("[characterId+createdAt]")
    .between([characterId, -Infinity], [characterId, Infinity])
    .reverse()
    .limit(limit)
    .toArray()
  return rows
}

/** The newest snapshot of an agent with this content hash, if one was stored. */
export async function findHarnessSnapshotByHash(
  characterId: string,
  contentHash: string
): Promise<HarnessSnapshotV1 | undefined> {
  const rows = await getDb().harnessSnapshots.where("contentHash").equals(contentHash).toArray()
  return rows
    .filter((r) => r.characterId === characterId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

// ── runs ─────────────────────────────────────────────────────────────────────

export type CreateHarnessRunResult =
  { created: true; run: HarnessEvolutionRun } | { created: false; run: HarnessEvolutionRun }

/**
 * Store a new run, unless an unfinished run with the same dedupe key exists, in
 * which case that run is returned instead.
 */
export async function createHarnessRun(run: HarnessEvolutionRun): Promise<CreateHarnessRunResult> {
  const db = getDb()
  return db.transaction("rw", db.harnessEvolutionRuns, async () => {
    const same = await db.harnessEvolutionRuns.where("dedupeKey").equals(run.dedupeKey).toArray()
    const open = same.find((r) => !isTerminalRunStatus(r.status))
    if (open) return { created: false as const, run: open }
    await db.harnessEvolutionRuns.add(run)
    return { created: true as const, run }
  })
}

export async function getHarnessRun(id: string): Promise<HarnessEvolutionRun | undefined> {
  return getDb().harnessEvolutionRuns.get(id)
}

/** Runs of one agent (or every agent), newest first. */
export async function listHarnessRuns(
  options: { characterId?: string; limit?: number } = {}
): Promise<HarnessEvolutionRun[]> {
  const limit = options.limit ?? 100
  const table = getDb().harnessEvolutionRuns
  if (options.characterId) {
    return table
      .where("[characterId+createdAt]")
      .between([options.characterId, -Infinity], [options.characterId, Infinity])
      .reverse()
      .limit(limit)
      .toArray()
  }
  return table.orderBy("updatedAt").reverse().limit(limit).toArray()
}

/** Runs that are not finished (including those waiting for approval). */
export async function listOpenHarnessRuns(): Promise<HarnessEvolutionRun[]> {
  const rows = await getDb().harnessEvolutionRuns.toArray()
  return rows.filter((r) => !isTerminalRunStatus(r.status))
}

/**
 * Write `next` over the stored run if the stored run is still at
 * `expectedVersion`. `next.version` must already be the bumped version.
 */
export async function saveHarnessRun(
  next: HarnessEvolutionRun,
  expectedVersion: number
): Promise<HarnessEvolutionRun> {
  const db = getDb()
  return db.transaction("rw", db.harnessEvolutionRuns, async () => {
    const current = await db.harnessEvolutionRuns.get(next.id)
    if (!current || current.version !== expectedVersion) {
      throw new HarnessRunConflictError(next.id, expectedVersion, current?.version)
    }
    if (next.version <= current.version) {
      throw new Error(`harness run ${next.id}: a write must raise version past ${current.version}`)
    }
    await db.harnessEvolutionRuns.put(next)
    return next
  })
}

/**
 * Claim (or renew) a run's lease for `ownerId`. Succeeds when the run has no
 * owner, the owner is `ownerId`, or the previous lease lapsed. Returns the run
 * with the new lease, or `null` when someone else holds it.
 */
export async function claimHarnessRunLease(
  runId: string,
  ownerId: string,
  ttlMs: number,
  now: number
): Promise<HarnessEvolutionRun | null> {
  const db = getDb()
  return db.transaction("rw", db.harnessEvolutionRuns, async () => {
    const run = await db.harnessEvolutionRuns.get(runId)
    if (!run || isTerminalRunStatus(run.status)) return null
    if (run.owner && run.owner.ownerId !== ownerId && run.owner.leaseExpiresAt > now) return null
    const next: HarnessEvolutionRun = {
      ...run,
      owner: { ownerId, leaseExpiresAt: now + ttlMs },
      version: run.version + 1,
      updatedAt: now,
    }
    await db.harnessEvolutionRuns.put(next)
    return next
  })
}

/** Give a lease back without changing anything else. A foreign lease is left alone. */
export async function releaseHarnessRunLease(runId: string, ownerId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.harnessEvolutionRuns, async () => {
    const run = await db.harnessEvolutionRuns.get(runId)
    if (!run?.owner || run.owner.ownerId !== ownerId) return
    const next = { ...run, version: run.version + 1, updatedAt: Date.now() }
    delete next.owner
    await db.harnessEvolutionRuns.put(next)
  })
}

/** Active runs whose lease lapsed: their driver is gone. */
export async function listOrphanedHarnessRuns(now: number): Promise<HarnessEvolutionRun[]> {
  const rows = await getDb().harnessEvolutionRuns.toArray()
  return rows.filter(
    (r) => isActiveRunStatus(r.status) && (!r.owner || r.owner.leaseExpiresAt <= now)
  )
}

/** Delete a run and its steps. Its snapshots go with the next {@link pruneHarnessHistory}. */
export async function deleteHarnessRun(runId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.harnessEvolutionRuns, db.harnessEvolutionSteps, async () => {
    await db.harnessEvolutionSteps.where("runId").equals(runId).delete()
    await db.harnessEvolutionRuns.delete(runId)
  })
}

// ── steps ────────────────────────────────────────────────────────────────────

export async function putHarnessStep(step: HarnessEvolutionStep): Promise<void> {
  await getDb().harnessEvolutionSteps.put(step)
}

export async function getHarnessStep(id: string): Promise<HarnessEvolutionStep | undefined> {
  return getDb().harnessEvolutionSteps.get(id)
}

/** A run's steps, in the order they were first written. */
export async function listHarnessSteps(runId: string): Promise<HarnessEvolutionStep[]> {
  const rows = await getDb().harnessEvolutionSteps.where("runId").equals(runId).toArray()
  return rows.sort((a, b) => (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt))
}

/** Rollouts stored under a cache key, from any run. */
export async function listRolloutsByCacheKey(cacheKey: string): Promise<HarnessEvolutionStep[]> {
  return getDb().harnessEvolutionSteps.where("cacheKey").equals(cacheKey).toArray()
}

// ── experiences ──────────────────────────────────────────────────────────────

export async function putHarnessExperience(experience: HarnessExperience): Promise<void> {
  await getDb().harnessExperiences.put(experience)
}

export async function getHarnessExperience(id: string): Promise<HarnessExperience | undefined> {
  return getDb().harnessExperiences.get(id)
}

export interface ListHarnessExperiencesOptions {
  characterId?: string
  domain?: string
  statuses?: readonly HarnessExperienceStatus[]
  includeDisabled?: boolean
}

/** Experiences matching the filter, most recently updated first. */
export async function listHarnessExperiences(
  options: ListHarnessExperiencesOptions = {}
): Promise<HarnessExperience[]> {
  const table = getDb().harnessExperiences
  const rows = options.characterId
    ? await table.where("characterId").equals(options.characterId).toArray()
    : options.domain
      ? await table.where("domain").equals(options.domain).toArray()
      : await table.toArray()
  return rows
    .filter((r) => (options.domain ? r.domain === options.domain : true))
    .filter((r) => (options.statuses ? options.statuses.includes(r.validationStatus) : true))
    .filter((r) => options.includeDisabled || !r.disabled)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Apply `patch` to an experience. Returns the stored row, or `undefined` when it is gone. */
export async function updateHarnessExperience(
  id: string,
  patch: (current: HarnessExperience) => HarnessExperience
): Promise<HarnessExperience | undefined> {
  const db = getDb()
  return db.transaction("rw", db.harnessExperiences, async () => {
    const current = await db.harnessExperiences.get(id)
    if (!current) return undefined
    const next = patch(current)
    await db.harnessExperiences.put(next)
    return next
  })
}

export async function deleteHarnessExperience(id: string): Promise<void> {
  await getDb().harnessExperiences.delete(id)
}

// ── retention ────────────────────────────────────────────────────────────────

export interface PruneResult {
  runsDeleted: number
  snapshotsDeleted: number
}

function adoptionInEffect(run: HarnessEvolutionRun): boolean {
  return Boolean(run.adoption && !run.adoption.rolledBackAt)
}

/**
 * Enforce the run cap for one agent, then delete that agent's snapshots no
 * surviving run, step, experience or agent profile references.
 */
export async function pruneHarnessHistory(
  characterId: string,
  keep = RUNS_KEPT_PER_AGENT
): Promise<PruneResult> {
  const db = getDb()
  return db.transaction(
    "rw",
    [
      db.harnessEvolutionRuns,
      db.harnessEvolutionSteps,
      db.harnessSnapshots,
      db.harnessExperiences,
      db.characters,
    ],
    async () => {
      const runs = await db.harnessEvolutionRuns.where("characterId").equals(characterId).toArray()
      const finished = runs
        .filter((r) => isTerminalRunStatus(r.status) && !adoptionInEffect(r))
        .sort((a, b) => b.createdAt - a.createdAt)
      const doomed = finished.slice(keep)
      for (const run of doomed) {
        await db.harnessEvolutionSteps.where("runId").equals(run.id).delete()
        await db.harnessEvolutionRuns.delete(run.id)
      }

      const referenced = new Set<string>()
      const doomedIds = new Set(doomed.map((r) => r.id))
      for (const run of runs) {
        if (doomedIds.has(run.id)) continue
        if (run.baseSnapshotId) referenced.add(run.baseSnapshotId)
        if (run.decision?.chosenSnapshotId) referenced.add(run.decision.chosenSnapshotId)
        const steps = await db.harnessEvolutionSteps.where("runId").equals(run.id).toArray()
        for (const step of steps) {
          if (step.snapshotId) referenced.add(step.snapshotId)
          if (step.evidence?.snapshotId) referenced.add(step.evidence.snapshotId)
        }
      }
      const experiences = await db.harnessExperiences
        .where("characterId")
        .equals(characterId)
        .toArray()
      for (const e of experiences) {
        referenced.add(e.baseSnapshotId)
        if (e.adoptedSnapshotId) referenced.add(e.adoptedSnapshotId)
      }
      // An agent or one of its variants may still name the snapshot it was
      // adopted from; that is the rollback target and must survive.
      const characters = await db.characters.toArray()
      for (const c of characters) {
        if (c.harness?.adoptedSnapshotId) referenced.add(c.harness.adoptedSnapshotId)
      }
      const snapshots = await db.harnessSnapshots.where("characterId").equals(characterId).toArray()
      // A snapshot's ancestors stay as long as it does: version history is a chain.
      const byId = new Map(snapshots.map((s) => [s.id, s]))
      for (const id of [...referenced]) {
        let parent = byId.get(id)?.parentId
        while (parent && !referenced.has(parent)) {
          referenced.add(parent)
          parent = byId.get(parent)?.parentId
        }
      }
      const unreferenced = snapshots.filter((s) => !referenced.has(s.id)).map((s) => s.id)
      await db.harnessSnapshots.bulkDelete(unreferenced)
      return { runsDeleted: doomed.length, snapshotsDeleted: unreferenced.length }
    }
  )
}
