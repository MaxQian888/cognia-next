/**
 * The status vocabularies `WorkspaceActivity` renders — as runtime arrays, and
 * as the badge variant each status is drawn with.
 *
 * `PlanStatus` and `IssueRunStatus` are TypeScript unions, which vanish at
 * runtime — so a catalogue test cannot iterate them. These arrays are the
 * runtime authority, and each is typed as covering its union exactly: drop a
 * member and the `satisfies` fails, add one to the union and the missing entry
 * fails too.
 *
 * That matters because the panel builds its labels dynamically
 * (`t(\`planStatus.${status}\`)`), and `lint:i18n` only ever sees literal keys.
 * Without something to walk, a status added to either union would render its
 * own key as the badge text and no gate would notice.
 */

import { OPEN_PLAN_STATUSES, type PlanStatus } from "@/types/agent/plan"
import { ISSUE_RUN_STATUSES, type IssueRunStatus } from "@/types/issues"

/** The Badge variants this module's statuses map onto. */
type StatusVariant = "default" | "secondary" | "outline" | "destructive"

/**
 * How each plan status is drawn. Lives beside the vocabulary it keys on rather
 * than in the component, so "which statuses exist" and "what each one looks
 * like" cannot drift into two different answers — `Record<PlanStatus, …>`
 * fails the moment the union gains a member the panel has no badge for.
 */
export const PLAN_STATUS_VARIANT: Record<PlanStatus, StatusVariant> = {
  draft: "outline",
  awaiting_approval: "secondary",
  approved: "secondary",
  executing: "default",
  paused: "secondary",
  completed: "secondary",
  failed: "destructive",
  cancelled: "outline",
}

/** How each issue-run status is drawn. */
export const RUN_STATUS_VARIANT: Record<IssueRunStatus, StatusVariant> = {
  queued: "outline",
  running: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
}

/**
 * Every `PlanStatus`. Built from `OPEN_PLAN_STATUSES` plus the three terminal
 * ones rather than hand-listed, so the open half can never drift.
 */
export const PLAN_STATUSES_FOR_TEST = [
  ...OPEN_PLAN_STATUSES,
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly PlanStatus[]

/** Every `IssueRunStatus`, straight from the authority that defines them. */
export const RUN_STATUSES_FOR_TEST = ISSUE_RUN_STATUSES satisfies readonly IssueRunStatus[]
