/**
 * The `issue-wakeup` executor: one fire becomes one delivery.
 *
 * The fire gate (`gate.ts`) already decided the input is for this rule. The
 * executor re-reads everything fresh — the rule, the issue, the runs — since
 * a fire can wait in the scheduler's queue, and then:
 *
 *   1. Stops the rule when it must: the issue is gone (the rule is deleted),
 *      finished (`issue-closed`), the fire continues a chain that already
 *      visited this rule {@link ISSUE_WAKEUP_MAX_CHAIN_VISITS} times with no
 *      person in between (`loop`; system rules are exempt, since a stage
 *      hand-off crosses issues by design), or an event rule already fired
 *      {@link ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR} times this hour (`rate`).
 *   2. Delivers by what the issue looks like right now:
 *        active run   → the brief is steered into it (`joined`); when the run
 *                       cannot take it, the inputs are held until it settles;
 *        agent/squad  → a new run through `startIssueRun`, refuse-or-dispatch
 *                       like every other door, carrying the chain onward; an
 *                       issue in triage refuses a derived run, so the inputs
 *                       are held until someone accepts it;
 *        a person     → a `wakeup_fired` trail entry the notification funnel
 *                       turns into a directed notification;
 *        nobody       → the trail entry is the whole delivery.
 *   3. Consumes a one-shot rule once something was delivered.
 */

import type { ScheduledTask, TaskExecution, TaskExecutorResult } from "@/types/scheduler"
import type {
  Issue,
  IssueRun,
  IssueWakeupDelivery,
  IssueWakeupEvidence,
  IssueWakeupPauseReason,
  IssueWakeupPayload,
} from "@/types/issues"
import {
  ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS,
  ISSUE_WAKEUP_TASK_TYPE,
  ISSUE_WAKEUP_MAX_CHAIN_VISITS,
} from "@/types/issues"
import { getIssue } from "@/lib/db/issues"
import { getIssueProject } from "@/lib/db/issue-projects"
import type { IssueRunRefusalReason } from "@/lib/issues/run/types"
import { appendIssueEvent } from "@/lib/db/issue-events"
import { listIssueRuns } from "@/lib/db/issue-runs"
import {
  IssueRunRefusedError,
  listIssueRunOptions,
  startIssueRun,
  steerIssueRun,
} from "@/lib/issues/run/registry"
import {
  ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR,
  buildWakeupBrief,
  chainOfInputs,
  effectiveWakeupInstruction,
  evidenceFromActivity,
  isOverWakeupRate,
  isPeriodicWakeup,
  isTerminalIssueStatus,
  isWakeupLoop,
  readActivityData,
  readBarrier,
  readWakeupPayload,
} from "./model"
import {
  SYSTEM_WAKEUP_ACTOR,
  consumeIssueWakeup,
  pauseIssueWakeupFor,
  setIssueWakeupDeferred,
} from "./service"
import { WAKEUP_BARRIER_KEY, WAKEUP_RELEASE_FLAG, createIssueWakeupFireGate } from "./gate"
import {
  getTaskScheduler,
  registerEventFireGate,
  registerTaskExecutor,
} from "@/lib/scheduler/task-scheduler"

export interface IssueWakeupExecutorDeps {
  now: () => number
  loadTask: (taskId: string) => Promise<ScheduledTask | null>
  /** Start times of this task's earlier EVENT fires, newest first. */
  priorEventFires: (taskId: string, excludeExecutionId: string) => Promise<Date[]>
  deleteTask: (taskId: string) => Promise<void>
  pause: (taskId: string, reason: IssueWakeupPauseReason) => Promise<void>
  consume: (taskId: string) => Promise<void>
  setDeferred: (taskId: string, deferred: readonly IssueWakeupEvidence[]) => Promise<void>
  steer: typeof steerIssueRun
  startRun: typeof startIssueRun
  listRunOptions: typeof listIssueRunOptions
}

async function schedulerTable() {
  const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
  return schedulerDb
}

const defaultDeps: IssueWakeupExecutorDeps = {
  now: Date.now,
  loadTask: async (taskId) => (await schedulerTable()).getTask(taskId),
  priorEventFires: async (taskId, excludeExecutionId) => {
    const rows = await (
      await schedulerTable()
    ).getTaskExecutions(taskId, ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR + 2)
    return rows
      .filter(
        (row) =>
          row.id !== excludeExecutionId && row.triggerSource === "event" && row.status !== "skipped"
      )
      .map((row) => row.startedAt)
  },
  deleteTask: async (taskId) => {
    await getTaskScheduler().deleteTask(taskId)
  },
  pause: (taskId, reason) => pauseIssueWakeupFor(taskId, reason),
  consume: consumeIssueWakeup,
  setDeferred: setIssueWakeupDeferred,
  steer: steerIssueRun,
  startRun: startIssueRun,
  listRunOptions: listIssueRunOptions,
}

/**
 * Refusals that mean "not yet" rather than "never": the input is held on the
 * rule and released by the gate when the run settles or triage is accepted.
 */
const HELD_REFUSALS: ReadonlySet<IssueRunRefusalReason> = new Set(["run-active", "issue-in-triage"])

function paused(reason: IssueWakeupPauseReason, error: string): TaskExecutorResult {
  return {
    success: false,
    error,
    terminalReason: ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS[reason],
    output: { outcome: "paused", reason },
  }
}

/** Identifiers for the subjects an input names, so the brief can say "on MERC-7". */
async function identifiersFor(
  issue: Issue,
  inputs: readonly IssueWakeupEvidence[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>([[issue.id, issue.identifier]])
  for (const input of inputs) {
    if (map.has(input.subjectId)) continue
    const subject = await getIssue(input.subjectId)
    if (subject) map.set(subject.id, subject.identifier)
  }
  return map
}

async function recordFired(
  issue: Issue,
  task: ScheduledTask,
  instruction: string,
  delivery: IssueWakeupDelivery,
  inputs: number,
  runId?: string
): Promise<void> {
  await appendIssueEvent({
    issueId: issue.id,
    payload: {
      kind: "wakeup_fired",
      taskId: task.id,
      delivery,
      ...(runId ? { runId } : {}),
      instruction,
      inputs,
    },
  })
}

export function createIssueWakeupExecutor(overrides: Partial<IssueWakeupExecutorDeps> = {}) {
  const deps: IssueWakeupExecutorDeps = { ...defaultDeps, ...overrides }

  return async function executeIssueWakeupTask(
    task: ScheduledTask,
    execution: TaskExecution,
    _signal: AbortSignal
  ): Promise<TaskExecutorResult> {
    const payload = readWakeupPayload(task.payload)
    if (!payload) {
      return {
        success: false,
        error: "This task's payload is not an issue wakeup (it needs issueId and instruction).",
        terminalReason: "wakeup-refused",
      }
    }
    const envelope = (task.payload as Record<string, unknown>).event as
      { data?: unknown } | undefined
    const release = (task.payload as Record<string, unknown>)[WAKEUP_RELEASE_FLAG] === true
    const barrier = readBarrier((task.payload as Record<string, unknown>)[WAKEUP_BARRIER_KEY])
    const eventData = readActivityData(envelope?.data)
    // Held inputs are read from the row, not from the snapshot the fire was
    // queued with: more may have been held while this fire waited.
    const latest = await deps.loadTask(task.id)
    const held = readWakeupPayload(latest?.payload)?.deferred ?? []
    const inputs: IssueWakeupEvidence[] = [
      ...held,
      ...(eventData && !release ? [evidenceFromActivity(eventData)] : []),
    ]

    const issue = await getIssue(payload.issueId)
    if (!issue) {
      await deps.deleteTask(task.id)
      return paused(
        "issue-closed",
        `Issue ${payload.issueId} no longer exists; the wakeup was removed.`
      )
    }
    if (isTerminalIssueStatus(issue.status)) {
      await deps.pause(task.id, "issue-closed")
      return paused("issue-closed", `${issue.identifier} is ${issue.status}; its wakeups stopped.`)
    }

    const chain = chainOfInputs(inputs)
    if (!payload.system && isWakeupLoop(chain, task.id)) {
      await deps.pause(task.id, "loop")
      return paused(
        "loop",
        `This wakeup was reached ${ISSUE_WAKEUP_MAX_CHAIN_VISITS} times on one chain of agent runs with no person in between (${chain.join(" → ")}).`
      )
    }
    if (task.trigger.type === "event" && !release) {
      const prior = await deps.priorEventFires(task.id, execution.id)
      if (isOverWakeupRate(prior, deps.now())) {
        await deps.pause(task.id, "rate")
        return paused(
          "rate",
          `This wakeup already fired ${ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR} times in the last hour.`
        )
      }
    }

    const periodic = isPeriodicWakeup(task)
    const identifiersById = await identifiersFor(issue, inputs)
    // Resolved now, not when the rule was written: a container default a
    // person changed since reaches every parent's next hand-off.
    const instruction = effectiveWakeupInstruction(
      payload,
      payload.system ? await getIssueProject(issue.issueProjectId) : undefined
    )
    const brief = (joined: boolean) =>
      buildWakeupBrief({
        taskId: task.id,
        instruction,
        identifier: issue.identifier,
        inputs,
        joined,
        periodic,
        identifiersById,
        ...(barrier ? { barrier } : {}),
      })
    const delivered = async (
      delivery: IssueWakeupDelivery,
      runId?: string,
      extra: Record<string, unknown> = {}
    ): Promise<TaskExecutorResult> => {
      await recordFired(issue, task, instruction, delivery, inputs.length, runId)
      if (held.length > 0) await deps.setDeferred(task.id, [])
      if (payload.once) await deps.consume(task.id)
      return {
        success: true,
        output: { outcome: delivery, inputs: inputs.length, ...(runId ? { runId } : {}), ...extra },
      }
    }
    const hold = async (why: string, run?: IssueRun): Promise<TaskExecutorResult> => {
      await deps.setDeferred(task.id, inputs)
      return {
        success: true,
        terminalReason: "wakeup-deferred",
        output: {
          outcome: "deferred",
          why,
          inputs: inputs.length,
          ...(run ? { runId: run.id } : {}),
        },
      }
    }

    const active = (await listIssueRuns({ issueId: issue.id, activeOnly: true }))[0]
    if (active) {
      if (await deps.steer(active, brief(true))) return delivered("joined", active.id)
      return hold("active-run-not-steerable", active)
    }

    const assignee = issue.assignee
    if (!assignee) return delivered("trail")
    if (assignee.kind === "human") return delivered("notified")

    let adapterId = payload.adapterId
    if (!adapterId) {
      const options = await deps.listRunOptions(issue.id, undefined, "wakeup")
      const accepting = options.find((option) => option.verdict.ok)
      if (!accepting) {
        const reasons = options.map((option) =>
          option.verdict.ok ? option.adapter.id : `${option.adapter.id}: ${option.verdict.reason}`
        )
        const waiting = options.find(
          (option) => !option.verdict.ok && HELD_REFUSALS.has(option.verdict.reason)
        )
        if (waiting && !waiting.verdict.ok) return hold(waiting.verdict.reason)
        return {
          success: false,
          error: `No run engine accepts ${issue.identifier} (${reasons.join("; ") || "none registered"}).`,
          terminalReason: "wakeup-refused",
          output: { outcome: "refused", reasons },
        }
      }
      adapterId = accepting.adapter.id
    }

    try {
      const run = await deps.startRun({
        issueId: issue.id,
        adapterId,
        by: payload.author ?? SYSTEM_WAKEUP_ACTOR,
        origin: "wakeup",
        brief: brief(false),
        wakeup: {
          taskId: task.id,
          chain: [...chain, task.id],
          statusBefore: issue.status,
          periodic,
        },
      })
      return delivered("run", run.id, { adapterId })
    } catch (error) {
      if (error instanceof IssueRunRefusedError) {
        // Another door started a run between our read and the dispatch, or
        // the issue went into triage: either way the input waits.
        if (HELD_REFUSALS.has(error.reason)) return hold(error.reason)
        return {
          success: false,
          error: `${issue.identifier} was refused by ${adapterId}: ${error.reason}${error.detail ? ` (${error.detail})` : ""}`,
          terminalReason: "wakeup-refused",
          output: { outcome: "refused", reason: error.reason, detail: error.detail ?? null },
        }
      }
      throw error
    }
  }
}

let registered = false

/**
 * Register the executor and the fire gate. Idempotent and synchronous, so the
 * scheduler's owner loader (`executor-owners.ts`) finds both the moment it
 * returns. The issue tracker boot reaches this through a dynamic import, which
 * keeps the scheduler graph out of the tracker's own import cost.
 */
export function registerIssueWakeupExecutor(): void {
  if (registered) return
  registered = true
  registerTaskExecutor(ISSUE_WAKEUP_TASK_TYPE, createIssueWakeupExecutor())
  registerEventFireGate(ISSUE_WAKEUP_TASK_TYPE, createIssueWakeupFireGate())
}

/** Test-only. */
export function resetIssueWakeupExecutorRegistration(): void {
  registered = false
}
