/**
 * The tracker's side of `WorkItemRefV1` (spec 2026-09-06 D9).
 *
 * `packages/agent-config-types` has let a work submission name the issue it
 * was raised for since ADR-0123, and nothing ever read the field: an intent
 * with `workItemRef: { kind: "issue" }` validated and then vanished. These two
 * writers are the reader. `lib/work-submission/service.ts` calls them when a
 * submission is accepted and when it settles, and the plan runtime calls the
 * settle half when a step bound to an issue reaches a terminal status, so the
 * issue's trail shows the agent work that was done for it.
 *
 * Best-effort by contract: a missing issue (deleted since the intent was
 * raised) is not an error the submission should fail on.
 */

import { appendIssueEvent } from "@/lib/db/issue-events"
import { getIssue } from "@/lib/db/issues"
import type { IssueActor } from "@/types/issues"

export interface WorkStartedInput {
  issueId: string
  submissionId: string
  /** The submission's source kind: `chat`, `plan`, `workflow`, ... */
  source: string
  by?: IssueActor
}

/** Returns false when the issue no longer exists. */
export async function recordWorkStarted(input: WorkStartedInput): Promise<boolean> {
  const issue = await getIssue(input.issueId)
  if (!issue) return false
  await appendIssueEvent({
    issueId: issue.id,
    payload: {
      kind: "work_started",
      submissionId: input.submissionId,
      source: input.source,
      by: input.by ?? { kind: "agent", id: `work:${input.source}`, label: input.source },
    },
  })
  return true
}

export interface WorkSettledInput {
  issueId: string
  submissionId: string
  source: string
  /** `succeeded`, `failed`, `cancelled`, or a plan step's terminal status. */
  outcome: string
}

export async function recordWorkSettled(input: WorkSettledInput): Promise<boolean> {
  const issue = await getIssue(input.issueId)
  if (!issue) return false
  await appendIssueEvent({
    issueId: issue.id,
    payload: {
      kind: "work_settled",
      submissionId: input.submissionId,
      source: input.source,
      to: input.outcome,
    },
  })
  return true
}
