/**
 * Collaboration-plane plan mirror CRUD — Dexie table `collabPlans` (v198).
 *
 * A read-only cache of what `crates/cognia-collab-server` returns. ADR-0149 §6
 * makes the server authoritative; nothing here is a source of truth and nothing
 * here is edited by the user.
 *
 * Not registered in `lib/sync/handlers/`, for the same reason `collabIssues`
 * and `collabWorkspaces` are not: it is rebuildable from the server in one
 * request, and reconciling a cache that can drift costs more than re-fetching
 * it.
 *
 * Mechanical module — no network, no gating.
 */

import type { CollabPlanMirrorRow } from "./collab-plan-mirror-types"
import { getDb } from "./schema"

/**
 * Plans the mirror holds, newest activity first.
 *
 * Sorted in memory rather than by the `updatedAt` index because the panel wants
 * descending order within one workspace, and Dexie would otherwise need a
 * compound index to serve both filters at once for a set this small.
 */
export async function listCollabPlans(
  scope: {
    orgId?: string
    workspaceId?: string
  } = {}
): Promise<CollabPlanMirrorRow[]> {
  const db = getDb()
  const rows = scope.workspaceId
    ? await db.collabPlans.where("workspaceId").equals(scope.workspaceId).toArray()
    : scope.orgId
      ? await db.collabPlans.where("orgId").equals(scope.orgId).toArray()
      : await db.collabPlans.toArray()
  const narrowed = scope.orgId ? rows.filter((row) => row.orgId === scope.orgId) : rows
  return narrowed.sort(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  )
}

export async function getCollabPlan(id: string): Promise<CollabPlanMirrorRow | undefined> {
  return getDb().collabPlans.get(id)
}

/**
 * Replace one org's plans wholesale.
 *
 * Scoped to the org, so a client that belongs to two never has one pull delete
 * the other's rows. Wholesale within that scope because the server's answer IS
 * the set: a plan it stopped listing is one this person can no longer see, and
 * keeping it would show work they have lost access to.
 */
export async function replaceCollabPlans(
  orgId: string,
  rows: readonly CollabPlanMirrorRow[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.collabPlans, async () => {
    const stale = await db.collabPlans.where("orgId").equals(orgId).primaryKeys()
    if (stale.length > 0) await db.collabPlans.bulkDelete(stale)
    if (rows.length > 0) await db.collabPlans.bulkPut([...rows])
  })
}

export async function clearCollabPlans(): Promise<void> {
  await getDb().collabPlans.clear()
}
