/**
 * Pulling the collaboration plane into its local mirror — ADR-0149 §6.
 *
 * One direction only. The server is authoritative; this refreshes the cache the
 * board reads. Nothing here writes back, and until a write path exists there is
 * no conflict to resolve, which is why this module has no merge logic at all.
 *
 * # Failure is not emptiness
 *
 * A pull that fails leaves the mirror exactly as it was. That is deliberate:
 * blanking the board because a token expired or the network dropped would make
 * a transient failure look like "your team deleted everything". The caller gets
 * the error and decides whether to show a stale badge.
 */

import { replaceCollabIssues } from "@/lib/db/collab-issue-mirror"
import type { CollabIssueMirrorRow } from "@/lib/db/collab-issue-mirror-types"
import {
  listWorkspacesForUser,
  putOrgMembership,
  putWorkspaceMembership,
  removeOrgMembership,
  removeWorkspaceMembership,
} from "@/lib/db/identity"

import type { CollabClient, CollabIssue } from "./client"

export interface PullCollabIssuesResult {
  /** How many rows the mirror now holds for the pulled scope. */
  count: number
  fetchedAt: number
}

export interface PullCollabIssuesDeps {
  now?: () => number
}

/** Turn a server issue into a mirror row. No reshaping beyond the timestamp. */
export function toMirrorRow(issue: CollabIssue, fetchedAt: number): CollabIssueMirrorRow {
  return {
    id: issue.id,
    orgId: issue.orgId,
    workspaceId: issue.workspaceId,
    issueProjectId: issue.issueProjectId,
    ...(issue.body ? { body: issue.body } : {}),
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    boardOrder: issue.boardOrder,
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    createdBy: issue.createdBy,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    fetchedAt,
  }
}

/**
 * Refresh the mirror for one org, optionally narrowed to one workspace.
 *
 * The narrowing is passed through to the replace, so a workspace-scoped pull
 * never deletes rows belonging to a workspace it did not ask about.
 */
export async function pullCollabIssues(
  client: CollabClient,
  scope: { orgId: string; workspaceId?: string },
  deps: PullCollabIssuesDeps = {}
): Promise<PullCollabIssuesResult> {
  const now = deps.now ?? (() => Date.now())
  const fetchedAt = now()

  const issues = await client.listIssues(scope.orgId, {
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  })

  // Defensive: the replace is scoped by org, so a server that answered with
  // another org's rows would otherwise plant them in this org's mirror.
  const rows = issues
    .filter((issue) => issue.orgId === scope.orgId)
    .map((issue) => toMirrorRow(issue, fetchedAt))

  await replaceCollabIssues(scope, rows)
  return { count: rows.length, fetchedAt }
}

export interface PullCollabMembershipsResult {
  userId: string
  /** Workspace memberships the projection now holds for this person and org. */
  workspaces: number
  /** True when the server says this person is in the org itself. */
  orgMember: boolean
}

/**
 * Refresh what ONE person holds in one org — ADR-0149 §4.
 *
 * # Why this exists
 *
 * `orgMemberships` and `workspaceMemberships` have had no filler since they
 * were created. Sign-in writes an org membership *guessed* from the token's
 * `organization_roles`, and nothing at all wrote a workspace one — so "guest"
 * was a shape the code could describe and nothing could ever be in. This is
 * the writer, and it replaces the guess with what the server actually says.
 *
 * # Scoped to this person, not to the org
 *
 * The projection may hold rows for other people (a roster the server sent for
 * some other reason), so the replace deletes only this caller's rows in this
 * org. Wiping the org would delete facts this pull was never told about.
 */
export async function pullCollabMemberships(
  client: CollabClient,
  scope: { orgId: string },
  deps: PullCollabIssuesDeps = {}
): Promise<PullCollabMembershipsResult> {
  const now = deps.now ?? (() => Date.now())
  const at = now()

  const memberships = await client.myMemberships(scope.orgId)
  // Defensive, like the issue pull: a server answering about another org must
  // not have its answer filed under this one.
  if (memberships.orgId !== scope.orgId) {
    throw new Error(
      `collaboration plane answered for ${memberships.orgId} when asked about ${scope.orgId}`
    )
  }
  const userId = memberships.userId

  if (memberships.orgRole) {
    await putOrgMembership({
      orgId: scope.orgId,
      userId,
      role: memberships.orgRole,
      now: at,
    })
  } else {
    // Absent means absent. Leaving a stale org membership behind is exactly
    // what would stop somebody reading as a guest after they were removed from
    // the org but kept in a workspace.
    await removeOrgMembership(scope.orgId, userId)
  }

  const keep = new Set(memberships.workspaces.map((entry) => entry.workspaceId))
  const existing = await listWorkspacesForUser(userId, scope.orgId)
  for (const row of existing) {
    if (!keep.has(row.workspaceId)) {
      await removeWorkspaceMembership(row.workspaceId, userId)
    }
  }
  for (const entry of memberships.workspaces) {
    await putWorkspaceMembership({
      workspaceId: entry.workspaceId,
      orgId: scope.orgId,
      userId,
      role: entry.role,
      now: at,
    })
  }

  return {
    userId,
    workspaces: memberships.workspaces.length,
    orgMember: Boolean(memberships.orgRole),
  }
}
