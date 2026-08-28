/**
 * Row type for the collaboration-plane issue mirror — Dexie `collabIssues`.
 *
 * Split from the CRUD module for the same reason
 * `github-issue-mirror-types.ts` is: `lib/db/schema.ts` needs the type to
 * declare the table, and importing the CRUD module there would make the schema
 * depend on its own accessors.
 */

import type { IssuePriority, IssueStatus } from "@/types/issues"
import type { CollabIssueActor } from "@/types/issues/collab"

/**
 * One issue as the collaboration server last reported it.
 *
 * Field-for-field the server's shape plus `fetchedAt`. Deliberately not
 * reshaped on the way in: a mirror that transforms is a mirror that can be
 * wrong in a way the server cannot explain.
 */
export interface CollabIssueMirrorRow {
  /** The server's issue id. Globally unique, so it is the primary key as-is. */
  id: string
  orgId: string
  workspaceId: string
  issueProjectId: string
  title: string
  body?: string
  status: IssueStatus
  priority: IssuePriority
  boardOrder: number
  /** Both actors carry a required id — that is the point of ADR-0149 §10. */
  assignee?: CollabIssueActor
  createdBy: CollabIssueActor
  createdAt: number
  updatedAt: number
  revision?: number
  createdOperationId?: string
  lastOperationId?: string
  /** When this row was last pulled, so a stale board can say so. */
  fetchedAt: number
}
