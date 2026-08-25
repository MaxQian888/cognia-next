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
