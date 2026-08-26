/**
 * Collaboration-plane run mirror CRUD — Dexie table `collabRuns` (v198).
 *
 * A read-only cache of what `crates/cognia-collab-server` returns. ADR-0149 §6
 * makes the server authoritative; nothing here is a source of truth and nothing
 * here is edited by the user.
 *
 * Not registered in `lib/sync/handlers/`, for the same reason the other three
 * collaboration mirrors are not: rebuildable from the server in one request.
 *
 * Mechanical module — no network, no gating.
 */

import { isActiveIssueRunStatus } from "@/types/issues"

import type { CollabRunMirrorRow } from "./collab-run-mirror-types"
import { getDb } from "./schema"

export interface CollabRunScope {
  orgId?: string
  workspaceId?: string
  /** Only `queued`/`running` — the "who is working right now" question. */
  activeOnly?: boolean
}

/** Runs the mirror holds, most recently started first. */
export async function listCollabRuns(scope: CollabRunScope = {}): Promise<CollabRunMirrorRow[]> {
  const db = getDb()
  const rows = scope.workspaceId
    ? await db.collabRuns.where("workspaceId").equals(scope.workspaceId).toArray()
    : scope.orgId
      ? await db.collabRuns.where("orgId").equals(scope.orgId).toArray()
      : await db.collabRuns.toArray()
  return rows
    .filter((row) => (scope.orgId ? row.orgId === scope.orgId : true))
    .filter((row) => !scope.activeOnly || isActiveIssueRunStatus(row.status))
    .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id))
}

export async function getCollabRun(id: string): Promise<CollabRunMirrorRow | undefined> {
  return getDb().collabRuns.get(id)
}

/**
 * Replace one org's runs wholesale — same scoping rule as the plan mirror.
 */
export async function replaceCollabRuns(
  orgId: string,
  rows: readonly CollabRunMirrorRow[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.collabRuns, async () => {
    const stale = await db.collabRuns.where("orgId").equals(orgId).primaryKeys()
    if (stale.length > 0) await db.collabRuns.bulkDelete(stale)
    if (rows.length > 0) await db.collabRuns.bulkPut([...rows])
  })
}

export async function clearCollabRuns(): Promise<void> {
  await getDb().collabRuns.clear()
}
