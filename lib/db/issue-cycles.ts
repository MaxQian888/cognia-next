/**
 * Cycles and milestones, Dexie table `issueCycles` (schema v223).
 *
 * One table for both kinds (spec 2026-09-06, D4): a GitHub milestone, a
 * Projects v2 iteration and a Lark tasklist section all land here, and the
 * board groups by either the same way. `kind` is the only difference the UI
 * cares about (a cycle is a time box, a milestone a target).
 *
 * Mechanical module, like `lib/db/issues.ts`: no gating, no i18n. An issue is
 * planned into a cycle through `setIssueCycle` over there, which appends the
 * `cycle_changed` event. Deleting a cycle clears `cycleId` on every issue
 * that pointed at it, in the same transaction, so nothing dangles.
 */

import type { IssueCycle, IssueCycleKind, IssueCycleStatus, IssueExternalRef } from "@/types/issues"
import { externalKeyOf } from "@/types/issues"
import { getDb } from "./schema"
import { recordTombstones } from "@/lib/sync/tombstones"

function newCycleId(): string {
  return `icyc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** The indexed mirror of `externalRefs`, kept in one helper so it cannot drift. */
function withExternalKeys(row: Omit<IssueCycle, "externalKeys">): IssueCycle {
  return { ...row, externalKeys: row.externalRefs.map(externalKeyOf) }
}

export interface CreateIssueCycleInput {
  /** Owning workspace id. */
  projectId: string
  issueProjectId?: string
  kind: IssueCycleKind
  name: string
  description?: string
  status?: IssueCycleStatus
  startsAt?: number
  endsAt?: number
  externalRefs?: IssueExternalRef[]
  /** Test injection. */
  now?: number
}

export async function createIssueCycle(input: CreateIssueCycleInput): Promise<IssueCycle> {
  const name = input.name.trim()
  if (!name) throw new Error("Cycle name is required")
  if (input.startsAt !== undefined && input.endsAt !== undefined && input.endsAt < input.startsAt) {
    throw new Error("Cycle cannot end before it starts")
  }
  const db = getDb()
  const now = input.now ?? Date.now()
  const row = withExternalKeys({
    id: newCycleId(),
    projectId: input.projectId,
    ...(input.issueProjectId ? { issueProjectId: input.issueProjectId } : {}),
    kind: input.kind,
    name,
    ...(input.description ? { description: input.description } : {}),
    status: input.status ?? "planned",
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    externalRefs: input.externalRefs ?? [],
    createdAt: now,
    updatedAt: now,
  })
  await db.issueCycles.add(row)
  return row
}

export async function getIssueCycle(id: string): Promise<IssueCycle | undefined> {
  return getDb().issueCycles.get(id)
}

export interface ListIssueCyclesQuery {
  projectId?: string
  /** Cycles bound to this container, plus workspace-wide ones (no container). */
  issueProjectId?: string
  kind?: IssueCycleKind
  status?: IssueCycleStatus
}

const STATUS_RANK: Readonly<Record<IssueCycleStatus, number>> = {
  active: 0,
  planned: 1,
  completed: 2,
}

/**
 * Active first, then planned, then completed. Within a status, by start date
 * (unset last), then name, so the rail reads as a timeline.
 */
export function compareIssueCycles(a: IssueCycle, b: IssueCycle): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
  if (rank !== 0) return rank
  const aStart = a.startsAt ?? Number.POSITIVE_INFINITY
  const bStart = b.startsAt ?? Number.POSITIVE_INFINITY
  if (aStart !== bStart) return aStart - bStart
  return a.name.localeCompare(b.name)
}

export async function listIssueCycles(query: ListIssueCyclesQuery = {}): Promise<IssueCycle[]> {
  const db = getDb()
  const rows =
    query.projectId !== undefined
      ? await db.issueCycles.where("projectId").equals(query.projectId).toArray()
      : await db.issueCycles.toArray()
  return rows
    .filter((row) => {
      if (
        query.issueProjectId !== undefined &&
        row.issueProjectId !== undefined &&
        row.issueProjectId !== query.issueProjectId
      ) {
        return false
      }
      if (query.kind !== undefined && row.kind !== query.kind) return false
      if (query.status !== undefined && row.status !== query.status) return false
      return true
    })
    .sort(compareIssueCycles)
}

/** Find a cycle by one of its external refs (`provider:externalId`). */
export async function getIssueCycleByExternalKey(
  provider: string,
  externalId: string
): Promise<IssueCycle | undefined> {
  return getDb()
    .issueCycles.where("externalKeys")
    .equals(externalKeyOf({ provider, externalId }))
    .first()
}

export interface IssueCycleUpdatePatch {
  name?: string
  /** `null` clears. */
  description?: string | null
  status?: IssueCycleStatus
  startsAt?: number | null
  endsAt?: number | null
  issueProjectId?: string | null
  externalRefs?: IssueExternalRef[]
}

export async function updateIssueCycle(id: string, patch: IssueCycleUpdatePatch): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueCycles, async () => {
    const existing = await db.issueCycles.get(id)
    if (!existing) return
    const next: IssueCycle = { ...existing, updatedAt: Date.now() }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (name) next.name = name
    }
    if (patch.description !== undefined) {
      if (patch.description === null || !patch.description.trim()) delete next.description
      else next.description = patch.description
    }
    if (patch.status !== undefined) next.status = patch.status
    if (patch.startsAt !== undefined) {
      if (patch.startsAt === null) delete next.startsAt
      else next.startsAt = patch.startsAt
    }
    if (patch.endsAt !== undefined) {
      if (patch.endsAt === null) delete next.endsAt
      else next.endsAt = patch.endsAt
    }
    if (patch.issueProjectId !== undefined) {
      if (patch.issueProjectId === null) delete next.issueProjectId
      else next.issueProjectId = patch.issueProjectId
    }
    if (patch.externalRefs !== undefined) next.externalRefs = patch.externalRefs
    if (next.startsAt !== undefined && next.endsAt !== undefined && next.endsAt < next.startsAt) {
      throw new Error("Cycle cannot end before it starts")
    }
    await db.issueCycles.put(withExternalKeys(next))
  })
}

/**
 * Delete a cycle and unplan every issue in it. No `cycle_changed` event is
 * appended per issue: the cycle is gone, the issue itself did not change
 * hands, and fifty "removed from cycle" rows on fifty trails would say less
 * than the one deletion that caused them.
 */
export async function deleteIssueCycle(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueCycles, db.issues, db.syncTombstones, async () => {
    const existing = await db.issueCycles.get(id)
    if (!existing) return
    const now = Date.now()
    await db.issues
      .where("cycleId")
      .equals(id)
      .modify((row) => {
        delete row.cycleId
        row.updatedAt = now
      })
    await db.issueCycles.delete(id)
    await recordTombstones("issueCycles", [id], now)
  })
}

/** Cascade used by `deleteIssueDataForWorkspace`. Returns the deleted ids. */
export async function deleteIssueCyclesForWorkspace(projectId: string): Promise<string[]> {
  const db = getDb()
  const ids = (await db.issueCycles.where("projectId").equals(projectId).primaryKeys()) as string[]
  if (ids.length > 0) await db.issueCycles.bulkDelete(ids)
  return ids
}
