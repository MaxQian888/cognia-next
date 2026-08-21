/**
 * Delegation runs — the durable carrier for "go do this and report back".
 *
 * A `delegation` run is deliberately NOT a synonym for the engine kinds beside
 * it. `agent-turn`, `team`, `workflow` name whatever is executing right now;
 * a delegation names the COMMITMENT, which outlives any single attempt. That
 * distinction is what makes the rest of the model work:
 *
 *  - one card per delegation, not one per engine run. Children point at the
 *    delegation through `parentRunId` (indexed at v176) and their progress is
 *    re-projected onto the parent by `delegation-bridge.ts`;
 *  - a failed attempt does not close the delegation, so `retry` can mint a new
 *    child instead of trying to append to a settled journal — the invariant
 *    `appendInsideTransaction` enforces, and rightly;
 *  - handing the work to a human parks the delegation on an interrupt rather
 *    than terminating it, so the thread the person answers in is still the
 *    thread the work reports to.
 *
 * Three weights, and only the first is automatic:
 *
 *   T0  one-shot        the turn answers inline — no delegation row at all.
 *   T1  delegation      this module: run + binding + milestones + control.
 *   T2  tracked         `promoteDelegationToIssue` — an explicit step, because
 *                       minting an Issue for every delegation would burn the
 *                       permanent `issueCounters` numbering and flood a board
 *                       that people use to plan.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import {
  adoptExecutionRun,
  createExecutionRun,
  getExecutionRun,
  listChildExecutionRuns,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import type { ExecutionRun, ExecutionRunInitiator } from "@/types/execution/run"

import { ensureConnectorRunBinding } from "./agent-state-bridge"

/** Stable id so a repeated accept is a no-op rather than a second card. */
export function delegationExecutionRunId(delegationId: string): string {
  return `execution:delegation:${delegationId}`
}

export interface DelegationMilestoneSeed {
  id: string
  title: string
}

export interface AcceptDelegationInput {
  /** Caller-owned identity for this delegation (the inbound message id will do). */
  delegationId: string
  title: string
  projectId?: string
  sessionId?: string
  initiator?: ExecutionRunInitiator
  /**
   * The plan skeleton, if the caller already has one.
   *
   * Optional on purpose: the acceptance has to be durable BEFORE planning, or
   * a crash between "we took this on" and "here is the plan" loses the
   * commitment. An empty skeleton still opens the card; `reviseDelegationPlan`
   * fills it in when the planner returns.
   */
  milestones?: readonly DelegationMilestoneSeed[]
  /** Binds the delegation to the IM conversation that asked for it. */
  session?: ChatSession
  now?: number
}

export interface AcceptDelegationResult {
  runId: string
  /** False when an equal accept already landed — the caller must not re-plan. */
  created: boolean
}

function milestonePayload(
  milestones: readonly DelegationMilestoneSeed[]
): Array<Record<string, unknown>> {
  return milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    // Provenance marker the reducer requires before it will show a title. The
    // text still goes through `sanitizeActivityLabel` (redaction + command /
    // URL stripping), so this asserts intent, not trust.
    safeTitle: true,
    status: "pending",
  }))
}

/**
 * Take on a delegation: mint the run, bind it to the conversation, and open
 * the card in the same tick.
 *
 * The card opening is not cosmetic. `run-presentation/runner.ts` gates on
 * `snapshot.revision > binding.lastProjectedRevision`, and `createExecutionRun`
 * emits no event — so a run created and then left to plan quietly is invisible
 * for as long as planning takes, which is exactly the window in which a person
 * wonders whether their request was heard. `run.started` (plus `plan.created`
 * when a skeleton exists) takes the revision past zero immediately.
 */
export async function acceptDelegation(
  input: AcceptDelegationInput
): Promise<AcceptDelegationResult> {
  const runId = delegationExecutionRunId(input.delegationId)
  const now = input.now ?? Date.now()
  const existing = await getExecutionRun(runId)
  if (existing) {
    if (input.session) await ensureConnectorRunBinding(runId, input.projectId, input.session)
    return { runId, created: false }
  }

  try {
    await createExecutionRun({
      id: runId,
      kind: "delegation",
      sourceId: input.delegationId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.initiator ? { initiator: input.initiator } : {}),
      title: input.title,
      status: "running",
      currentRevision: 0,
      startedAt: now,
      updatedAt: now,
    })
  } catch (error) {
    // Two accepts raced. The loser binds and reports `created: false` rather
    // than throwing: both callers hold the same commitment, and only one of
    // them may plan.
    if (!(error instanceof Error && error.name === "ConstraintError")) throw error
    if (input.session) await ensureConnectorRunBinding(runId, input.projectId, input.session)
    return { runId, created: false }
  }

  // Bind BEFORE journalling. The runner wakes on the event and projects onto
  // bindings it can already see; the other order races the first projection.
  if (input.session) await ensureConnectorRunBinding(runId, input.projectId, input.session)

  await runEventJournal.append(
    runId,
    semanticRunEvent(
      "run.started",
      {},
      { ts: now, sourceEventId: `delegation:${input.delegationId}:started` }
    )
  )
  const milestones = input.milestones ?? []
  if (milestones.length > 0) {
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        "plan.created",
        { version: 1, steps: milestonePayload(milestones) },
        { ts: now, sourceEventId: `delegation:${input.delegationId}:plan:1` }
      )
    )
  }
  return { runId, created: true }
}

/**
 * Replace the milestone list — the planner's first plan, or a re-plan.
 *
 * `plan.revised` rather than a pile of `step.added`, because the reducer
 * treats a revision as authoritative: steps absent from it are dropped. A
 * re-plan that only ADDED would leave abandoned milestones on the card forever.
 */
export async function reviseDelegationPlan(input: {
  runId: string
  version: number
  milestones: readonly DelegationMilestoneSeed[]
  now?: number
}): Promise<void> {
  const now = input.now ?? Date.now()
  await runEventJournal.append(
    input.runId,
    semanticRunEvent(
      input.version <= 1 ? "plan.created" : "plan.revised",
      { version: input.version, steps: milestonePayload(input.milestones) },
      { ts: now, sourceEventId: `delegation:${input.runId}:plan:${input.version}` }
    )
  )
}

/**
 * Point an already-running engine run at the delegation that now owns it.
 *
 * Adoption exists because promotion is a decision made from evidence the
 * accept could not have had. A turn starts inline; only when the planner emits
 * more than one milestone (or the turn outlives the inline budget) is there a
 * reason to spend a card on it. Pre-emptively minting a delegation for every
 * turn would put the cost on the common case to serve the rare one.
 */
export async function adoptIntoDelegation(
  childRunId: string,
  delegationRunId: string
): Promise<boolean> {
  return adoptExecutionRun(childRunId, delegationRunId)
}

/** Engine runs carrying out this delegation, newest first. */
export async function listDelegationChildren(delegationRunId: string): Promise<ExecutionRun[]> {
  return listChildExecutionRuns(delegationRunId)
}

const ACTIVE_CHILD_STATUSES = ["queued", "running", "waiting", "paused"] as const

/** True while any child is still capable of making progress. */
export async function hasActiveDelegationChild(delegationRunId: string): Promise<boolean> {
  const children = await listChildExecutionRuns(delegationRunId, {
    statuses: ACTIVE_CHILD_STATUSES,
  })
  return children.length > 0
}

/**
 * Close the delegation.
 *
 * Separate from the children's own settlement on purpose: a delegation whose
 * only attempt failed is still open (that is what makes retry meaningful), and
 * a delegation parked on a human is not finished either. Only the caller that
 * owns the commitment decides it is over.
 */
export async function settleDelegation(input: {
  runId: string
  status: "completed" | "failed" | "cancelled"
  summary?: string
  now?: number
}): Promise<void> {
  const run = await getExecutionRun(input.runId)
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return
  const now = input.now ?? Date.now()
  await runEventJournal.append(
    input.runId,
    semanticRunEvent(
      `run.${input.status}`,
      {
        ...(input.summary ? { summary: input.summary, safeSummary: true } : {}),
      },
      { ts: now, sourceEventId: `delegation:${run.sourceId}:terminal:${input.status}` }
    )
  )
}
