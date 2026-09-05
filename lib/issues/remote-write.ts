/**
 * Issue writes from a thin client (spec 2026-09-06 D8).
 *
 * A paired phone holds a read-only mirror of the tracker. Its edits go into
 * the durable outbound queue as `issue_apply_action` and `issue_create`
 * jobs, which the companion drain relays to the host, where the board's own
 * gates run (`lib/companion/desktop-write-source.ts`). Nothing is written
 * locally: the next sync pull brings the host's answer back, so a refused
 * move never shows as applied on the phone.
 *
 * Kept free of React so the mobile sheet, the create sheet and a future
 * plugin surface share one entry point.
 */

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import type { IssueActor, IssuePriority, IssueStatus } from "@/types/issues"

/** The kinds a paired client may send. Mirrors the host's allowlist. */
export const REMOTE_ISSUE_ACTION_KINDS = [
  "status",
  "assignee",
  "comment",
  "priority",
  "title",
  "description",
  "dueDate",
  "estimate",
  "cycle",
  "addLabel",
  "removeLabel",
] as const satisfies readonly IssueBulkAction["kind"][]

export type RemoteIssueAction = Extract<
  IssueBulkAction,
  { kind: (typeof REMOTE_ISSUE_ACTION_KINDS)[number] }
>

export function isRemoteIssueAction(action: IssueBulkAction): action is RemoteIssueAction {
  return (REMOTE_ISSUE_ACTION_KINDS as readonly string[]).includes(action.kind)
}

export interface QueueIssueActionInput {
  issueId: string
  /** Printed identifier, for the queue row's label. */
  identifier?: string
  action: RemoteIssueAction
}

/** Queue one board action for the host. Throws when no host target is paired. */
export async function queueIssueAction(
  input: QueueIssueActionInput
): Promise<MobileOutboundJobRow> {
  return enqueue({
    command: "issue_apply_action",
    payload: { issueId: input.issueId, action: input.action },
    label: input.identifier
      ? `${input.identifier}: ${input.action.kind}`
      : `issue: ${input.action.kind}`,
  })
}

export interface QueueIssueCreateInput {
  projectId: string
  issueProjectId: string
  title: string
  description?: string
  status?: IssueStatus
  priority?: IssuePriority
  assignee?: IssueActor
  parentId?: string
  cycleId?: string
  dueDate?: number
  estimate?: number
  labelIds?: string[]
}

/** Queue a new issue for the host. The identifier is allocated there, not here. */
export async function queueIssueCreate(
  input: QueueIssueCreateInput
): Promise<MobileOutboundJobRow> {
  const title = input.title.trim()
  if (!title) throw new Error("Issue title is required")
  const payload: Record<string, unknown> = {
    projectId: input.projectId,
    issueProjectId: input.issueProjectId,
    title,
  }
  if (input.description?.trim()) payload.description = input.description.trim()
  if (input.status) payload.status = input.status
  if (input.priority) payload.priority = input.priority
  if (input.assignee) payload.assignee = input.assignee
  if (input.parentId) payload.parentId = input.parentId
  if (input.cycleId) payload.cycleId = input.cycleId
  if (input.dueDate !== undefined) payload.dueDate = input.dueDate
  if (input.estimate !== undefined) payload.estimate = input.estimate
  if (input.labelIds?.length) payload.labelIds = input.labelIds
  return enqueue({ command: "issue_create", payload, label: title })
}
