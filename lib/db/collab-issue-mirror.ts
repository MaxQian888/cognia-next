/**
 * Collaboration-plane issue mirror CRUD — Dexie table `collabIssues` (v195).
 *
 * A read-only cache of what `crates/cognia-collab-server` returns. ADR-0149 §6
 * makes the server authoritative; nothing here is a source of truth and nothing
 * here is edited by the user.
 *
 * Deliberately NOT registered in `lib/sync/handlers/`, for the same reason
 * `githubIssueMirror` is not: the mirror is rebuildable from the server in one
 * request, and reconciling a cache that can drift costs more than re-fetching
 * it. The companion sync fan-out is reserved for data that exists only locally.
 *
 * Mechanical module — no network, no gating. Fetching lives in
 * `lib/collab/client.ts`; this module only stores what that returns.
 */

import type { CollabIssueMirrorRow } from "./collab-issue-mirror-types"
import { getDb } from "./schema"

export interface ListCollabIssuesQuery {
  orgId?: string
  workspaceId?: string
  issueProjectId?: string
}

export async function listCollabIssues(
  query: ListCollabIssuesQuery = {}
): Promise<CollabIssueMirrorRow[]> {
  const db = getDb()

  // Take the narrowest available index, then filter the rest in memory — the
  // same shape `listIssues` uses, so the two read paths stay recognisable.
  let rows: CollabIssueMirrorRow[]
  if (query.workspaceId !== undefined) {
    rows = await db.collabIssues.where("workspaceId").equals(query.workspaceId).toArray()
  } else if (query.orgId !== undefined) {
    rows = await db.collabIssues.where("orgId").equals(query.orgId).toArray()
  } else {
    rows = await db.collabIssues.toArray()
  }

  return rows
    .filter((row) => {
      if (query.orgId !== undefined && row.orgId !== query.orgId) return false
      if (query.workspaceId !== undefined && row.workspaceId !== query.workspaceId) return false
      if (query.issueProjectId !== undefined && row.issueProjectId !== query.issueProjectId) {
        return false
      }
      return true
    })
    .sort((a, b) => a.boardOrder - b.boardOrder || b.updatedAt - a.updatedAt)
}

export async function getCollabIssue(id: string): Promise<CollabIssueMirrorRow | undefined> {
  return getDb().collabIssues.get(id)
}

/**
 * Replace this org's mirrored rows with what the server just returned.
 *
 * A wholesale replace rather than an upsert, because the server's answer IS the
 * truth for that scope: an issue the pull did not mention was deleted or moved
 * out of it, and an upsert would leave it on the board forever with no way to
 * notice. Scoped to `orgId` (and `workspaceId` when the pull was narrowed) so a
 * partial refresh never deletes rows it did not ask about.
 */
export async function replaceCollabIssues(
  scope: { orgId: string; workspaceId?: string },
  rows: CollabIssueMirrorRow[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.collabIssues, async () => {
    const existing = await listCollabIssues(scope)
    const incoming = new Set(rows.map((row) => row.id))
    const stale = existing.filter((row) => !incoming.has(row.id)).map((row) => row.id)
    if (stale.length > 0) await db.collabIssues.bulkDelete(stale)
    if (rows.length > 0) await db.collabIssues.bulkPut(rows)
  })
}

/** Forget everything mirrored for an org — used on sign-out. */
export async function clearCollabIssues(orgId?: string): Promise<void> {
  const db = getDb()
  if (orgId === undefined) {
    await db.collabIssues.clear()
    return
  }
  const ids = (await listCollabIssues({ orgId })).map((row) => row.id)
  if (ids.length > 0) await db.collabIssues.bulkDelete(ids)
}
