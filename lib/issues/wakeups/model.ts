/**
 * Issue wakeups — the pure half (types in `types/issues/wakeup.ts`).
 *
 * Everything here is a function of its arguments: compiling an authoring spec
 * into a scheduler task, reading one back, matching an event, attributing an
 * event to the run that caused it, and rendering the brief a woken agent
 * reads. The Dexie- and scheduler-facing halves (`gate.ts`, `executor.ts`,
 * `bridge.ts`, `service.ts`) stay thin by leaning on these.
 */

import type {
  IssueActor,
  IssueActorKind,
  IssueActivityEventData,
  IssueChildrenBarrier,
  IssueEvent,
  IssueEventPayload,
  IssuePullRequestCheckResult,
  IssueRun,
  IssueStatus,
  IssueWakeupCondition,
  IssueWakeupEventKind,
  IssueWakeupEvidence,
  IssueWakeupMatch,
  IssueWakeupPauseReason,
  IssueWakeupPayload,
  IssueSystemWakeupKind,
} from "@/types/issues"
import {
  ISSUE_ACTIVITY_EVENT,
  ISSUE_STAGE_MAX,
  isIssueStage,
  wakeupPauseReasonOf,
  ISSUE_WAKEUP_MAX_CHAIN_VISITS,
  ISSUE_WAKEUP_MAX_DEFERRED,
  ISSUE_WAKEUP_INSTRUCTION_MAX,
  isActiveIssueRunStatus,
  issueWakeupEventSource,
} from "@/types/issues"
import type { ScheduledTask, TaskExecutionConfig, TaskTrigger } from "@/types/scheduler"

/** Fire budget when the author names none (`TaskExecutionConfig.maxRuns`). */
export const ISSUE_WAKEUP_DEFAULT_MAX_FIRES = 20
export const ISSUE_WAKEUP_MAX_FIRES_LIMIT = 1000

/** An event rule that started this many fires within an hour pauses as `rate`. */
export const ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR = 12
export const ISSUE_WAKEUP_RATE_WINDOW_MS = 60 * 60_000

/** Bounds on what a woken agent is handed. */
export const ISSUE_WAKEUP_SUMMARY_MAX = 280
export const ISSUE_WAKEUP_BRIEF_MAX_INPUTS = 10
// The instruction bound lives with the types so the container field can share it.
export { ISSUE_WAKEUP_INSTRUCTION_MAX }

/** The derived kinds a children-done rule listens to: a child finishing, or moving stage. */
export const CHILDREN_DONE_KINDS = ["child_status_changed", "child_stage_changed"] as const

/** Statuses whose category is terminal. Kept beside the other issue projections. */
const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set(["done", "canceled"])

export function isTerminalIssueStatus(status: IssueStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status)
}

/** How an author says when a wakeup fires. One shape per trigger family. */
export type IssueWakeupTriggerSpec =
  | {
      on: "event"
      kinds?: IssueWakeupEventKind[]
      actorKinds?: IssueActorKind[]
      toStatuses?: IssueStatus[]
    }
  /** `stage`: only staged sub-issues of that stage or lower count. */
  | { on: "children-done"; stage?: number }
  | { on: "issue-finished"; targetIssueId: string }
  /** A linked pull request merges. Needs an import-mode GitHub binding. */
  | { on: "pr-merged" }
  /**
   * An open linked pull request's CI settles: to `result`, or to either
   * passing or failing. Same binding requirement as `pr-merged`.
   */
  | { on: "pr-checks"; result?: IssuePullRequestCheckResult }
  | { on: "cron"; cronExpression: string; timezone?: string }
  | { on: "interval"; intervalMs: number }
  | { on: "at"; runAt: Date }

export interface IssueWakeupSpec {
  issueId: string
  instruction: string
  trigger: IssueWakeupTriggerSpec
  adapterId?: string
  /**
   * Consumed by its first delivery. Defaults to true for the condition
   * triggers (they describe one moment) and false for event rules; `at` is a
   * single timer whatever this says.
   */
  once?: boolean
  /** 1–1000; defaults to {@link ISSUE_WAKEUP_DEFAULT_MAX_FIRES}. */
  maxFires?: number
  /** The rule expires at this instant (`ScheduledTask.endAt`). */
  expiresAt?: Date
  /** At {@link expiresAt}: wake the issue once more, or just stop (default). */
  onTimeout?: "wake" | "drop"
  author?: IssueActor
  system?: IssueSystemWakeupKind
}

export interface CompiledIssueWakeup {
  trigger: TaskTrigger
  payload: IssueWakeupPayload
  config: Partial<TaskExecutionConfig>
  endAt?: Date
}

/**
 * Spec → the three parts of a `ScheduledTask`. Throws on a spec the executor
 * could never honour, so a bad rule is refused when it is written rather than
 * discovered when it fires.
 */
/** Trimmed, and refused when empty or over {@link ISSUE_WAKEUP_INSTRUCTION_MAX}. */
export function normalizeWakeupInstruction(text: string): string {
  const instruction = text.trim()
  if (!instruction) throw new Error("A wakeup needs an instruction for the agent it wakes.")
  if (instruction.length > ISSUE_WAKEUP_INSTRUCTION_MAX) {
    throw new Error(
      `A wakeup instruction is limited to ${ISSUE_WAKEUP_INSTRUCTION_MAX} characters.`
    )
  }
  return instruction
}

/**
 * What a fire asks the agent to do. An author's rule says it itself; the
 * platform children-done rule falls back from the parent's own override to
 * its container's default to the built-in text on the rule.
 */
export function effectiveWakeupInstruction(
  payload: Pick<IssueWakeupPayload, "instruction" | "instructionOverride" | "system">,
  container?: { childrenDoneInstruction?: string }
): string {
  if (payload.system !== "children-done") return payload.instruction
  return (
    payload.instructionOverride?.trim() ||
    container?.childrenDoneInstruction?.trim() ||
    payload.instruction
  )
}

export function compileIssueWakeup(spec: IssueWakeupSpec): CompiledIssueWakeup {
  if (!spec.issueId) throw new Error("A wakeup needs the issue it belongs to.")
  const instruction = normalizeWakeupInstruction(spec.instruction)
  const maxFires = spec.maxFires ?? ISSUE_WAKEUP_DEFAULT_MAX_FIRES
  if (!Number.isInteger(maxFires) || maxFires < 1 || maxFires > ISSUE_WAKEUP_MAX_FIRES_LIMIT) {
    throw new Error(`maxFires must be an integer from 1 to ${ISSUE_WAKEUP_MAX_FIRES_LIMIT}.`)
  }

  if (spec.onTimeout === "wake" && !spec.expiresAt) {
    throw new Error("A wakeup can only wake on timeout when it has a deadline (expiresAt).")
  }

  const ownSource = issueWakeupEventSource(spec.issueId)
  const base: IssueWakeupPayload = {
    issueId: spec.issueId,
    instruction,
    ...(spec.onTimeout === "wake" ? { onTimeout: "wake" as const } : {}),
    ...(spec.adapterId ? { adapterId: spec.adapterId } : {}),
    ...(spec.author ? { author: spec.author } : {}),
    ...(spec.system ? { system: spec.system } : {}),
  }
  let trigger: TaskTrigger
  let payload: IssueWakeupPayload
  const t = spec.trigger
  switch (t.on) {
    case "event": {
      const match: IssueWakeupMatch = {
        ...(t.kinds?.length ? { kinds: [...t.kinds] } : {}),
        ...(t.actorKinds?.length ? { actorKinds: [...t.actorKinds] } : {}),
        ...(t.toStatuses?.length ? { toStatuses: [...t.toStatuses] } : {}),
      }
      trigger = { type: "event", eventType: ISSUE_ACTIVITY_EVENT, eventSource: ownSource }
      payload = {
        ...base,
        ...(Object.keys(match).length ? { match } : {}),
        ...(spec.once ? { once: true } : {}),
      }
      break
    }
    case "children-done":
      if (t.stage !== undefined && !isIssueStage(t.stage)) {
        throw new Error(`A sub-issue stage is an integer from 1 to ${ISSUE_STAGE_MAX}.`)
      }
      trigger = { type: "event", eventType: ISSUE_ACTIVITY_EVENT, eventSource: ownSource }
      payload = {
        ...base,
        match: { kinds: [...CHILDREN_DONE_KINDS] },
        condition: {
          kind: "children-done",
          ...(t.stage !== undefined ? { stage: t.stage } : {}),
        },
        ...((spec.once ?? true) ? { once: true } : {}),
      }
      break
    case "issue-finished":
      if (!t.targetIssueId) throw new Error("An issue-finished wakeup needs the issue to watch.")
      if (t.targetIssueId === spec.issueId) {
        throw new Error("An issue-finished wakeup cannot watch its own issue; it would never run.")
      }
      trigger = {
        type: "event",
        eventType: ISSUE_ACTIVITY_EVENT,
        eventSource: issueWakeupEventSource(t.targetIssueId),
      }
      payload = {
        ...base,
        match: { kinds: ["status_changed"] },
        condition: { kind: "issue-finished", issueId: t.targetIssueId },
        ...((spec.once ?? true) ? { once: true } : {}),
      }
      break
    case "pr-merged":
      trigger = { type: "event", eventType: ISSUE_ACTIVITY_EVENT, eventSource: ownSource }
      payload = {
        ...base,
        match: { kinds: ["pr_state_changed"] },
        condition: { kind: "pr-merged" },
        ...((spec.once ?? true) ? { once: true } : {}),
      }
      break
    case "pr-checks":
      trigger = { type: "event", eventType: ISSUE_ACTIVITY_EVENT, eventSource: ownSource }
      payload = {
        ...base,
        match: { kinds: ["pr_checks_changed"] },
        condition: { kind: "pr-checks", ...(t.result ? { result: t.result } : {}) },
        ...((spec.once ?? true) ? { once: true } : {}),
      }
      break
    case "cron":
      trigger = {
        type: "cron",
        cronExpression: t.cronExpression,
        ...(t.timezone ? { timezone: t.timezone } : {}),
      }
      payload = base
      break
    case "interval":
      trigger = { type: "interval", intervalMs: t.intervalMs }
      payload = base
      break
    case "at":
      trigger = { type: "once", runAt: t.runAt }
      payload = { ...base, once: true }
      break
  }

  return {
    trigger,
    payload,
    config: {
      maxRuns: maxFires,
      // A fire only decides and dispatches; the run it starts is tracked on
      // the issue, not inside this execution. A retry would dispatch twice.
      maxRetries: 0,
      timeout: 60_000,
      // Two inputs landing together must both be delivered. Executions are
      // short, so buffering them costs nothing and loses nothing.
      overlapPolicy: "queue-all",
      maxQueueSize: ISSUE_WAKEUP_MAX_DEFERRED,
      // A rule whose engine keeps refusing the issue is noise, not news.
      pauseAfterConsecutiveFailures: 5,
    },
    ...(spec.expiresAt ? { endAt: spec.expiresAt } : {}),
  }
}

/** Read a task's payload as a wakeup payload, or `undefined` when it is not one. */
export function readWakeupPayload(payload: unknown): IssueWakeupPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.issueId !== "string" || !record.issueId) return undefined
  if (typeof record.instruction !== "string") return undefined
  return record as IssueWakeupPayload
}

/** Read an `issue:activity` event's data, or `undefined` for anything else. */
export function readActivityData(data: unknown): IssueActivityEventData | undefined {
  if (!data || typeof data !== "object") return undefined
  const record = data as Record<string, unknown>
  if (typeof record.issueId !== "string" || typeof record.kind !== "string") return undefined
  return {
    ...(record as IssueActivityEventData),
    chain: Array.isArray(record.chain) ? (record.chain as unknown[]).map(String) : [],
    subjectId: typeof record.subjectId === "string" ? record.subjectId : record.issueId,
    summary: typeof record.summary === "string" ? record.summary : String(record.kind),
  }
}

/** The authoring spec a task was compiled from. Inverse of {@link compileIssueWakeup}. */
export function decompileWakeupTrigger(task: Pick<ScheduledTask, "trigger" | "payload">) {
  const payload = readWakeupPayload(task.payload)
  const trigger = task.trigger
  if (trigger.type === "cron") {
    return {
      on: "cron",
      cronExpression: trigger.cronExpression ?? "",
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    } satisfies IssueWakeupTriggerSpec
  }
  if (trigger.type === "interval") {
    return { on: "interval", intervalMs: trigger.intervalMs ?? 0 } satisfies IssueWakeupTriggerSpec
  }
  if (trigger.type === "once") {
    return {
      on: "at",
      runAt: trigger.runAt ? new Date(trigger.runAt) : new Date(0),
    } satisfies IssueWakeupTriggerSpec
  }
  const condition = payload?.condition
  if (condition?.kind === "children-done") {
    return {
      on: "children-done",
      ...(condition.stage !== undefined ? { stage: condition.stage } : {}),
    } as const
  }
  if (condition?.kind === "issue-finished") {
    return { on: "issue-finished", targetIssueId: condition.issueId } as const
  }
  if (condition?.kind === "pr-merged") return { on: "pr-merged" } as const
  if (condition?.kind === "pr-checks") {
    return {
      on: "pr-checks",
      ...(condition.result ? { result: condition.result } : {}),
    } as const
  }
  return {
    on: "event",
    ...(payload?.match?.kinds ? { kinds: payload.match.kinds } : {}),
    ...(payload?.match?.actorKinds ? { actorKinds: payload.match.actorKinds } : {}),
    ...(payload?.match?.toStatuses ? { toStatuses: payload.match.toStatuses } : {}),
  } satisfies IssueWakeupTriggerSpec
}

/** A sub-issue as the barrier sees it. */
export type BarrierChild = { id: string; status: IssueStatus; stage?: number }

/**
 * How far a parent's sub-issues got (`IssueChildrenBarrier`), or `undefined`
 * when the barrier is not reached.
 *
 *   `stage` given   the author's stage N: every staged child of stage N or
 *                   lower is finished and stage N has at least one child.
 *                   Unstaged children and later stages do not count.
 *   `eachStage`     the platform rule: `all` when every child is finished,
 *                   else the highest stage N such that N and every earlier
 *                   stage are finished while a later stage still has open
 *                   children. Once the staged children are all finished the
 *                   wrap-up waits for the unstaged ones: the last stage
 *                   closing alone is not a hand-off to anybody.
 *   neither         `all` when every child is finished.
 */
export function childrenBarrier(
  children: readonly BarrierChild[],
  options: { stage?: number; eachStage?: boolean } = {}
): IssueChildrenBarrier | undefined {
  if (children.length === 0) return undefined
  const finished = (child: BarrierChild) => isTerminalIssueStatus(child.status)
  if (options.stage !== undefined) {
    const n = options.stage
    const counted = children.filter((child) => child.stage !== undefined && child.stage <= n)
    if (!counted.some((child) => child.stage === n)) return undefined
    return counted.every(finished) ? { kind: "stage", stage: n } : undefined
  }
  if (children.every(finished)) return { kind: "all" }
  if (!options.eachStage) return undefined
  const stages = [...new Set(children.flatMap((c) => (c.stage === undefined ? [] : [c.stage])))]
  stages.sort((a, b) => a - b)
  let reached: number | undefined
  for (const stage of stages) {
    if (!children.filter((child) => child.stage === stage).every(finished)) {
      // A later stage still waits; the frontier is the stage before it.
      return reached === undefined ? undefined : { kind: "stage", stage: reached }
    }
    reached = stage
  }
  return undefined
}

/** Read a barrier a fire gate merged over the payload, or `undefined`. */
export function readBarrier(value: unknown): IssueChildrenBarrier | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (record.kind === "all") return { kind: "all" }
  if (record.kind === "stage" && isIssueStage(record.stage)) {
    return { kind: "stage", stage: record.stage }
  }
  return undefined
}

function barrierRank(barrier: IssueChildrenBarrier | undefined): number {
  if (!barrier) return 0
  return barrier.kind === "all" ? Number.POSITIVE_INFINITY : barrier.stage
}

/**
 * Did one child's change move the barrier forward? `before` is the barrier
 * with that child as it was, `after` as it is. Only an advance fires: a change
 * among finished children, or one that moves the barrier back, wakes nobody,
 * and reopening then re-finishing a child advances it again.
 */
export function barrierAdvanced(
  before: IssueChildrenBarrier | undefined,
  after: IssueChildrenBarrier | undefined
): after is IssueChildrenBarrier {
  return after !== undefined && barrierRank(after) > barrierRank(before)
}

/** A cron/interval rule — the only kind whose run may check in. */
export function isPeriodicWakeup(task: Pick<ScheduledTask, "trigger">): boolean {
  return task.trigger.type === "cron" || task.trigger.type === "interval"
}

/** Does the event pass the rule's match? Absent fields match anything. */
export function matchesWakeup(
  match: IssueWakeupMatch | undefined,
  data: IssueActivityEventData
): boolean {
  if (!match) return true
  if (match.kinds?.length && !match.kinds.includes(data.kind)) return false
  if (match.actorKinds?.length && (!data.actor || !match.actorKinds.includes(data.actor.kind))) {
    return false
  }
  if (match.toStatuses?.length && (!data.to || !match.toStatuses.includes(data.to))) return false
  return true
}

/** How many times `taskId` already appears on a chain. */
export function chainVisits(chain: readonly string[], taskId: string): number {
  return chain.filter((id) => id === taskId).length
}

/** A fire whose incoming chain already visited this rule too often is a loop. */
export function isWakeupLoop(chain: readonly string[], taskId: string): boolean {
  return chainVisits(chain, taskId) >= ISSUE_WAKEUP_MAX_CHAIN_VISITS
}

/**
 * Did this event rule already use its hourly allowance? `priorFires` are the
 * start times of its earlier event fires, not counting the one asking.
 */
export function isOverWakeupRate(
  priorFires: readonly Date[],
  now: number,
  limit = ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR
): boolean {
  const since = now - ISSUE_WAKEUP_RATE_WINDOW_MS
  return priorFires.filter((at) => at.getTime() >= since).length >= limit
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function actorName(actor: IssueActor | undefined): string {
  if (!actor) return "system"
  return actor.label ?? actor.id ?? actor.kind
}

/**
 * One line per trail entry, for the agent (not the UI — the timeline renders
 * localized from the payload). English on purpose: it goes into a prompt.
 */
export function summarizeIssueEventPayload(payload: IssueEventPayload): string {
  switch (payload.kind) {
    case "status_changed":
      return `status ${payload.from} → ${payload.to}`
    case "commented":
      return `comment: ${truncate(payload.body, ISSUE_WAKEUP_SUMMARY_MAX)}`
    case "assigned":
      return `assigned to ${actorName(payload.to)}`
    case "unassigned":
      return `unassigned from ${actorName(payload.from)}`
    case "reassigned":
      return `reassigned from ${actorName(payload.from)} to ${actorName(payload.to)}`
    case "priority_changed":
      return `priority ${payload.from} → ${payload.to}`
    case "title_changed":
      return `title changed to "${truncate(payload.to, 120)}"`
    case "run_succeeded":
      return payload.summary
        ? `run succeeded: ${truncate(payload.summary, ISSUE_WAKEUP_SUMMARY_MAX)}`
        : "run succeeded"
    case "run_failed":
      return `run failed: ${truncate(payload.error, ISSUE_WAKEUP_SUMMARY_MAX)}`
    case "run_checked_in":
      return `run checked in: ${truncate(payload.note, ISSUE_WAKEUP_SUMMARY_MAX)}`
    case "artifact_linked":
      return `artifact linked: ${payload.label} (${payload.href})`
    case "deliverable_accepted":
      return `delivered version accepted: ${payload.label} (${payload.digest})`
    case "label_added":
      return `label added: ${payload.labelId}`
    case "label_removed":
      return `label removed: ${payload.labelId}`
    case "due_date_changed":
      return payload.to
        ? `due date set to ${new Date(payload.to).toISOString().slice(0, 10)}`
        : "due date cleared"
    case "blocker_added":
      return `now blocked by ${payload.blockerId}`
    case "blocker_removed":
      return `no longer blocked by ${payload.blockerId}`
    case "stage_changed":
      return payload.to !== undefined ? `moved to stage ${payload.to}` : "unstaged"
    case "triage_changed":
      return payload.to ? "put into triage" : "accepted out of triage"
    case "pr_state_changed":
      return `pull request ${payload.ref.label ?? payload.ref.externalId} is ${payload.to}${payload.ref.url ? ` (${payload.ref.url})` : ""}`
    case "pr_checks_changed":
      return `pull request ${payload.ref.label ?? payload.ref.externalId} checks are ${payload.to}${payload.ref.url ? ` (${payload.ref.url})` : ""}`
    default:
      return payload.kind.replace(/_/g, " ")
  }
}

/** The actor a trail entry names, when its kind records one. */
export function actorOfPayload(payload: IssueEventPayload): IssueActor | undefined {
  return "by" in payload && payload.by && typeof payload.by === "object"
    ? (payload.by as IssueActor)
    : undefined
}

/** The run a trail entry names directly (`run_*`, `artifact_linked`). */
export function runIdOfPayload(payload: IssueEventPayload): string | undefined {
  return "runId" in payload && typeof payload.runId === "string" ? payload.runId : undefined
}

/**
 * Which run caused this trail entry, if any.
 *
 *   1. The entry names its run (`run_*`, `artifact_linked`, `run_checked_in`).
 *   2. The actor is a runtime actor (`runtimeActorFor`: the engine's target
 *      id), which is how the bridge stamps the status moves it makes.
 *   3. An agent/team actor acting on the issue while a run for that assignee
 *      is active: the only thing on the issue that agent can be is the run.
 *
 * A human actor is never attributed: a person in between is what resets a
 * wakeup chain.
 */
export function attributeIssueEvent(
  event: Pick<IssueEvent, "payload">,
  runs: readonly IssueRun[],
  assignee: IssueActor | undefined
): IssueRun | undefined {
  const named = runIdOfPayload(event.payload)
  if (named) return runs.find((run) => run.id === named)
  const actor = actorOfPayload(event.payload)
  if (!actor || actor.kind === "human" || !actor.id) return undefined
  const byTarget = runs.filter((run) => run.targetId === actor.id)
  const activeByTarget = byTarget.find((run) => isActiveIssueRunStatus(run.status))
  if (activeByTarget ?? byTarget[0]) return activeByTarget ?? byTarget[0]
  if (assignee && assignee.kind === actor.kind && assignee.id === actor.id) {
    return runs.find((run) => isActiveIssueRunStatus(run.status))
  }
  return undefined
}

/** Activity data → one piece of evidence. */
export function evidenceFromActivity(data: IssueActivityEventData): IssueWakeupEvidence {
  return {
    kind: data.kind,
    subjectId: data.subjectId,
    ...(data.eventId ? { eventId: data.eventId } : {}),
    ts: data.ts,
    ...(data.actor ? { actor: data.actor } : {}),
    summary: truncate(data.summary, ISSUE_WAKEUP_SUMMARY_MAX),
    chain: [...data.chain],
  }
}

/** Append evidence to a held list, dropping the oldest past the bound. */
export function appendDeferred(
  deferred: readonly IssueWakeupEvidence[] | undefined,
  evidence: IssueWakeupEvidence
): IssueWakeupEvidence[] {
  const next = [...(deferred ?? []), evidence]
  return next.length > ISSUE_WAKEUP_MAX_DEFERRED ? next.slice(-ISSUE_WAKEUP_MAX_DEFERRED) : next
}

/** The longest chain among a fire's inputs — the lineage the fire continues. */
export function chainOfInputs(inputs: readonly IssueWakeupEvidence[]): string[] {
  let longest: string[] = []
  for (const input of inputs) if (input.chain.length > longest.length) longest = input.chain
  return [...longest]
}

/** One line for the agent (English: it goes into a prompt). */
export function describeBarrier(barrier: IssueChildrenBarrier): string {
  return barrier.kind === "all"
    ? "All sub-issues are finished."
    : `Sub-issue stage ${barrier.stage} and every earlier stage are finished.`
}

export interface WakeupBriefInput {
  taskId: string
  instruction: string
  identifier: string
  inputs: readonly IssueWakeupEvidence[]
  /** The input is joining a run already in flight rather than starting one. */
  joined: boolean
  periodic: boolean
  /** Which issue each subject id is, for inputs from children or a watched issue. */
  identifiersById?: ReadonlyMap<string, string>
  /** What a children-done fire reached, so the agent knows which hand-off this is. */
  barrier?: IssueChildrenBarrier
  /** The deadline that passed first, when this is a rule waking on timeout. */
  timedOutAt?: Date
}

/**
 * What the woken agent reads. Starts with a marker line so an agent (and a
 * person reading the transcript) can tell a wakeup from the issue text above
 * it; lists at most {@link ISSUE_WAKEUP_BRIEF_MAX_INPUTS} inputs, newest last.
 */
export function buildWakeupBrief(input: WakeupBriefInput): string {
  const lines = [
    input.joined
      ? `[WAKEUP ${input.taskId} — joined this run] ${input.identifier}`
      : `[WAKEUP ${input.taskId}] ${input.identifier}`,
    input.instruction.trim(),
  ]
  if (input.barrier) lines.push("", describeBarrier(input.barrier))
  if (input.timedOutAt) {
    lines.push(
      "",
      `This wakeup's deadline (${input.timedOutAt.toISOString()}) passed before what it waited for happened. Decide what to do without it: follow up, ask, or close the loop.`
    )
  }
  const shown = input.inputs.slice(-ISSUE_WAKEUP_BRIEF_MAX_INPUTS)
  if (shown.length > 0) {
    lines.push("", "What happened:")
    const hidden = input.inputs.length - shown.length
    if (hidden > 0) lines.push(`- (${hidden} earlier input(s) omitted)`)
    for (const evidence of shown) {
      const subject = input.identifiersById?.get(evidence.subjectId)
      const on = subject && subject !== input.identifier ? ` on ${subject}` : ""
      lines.push(
        `- ${new Date(evidence.ts).toISOString()} ${evidence.kind}${on} by ${actorName(evidence.actor)}: ${evidence.summary}`
      )
    }
  }
  if (input.periodic) {
    lines.push(
      "",
      `This is a periodic check. If there is nothing to deliver, call issue_wakeup_checkin with wakeupId "${input.taskId}" and a one-line note instead of finishing the issue; the issue then stays where it is.`
    )
  }
  return lines.join("\n")
}

/**
 * The trigger families the authoring dialog offers a person, as presets over
 * {@link IssueWakeupTriggerSpec}. Here rather than in the component so the
 * i18n coverage test can enumerate them without importing React.
 */
/**
 * The deadlines the authoring dialog offers, in hours from creation. Here for
 * the same reason as {@link WAKEUP_PRESETS}: the i18n test enumerates them.
 */
export const WAKEUP_EXPIRY_HOURS = ["1", "4", "24", "72", "168", "336"] as const

/**
 * The outcomes the `pr-checks` preset offers: either settled result, or one.
 * Here for the same reason as {@link WAKEUP_PRESETS}.
 */
export const WAKEUP_CHECK_RESULTS = ["any", "passing", "failing"] as const

export type WakeupCheckResult = (typeof WAKEUP_CHECK_RESULTS)[number]

export const WAKEUP_PRESETS = [
  "comment",
  "status",
  "children-done",
  "issue-finished",
  "pr-merged",
  "pr-checks",
  "daily",
  "interval",
  "at",
] as const

export type WakeupPreset = (typeof WAKEUP_PRESETS)[number]

/**
 * Every kind a rule can watch: the trail kinds except `wakeup_fired` (a record
 * of a delivery, never published as an input), plus the derived child kind.
 * The assertion below fails to compile when a trail kind is added and not
 * listed here, so a skill schema built from this cannot fall behind.
 */
export const ISSUE_WAKEUP_EVENT_KINDS = [
  "created",
  "status_changed",
  "assigned",
  "unassigned",
  "reassigned",
  "priority_changed",
  "label_added",
  "label_removed",
  "title_changed",
  "description_changed",
  "project_changed",
  "commented",
  "run_started",
  "run_succeeded",
  "run_failed",
  "run_checked_in",
  "artifact_linked",
  "deliverable_accepted",
  "github_linked",
  "github_write_back",
  "parent_changed",
  "blocker_added",
  "blocker_removed",
  "due_date_changed",
  "estimate_changed",
  "stage_changed",
  "triage_changed",
  "pr_state_changed",
  "pr_checks_changed",
  "cycle_changed",
  "external_linked",
  "external_unlinked",
  "work_started",
  "work_settled",
  "synced_in",
  "sync_conflict",
  "sync_conflict_resolved",
  "child_status_changed",
  "child_stage_changed",
] as const satisfies readonly IssueWakeupEventKind[]

type UnlistedWakeupKind = Exclude<
  IssueWakeupEventKind,
  (typeof ISSUE_WAKEUP_EVENT_KINDS)[number] | "wakeup_fired"
>
const assertEveryKindListed: [UnlistedWakeupKind] extends [never] ? true : never = true
void assertEveryKindListed

/** Narrow a condition for display. */
export function conditionTargetId(condition: IssueWakeupCondition | undefined): string | undefined {
  return condition?.kind === "issue-finished" ? condition.issueId : undefined
}

/** What the board shows on a card about its wakeups. */
export interface IssueWakeupCue {
  /** Author-written rules that can still fire. */
  active: number
  /** Rules that stopped themselves or were paused by someone. */
  paused: number
  /** The reason of the most recent self-pause, when one is known. */
  pauseReason?: IssueWakeupPauseReason
  /** Inputs held for an active run, across the issue's rules. */
  held: number
  /** The soonest timer, for the tooltip. */
  nextRunAt?: Date
}

/**
 * Fold wakeup tasks into one cue per issue. Platform-owned rules are left
 * out: every parent has one, so counting them would put a bell on every
 * parent card and say nothing. The detail panel lists them.
 */
export function summarizeWakeupCues(tasks: readonly ScheduledTask[]): Map<string, IssueWakeupCue> {
  const cues = new Map<string, IssueWakeupCue>()
  for (const task of tasks) {
    const payload = readWakeupPayload(task.payload)
    if (!payload || payload.system) continue
    if (task.status !== "active" && task.status !== "paused") continue
    const cue = cues.get(payload.issueId) ?? { active: 0, paused: 0, held: 0 }
    if (task.status === "active") {
      cue.active += 1
      if (task.nextRunAt && (!cue.nextRunAt || task.nextRunAt < cue.nextRunAt)) {
        cue.nextRunAt = task.nextRunAt
      }
    } else {
      cue.paused += 1
      const reason = wakeupPauseReasonOf(
        typeof task.lastTerminalReason === "string" ? task.lastTerminalReason : undefined
      )
      if (reason) cue.pauseReason = reason
    }
    cue.held += payload.deferred?.length ?? 0
    cues.set(payload.issueId, cue)
  }
  return cues
}

/** A wakeup as an agent sees it: no serialized blobs, no held-input bodies. */
export function summariseWakeup(task: ScheduledTask) {
  const payload = readWakeupPayload(task.payload)
  return {
    wakeupId: task.id,
    issueId: payload?.issueId ?? null,
    status: task.status,
    trigger: decompileWakeupTrigger(task),
    instruction: payload?.instruction ?? "",
    ...(payload?.instructionOverride ? { instructionOverride: payload.instructionOverride } : {}),
    once: payload?.once === true,
    ...(payload?.onTimeout ? { onTimeout: payload.onTimeout } : {}),
    system: payload?.system ?? null,
    fires: task.runCount,
    maxFires: task.config.maxRuns ?? null,
    heldInputs: payload?.deferred?.length ?? 0,
    ...(task.status === "paused"
      ? {
          pauseReason:
            wakeupPauseReasonOf(
              typeof task.lastTerminalReason === "string" ? task.lastTerminalReason : undefined
            ) ?? "manual",
        }
      : {}),
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt.toISOString() } : {}),
    ...(task.lastRunAt ? { lastFiredAt: task.lastRunAt.toISOString() } : {}),
    ...(task.lastError ? { lastError: task.lastError } : {}),
    ...(task.endAt ? { expiresAt: task.endAt.toISOString() } : {}),
  }
}
