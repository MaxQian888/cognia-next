/**
 * Issue wakeups — subscriptions scoped to one issue that deliver an ordinary
 * run when their input arrives (plan `docs/plans/2026-09-29-multica-060-issue-wakeups.md`).
 *
 * A wakeup is NOT its own table. It is a `ScheduledTask` of type
 * `issue-wakeup` whose payload is {@link IssueWakeupPayload}: the scheduler
 * already owns event matching, timers on every host, lifecycle bounds
 * (`maxRuns` = the fire budget, `endAt` = expiry) and the dashboard
 * projection. What this module adds is the run-management contract around a
 * fire:
 *
 *   - the input joins an in-flight run (steer) instead of queueing a second
 *     one, and is held — never dropped — when the run cannot take it;
 *   - a cross-rule chain ({@link IssueRunWakeup.chain}) pauses a rule that is
 *     revisited without a person in between (`loop`), and an hourly cap pauses
 *     an event rule that keeps firing (`rate`);
 *   - a periodic rule's run may check in: settle without advancing the issue.
 *
 * The lineage rides on the `IssueRun` row, not on the task, because a loop
 * runs THROUGH runs: rule A's run comments, which fires rule B, whose run
 * comments, which fires A. Only the run that caused an event knows which
 * rules led to it.
 */

import type {
  IssueActor,
  IssueActorKind,
  IssueEventKind,
  IssuePullRequestCiState,
  IssuePullRequestState,
  IssueStatus,
} from "./index"

/** The scheduler task type every wakeup is stored as. */
export const ISSUE_WAKEUP_TASK_TYPE = "issue-wakeup" as const

/** The one scheduler event the tracker publishes. Kind and actor ride in its data. */
export const ISSUE_ACTIVITY_EVENT = "issue:activity" as const

/** Scheduler `eventSource` for everything that happens on (or under) one issue. */
export function issueWakeupEventSource(issueId: string): string {
  return `issue:${issueId}`
}

/**
 * What an event rule can watch: every trail kind, plus the two derived kinds
 * the bridge publishes on a PARENT when one of its children changes status or
 * stage. Without them a "wait for my sub-issues" rule would have to subscribe
 * to every child separately and re-subscribe whenever a child is added.
 */
export type IssueWakeupEventKind = IssueEventKind | "child_status_changed" | "child_stage_changed"

/** Pre-fire filter. Every present field must match; absent means "any". */
export interface IssueWakeupMatch {
  kinds?: IssueWakeupEventKind[]
  /** Who caused the event. A `human` filter is how a rule says "only people". */
  actorKinds?: IssueActorKind[]
  /** `status_changed` / `child_status_changed`: only these target statuses. */
  toStatuses?: IssueStatus[]
}

/**
 * A predicate over the tracker's CURRENT state, checked after the match.
 * Keyed so the gate can evaluate it without the author's words.
 *
 *   children-done   the sub-issue barrier (`childrenBarrier`) became reached
 *                   by THIS change: without `stage`, every direct child is
 *                   finished; with `stage` N, every staged child of stage N
 *                   or lower is finished and stage N has at least one child
 *                   (unstaged children and later stages are ignored). A
 *                   change that leaves the barrier where it was never fires,
 *                   so a finished child moving between done and canceled
 *                   wakes nobody, while reopening and re-finishing does.
 *   issue-finished  the target issue is done or canceled. The rule watches
 *                   the target's event source but belongs to its own issue.
 *   pr-merged       a pull request linked to the issue (`github-pr` ref) was
 *                   observed merging (`pr_state_changed` into `merged`).
 *                   Observed by the GitHub import sweep, so only a container
 *                   bound to its repository in import mode can satisfy it.
 *   pr-checks       an open linked pull request's CI settled
 *                   (`pr_checks_changed` into passing or failing): to
 *                   `result` when one is named, to either otherwise. Read by
 *                   the same sweep, so it has the same binding requirement.
 */
export type IssueWakeupCondition =
  | { kind: "children-done"; stage?: number }
  | { kind: "issue-finished"; issueId: string }
  | { kind: "pr-merged" }
  | { kind: "pr-checks"; result?: IssuePullRequestCheckResult }

/** The settled CI a `pr-checks` rule can wait for. */
export type IssuePullRequestCheckResult = Exclude<IssuePullRequestCiState, "pending">

/**
 * How far a parent's sub-issues got, as a children-done rule sees it.
 *
 *   stage  stage N and every earlier stage finished while a later stage
 *          still waits (the platform rule), or the author's stage N reached;
 *   all    every sub-issue finished.
 */
export type IssueChildrenBarrier = { kind: "stage"; stage: number } | { kind: "all" }

/** Why a wakeup stopped itself. Persisted as the task's `lastTerminalReason`. */
export type IssueWakeupPauseReason = "loop" | "rate" | "issue-closed"

/** `lastTerminalReason` values a wakeup writes, one per pause reason. */
export const ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS = {
  loop: "wakeup-paused-loop",
  rate: "wakeup-paused-rate",
  "issue-closed": "wakeup-paused-issue-closed",
} as const satisfies Record<IssueWakeupPauseReason, string>

/** Reverse of {@link ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS}, or `undefined`. */
export function wakeupPauseReasonOf(
  terminalReason: string | undefined
): IssueWakeupPauseReason | undefined {
  for (const [reason, value] of Object.entries(ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS)) {
    if (value === terminalReason) return reason as IssueWakeupPauseReason
  }
  return undefined
}

/** One input a wakeup received — what the woken agent is shown. Bounded text only. */
export interface IssueWakeupEvidence {
  kind: IssueWakeupEventKind
  /** The issue the trail entry was written on (a child, for `child_status_changed`). */
  subjectId: string
  eventId?: string
  /** Unix epoch ms. */
  ts: number
  actor?: IssueActor
  /** One line, already truncated. */
  summary: string
  /** The rule lineage that produced this input (see {@link IssueRunWakeup.chain}). */
  chain: string[]
}

/** Platform-owned rules. Today only the parent-waits-for-children rule. */
export type IssueSystemWakeupKind = "children-done"

/** `ScheduledTask.payload` of an `issue-wakeup` task. */
export interface IssueWakeupPayload extends Record<string, unknown> {
  /** The issue this rule belongs to — where it delivers. */
  issueId: string
  /** What the woken agent is asked to do. */
  instruction: string
  /** Run engine to dispatch to. Absent: the first engine that accepts the issue. */
  adapterId?: string
  /** Who authored the rule; stamped as the `by` of the runs it starts. */
  author?: IssueActor
  match?: IssueWakeupMatch
  condition?: IssueWakeupCondition
  /** Consumed by its first delivery (run started, input joined, person notified). */
  once?: boolean
  /**
   * What happens when the rule's deadline (`ScheduledTask.endAt`) passes
   * first. `wake` delivers once more, saying the wait ran out, so the agent
   * can decide what to do without the event it waited for; absent is drop,
   * the scheduler's own expiry: the rule just stops.
   */
  onTimeout?: "wake"
  system?: IssueSystemWakeupKind
  /**
   * A platform rule's instruction for THIS issue, set by a person. Wins over
   * the container's default (`IssueProject.childrenDoneInstruction`), which
   * wins over the built-in {@link instruction}; resolved when the rule fires,
   * so changing a default reaches every parent without rewriting its rule.
   */
  instructionOverride?: string
  /**
   * Inputs that arrived while an active run could not take them. Delivered
   * when that run settles, so a fact is held rather than lost. Bounded to
   * {@link ISSUE_WAKEUP_MAX_DEFERRED}, oldest dropped first.
   */
  deferred?: IssueWakeupEvidence[]
}

export const ISSUE_WAKEUP_MAX_DEFERRED = 20

/** Longest instruction a wakeup (or a container's children-done default) may carry. */
export const ISSUE_WAKEUP_INSTRUCTION_MAX = 2000

/** `wakeup_fired.delivery`: what a fire turned into. */
export type IssueWakeupDelivery =
  /** A new run was started. */
  | "run"
  /** The input was steered into the run already in flight. */
  | "joined"
  /** The assignee is a person: a Notification Center entry. */
  | "notified"
  /** Nobody is assigned: this trail entry is the whole delivery. */
  | "trail"

/**
 * Lineage on an `IssueRun` a wakeup started.
 *
 * `chain` lists the rules that led to this run, oldest first, ending with the
 * rule that started it. An event the run causes carries the chain onward, and
 * a rule that already appears on it {@link ISSUE_WAKEUP_MAX_CHAIN_VISITS}
 * times pauses as `loop`. An event a PERSON causes carries an empty chain:
 * a human in between is exactly what makes a revisit legitimate.
 */
export interface IssueRunWakeup {
  taskId: string
  chain: string[]
  /** The issue's status before the run took `in_progress` — what a check-in hands back. */
  statusBefore: IssueStatus
  /** Started by a cron/interval rule — the only kind that may check in. */
  periodic: boolean
}

export const ISSUE_WAKEUP_MAX_CHAIN_VISITS = 2

/**
 * `data` of an `issue:activity` scheduler event. Published by
 * `lib/issues/wakeups/bridge.ts`, read by the fire gate and the executor.
 */
export interface IssueActivityEventData extends Record<string, unknown> {
  /** The issue whose event source this was published on. */
  issueId: string
  /** The issue the trail entry was written on (differs for `child_status_changed`). */
  subjectId: string
  kind: IssueWakeupEventKind
  eventId?: string
  ts: number
  actor?: IssueActor
  /** Status transition, for `status_changed` / `child_status_changed`. */
  from?: IssueStatus
  to?: IssueStatus
  /**
   * Stage transition, for `stage_changed` / `child_stage_changed`. `null`
   * is unstaged (kept distinct from "not a stage event").
   */
  fromStage?: number | null
  toStage?: number | null
  /** Triage transition, for `triage_changed`. `null` is accepted. */
  triageTo?: "pending" | null
  /** Pull request state reached, for `pr_state_changed`. */
  prTo?: IssuePullRequestState
  /** CI state reached, for `pr_checks_changed`. */
  ciTo?: IssuePullRequestCiState
  /** Run the event belongs to (its `run_*` entry, or the run whose agent acted). */
  runId?: string
  /** The wakeup that started {@link runId}, for self-suppression. */
  originTaskId?: string
  chain: string[]
  summary: string
}
