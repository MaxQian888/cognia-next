/**
 * The `issue-wakeup` fire gate (`registerEventFireGate`).
 *
 * Runs before the scheduler records an execution, so everything that should
 * cost a rule nothing is decided here:
 *
 *   - held inputs are released when the run that blocked them settles, or
 *     the issue that held them in triage is accepted;
 *   - an event the rule's own run caused never refires it;
 *   - the match (kinds, actor kinds, target statuses) and the condition
 *     (the sub-issue barrier advanced, the watched issue finished, a linked
 *     pull request merged) must
 *     hold; a children-done fire carries the barrier it reached;
 *   - an input that arrives while the issue's run cannot take it is held on
 *     the rule instead of firing, so it is neither lost nor turned into a
 *     second run racing the first.
 *
 * Loop and rate protection are NOT here: tripping them is a fire that pauses
 * the rule, and a person reading the rule's history should see that fire.
 */

import type { ScheduledTask } from "@/types/scheduler"
import type {
  IssueActivityEventData,
  IssueChildrenBarrier,
  IssueWakeupPayload,
} from "@/types/issues"
import type { EventFireInput, EventFireVerdict } from "@/lib/scheduler/task-scheduler"
import { getIssue, listIssues } from "@/lib/db/issues"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { issueRunSessionIds } from "@/lib/issues/run/registry"
import { hasMergedPullRequest } from "@/lib/issues/pull-requests"
import {
  appendDeferred,
  barrierAdvanced,
  childrenBarrier,
  describeBarrier,
  evidenceFromActivity,
  isTerminalIssueStatus,
  matchesWakeup,
  readActivityData,
  readWakeupPayload,
  type BarrierChild,
} from "./model"
import { holdIssueWakeupInputs } from "./service"

/** Merged over the payload of a fire that releases held inputs. */
export const WAKEUP_RELEASE_FLAG = "wakeupRelease"

/** Merged over the payload of a children-done fire: the `IssueChildrenBarrier` it reached. */
export const WAKEUP_BARRIER_KEY = "wakeupBarrier"

/** Trail kinds that end a run — the moments held inputs may go out. */
const RUN_SETTLE_KINDS: ReadonlySet<string> = new Set([
  "run_succeeded",
  "run_failed",
  "run_checked_in",
])

/** A `triage_changed` entry that took the issue out of triage. */
function isTriageAccepted(data: IssueActivityEventData): boolean {
  return data.kind === "triage_changed" && data.triageTo === null
}

export interface IssueWakeupGateDeps {
  hold: typeof holdIssueWakeupInputs
}

const defaultDeps: IssueWakeupGateDeps = { hold: holdIssueWakeupInputs }

type ConditionVerdict = { holds: false } | { holds: true; barrier?: IssueChildrenBarrier }

/** The child that changed, as it was before the change the event reports. */
function childBefore(child: BarrierChild, data: IssueActivityEventData): BarrierChild {
  if (child.id !== data.subjectId) return child
  if (data.kind === "child_status_changed" && data.from) return { ...child, status: data.from }
  if (data.kind === "child_stage_changed" && data.fromStage !== undefined) {
    const { stage: _stage, ...rest } = child
    return data.fromStage === null ? rest : { ...rest, stage: data.fromStage }
  }
  return child
}

async function conditionHolds(
  payload: IssueWakeupPayload,
  data: IssueActivityEventData
): Promise<ConditionVerdict> {
  const condition = payload.condition
  if (!condition) return { holds: true }
  switch (condition.kind) {
    case "children-done": {
      if (data.kind !== "child_status_changed" && data.kind !== "child_stage_changed") {
        return { holds: false }
      }
      const children: BarrierChild[] = (await listIssues({ parentId: payload.issueId })).map(
        (child) => ({
          id: child.id,
          status: child.status,
          ...(child.stage !== undefined ? { stage: child.stage } : {}),
        })
      )
      const options = {
        ...(condition.stage !== undefined ? { stage: condition.stage } : {}),
        // The platform rule hands off stage by stage; an author's rule waits
        // for its own stage (or everything).
        eachStage: payload.system === "children-done",
      }
      const after = childrenBarrier(children, options)
      const before = childrenBarrier(
        children.map((child) => childBefore(child, data)),
        options
      )
      return barrierAdvanced(before, after) ? { holds: true, barrier: after } : { holds: false }
    }
    case "issue-finished": {
      if (data.kind !== "status_changed" || !isTerminalIssueStatus(data.to)) return { holds: false }
      const target = await getIssue(condition.issueId)
      return { holds: Boolean(target && isTerminalIssueStatus(target.status)) }
    }
    case "pr-merged": {
      if (data.kind !== "pr_state_changed" || data.prTo !== "merged") return { holds: false }
      const issue = await getIssue(payload.issueId)
      return { holds: Boolean(issue && hasMergedPullRequest(issue)) }
    }
  }
}

export function createIssueWakeupFireGate(deps: IssueWakeupGateDeps = defaultDeps) {
  return async function issueWakeupFireGate(
    task: ScheduledTask,
    event: EventFireInput
  ): Promise<EventFireVerdict> {
    const payload = readWakeupPayload(task.payload)
    if (!payload) return { fire: false, reason: "not-a-wakeup" }
    const data = readActivityData(event.data)
    if (!data) return { fire: false, reason: "not-issue-activity" }

    const activeRuns = await listIssueRuns({ issueId: payload.issueId, activeOnly: true })

    // What held these inputs back is over: the run settled (whatever this
    // settle event is and whoever's run it was), or the issue left triage.
    if (
      payload.deferred?.length &&
      data.subjectId === payload.issueId &&
      (RUN_SETTLE_KINDS.has(data.kind) || isTriageAccepted(data)) &&
      activeRuns.length === 0
    ) {
      return { fire: true, payload: { [WAKEUP_RELEASE_FLAG]: true } }
    }

    if (data.originTaskId === task.id) return { fire: false, reason: "own-run" }
    if (!matchesWakeup(payload.match, data)) return { fire: false, reason: "no-match" }
    const condition = await conditionHolds(payload, data)
    if (!condition.holds) return { fire: false, reason: "condition-unmet" }
    const barrier = condition.barrier ? { [WAKEUP_BARRIER_KEY]: condition.barrier } : undefined

    const active = activeRuns[0]
    if (active && (await issueRunSessionIds(active)).length === 0) {
      const evidence = evidenceFromActivity(data)
      // The barrier is not re-derived at release, so the held input says it.
      if (condition.barrier) {
        evidence.summary = `${evidence.summary} — ${describeBarrier(condition.barrier)}`
      }
      await deps.hold(task.id, (held) => appendDeferred(held, evidence))
      return { fire: false, reason: "held-for-active-run" }
    }
    return barrier ? { fire: true, payload: barrier } : { fire: true }
  }
}
