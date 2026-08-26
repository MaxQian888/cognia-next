/**
 * Collaboration-plane workspace mirror CRUD — Dexie table `collabWorkspaces`
 * (v197).
 *
 * A read-only cache of what `crates/cognia-collab-server` returns. ADR-0149 §6
 * makes the server authoritative; nothing here is a source of truth and nothing
 * here is edited by the user.
 *
 * Not registered in `lib/sync/handlers/`, for the same reason `collabIssues`
 * is not: it is rebuildable from the server in one request, and reconciling a
 * cache that can drift costs more than re-fetching it.
 *
 * Mechanical module — no network, no gating.
 */

import type { CollabWorkspaceMirrorRow } from "./collab-workspace-mirror-types"
import { getDb } from "./schema"

export async function listCollabWorkspaces(orgId?: string): Promise<CollabWorkspaceMirrorRow[]> {
  const db = getDb()
  const rows =
    orgId === undefined
      ? await db.collabWorkspaces.toArray()
      : await db.collabWorkspaces.where("orgId").equals(orgId).toArray()
  return rows.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
}

export async function getCollabWorkspace(
  id: string
): Promise<CollabWorkspaceMirrorRow | undefined> {
  return getDb().collabWorkspaces.get(id)
}

/**
 * Replace one org's workspaces wholesale.
 *
 * Scoped to the org, so a client that belongs to two never has one pull delete
 * the other's rows. Wholesale within that scope because the server's answer IS
 * the set: a workspace it stopped listing is one this person can no longer
 * see, and keeping it would show access that no longer exists.
 */
export async function replaceCollabWorkspaces(
  orgId: string,
  rows: readonly CollabWorkspaceMirrorRow[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.collabWorkspaces, async () => {
    const stale = await db.collabWorkspaces.where("orgId").equals(orgId).primaryKeys()
    if (stale.length > 0) await db.collabWorkspaces.bulkDelete(stale)
    if (rows.length > 0) await db.collabWorkspaces.bulkPut([...rows])
  })
}

export async function clearCollabWorkspaces(): Promise<void> {
  await getDb().collabWorkspaces.clear()
}
