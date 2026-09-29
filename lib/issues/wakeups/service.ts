/**
 * Issue wakeups — the write half: create, list, pause, resume, delete, the
 * cascade when issues go, and the platform-owned "parent waits for its
 * children" rule (plan Phase 1).
 *
 * Every write goes through the scheduler (`getTaskScheduler`) rather than the
 * table, so a cron rule is armed and disarmed like any other task. The two
 * exceptions write the row directly on purpose: held inputs and the pause
 * reason are payload/bookkeeping changes the scheduler must NOT treat as an
 * edit (an edit re-arms the timer and restarts its clock), and the system rule
 * is an event rule with nothing to arm.
 *
 * Authority: a person in the UI and an agent through `issue.wakeup_*` both
 * pass `authorizeTaskWrite`, the one gate every non-user schedule write goes
 * through, so the user's scheduler policy (agents allowed at all, quota,
 * confirmation) applies to wakeups exactly as to any task.
 */

import type { Issue, IssueActor, IssueWakeupEvidence, IssueWakeupPauseReason } from "@/types/issues"
import { ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS, ISSUE_WAKEUP_TASK_TYPE } from "@/types/issues"
import type { ScheduledTask, ScheduledTaskCreator } from "@/types/scheduler"
import { DEFAULT_EXECUTION_CONFIG } from "@/types/scheduler"
import type { TaskWriteSource } from "@/lib/scheduler/write-authority"
import { getIssue } from "@/lib/db/issues"
import { getIssueProject } from "@/lib/db/issue-projects"
import { isGithubImportBinding } from "@/lib/issues/sync/bindings"
import { getDb } from "@/lib/db/schema"
import {
  compileIssueWakeup,
  isTerminalIssueStatus,
  readWakeupPayload,
  type IssueWakeupSpec,
} from "./model"

async function scheduler() {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return getTaskScheduler()
}

async function schedulerTable() {
  const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
  return schedulerDb
}

/**
 * One read-modify-write at a time per task. Two inputs for the same rule can
 * be held from two concurrent event fan-outs; without this the second write
 * would be computed from the row before the first and drop an input.
 */
const taskLocks = new Map<string, Promise<unknown>>()

export async function withWakeupLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const previous = taskLocks.get(taskId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(fn)
  taskLocks.set(taskId, next)
  try {
    return await next
  } finally {
    if (taskLocks.get(taskId) === next) taskLocks.delete(taskId)
  }
}

/** Every wakeup task, newest first. */
export async function listAllIssueWakeups(): Promise<ScheduledTask[]> {
  const rows = await (await schedulerTable()).getTasksByType(ISSUE_WAKEUP_TASK_TYPE)
  return rows
    .filter((task) => readWakeupPayload(task.payload) !== undefined)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/** Wakeups that belong to one issue (not the ones merely watching it). */
export async function listIssueWakeups(issueId: string): Promise<ScheduledTask[]> {
  return (await listAllIssueWakeups()).filter(
    (task) => readWakeupPayload(task.payload)?.issueId === issueId
  )
}

/** Wakeups of every issue in a workspace, for the board's cues. */
export async function listWorkspaceIssueWakeups(projectId: string): Promise<ScheduledTask[]> {
  return (await listAllIssueWakeups()).filter((task) => task.projectId === projectId)
}

/** A wakeup by id, or `undefined` when the id is not a wakeup at all. */
export async function getIssueWakeup(taskId: string): Promise<ScheduledTask | undefined> {
  const task = await (await schedulerTable()).getTask(taskId)
  if (!task || task.type !== ISSUE_WAKEUP_TASK_TYPE) return undefined
  return readWakeupPayload(task.payload) ? task : undefined
}

export interface CreateIssueWakeupInput extends IssueWakeupSpec {
  /** Scheduler row name. Defaults to "<identifier> wakeup". */
  name?: string
  /** Who is writing — decides which policy rules apply (`authorizeTaskWrite`). */
  source: TaskWriteSource
  /** Provenance on the task row; an agent write names its session. */
  createdBy?: ScheduledTaskCreator
  sessionId?: string
  /** A person pressed Confirm on this very write (skill dispatcher). */
  humanConfirmed?: boolean
}

/** Why a wakeup write was refused, keyed for the UI and the skills. */
export class IssueWakeupWriteError extends Error {
  readonly reason:
    | "issue-missing"
    | "issue-finished"
    | "target-missing"
    | "target-other-workspace"
    | "pr-unobservable"
    | "not-a-wakeup"
    | "policy"

  constructor(reason: IssueWakeupWriteError["reason"], message: string) {
    super(message)
    this.name = "IssueWakeupWriteError"
    this.reason = reason
    Object.setPrototypeOf(this, IssueWakeupWriteError.prototype)
  }
}

async function authorize(input: {
  source: TaskWriteSource
  sessionId?: string
  humanConfirmed?: boolean
  operation: "create" | "mutate"
}): Promise<void> {
  const { authorizeTaskWrite, verdictNeedsConfirmation } =
    await import("@/lib/scheduler/write-authority")
  const verdict = await authorizeTaskWrite({
    taskType: ISSUE_WAKEUP_TASK_TYPE,
    source: input.source,
    operation: input.operation,
    humanConfirmed: input.humanConfirmed === true,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  if (!verdict.allowed) throw new IssueWakeupWriteError("policy", verdict.message)
  if (verdictNeedsConfirmation(verdict)) {
    throw new IssueWakeupWriteError(
      "policy",
      `${verdict.message} It was not added because nobody confirmed this write.`
    )
  }
}

/**
 * Validate a spec against the tracker without writing: the issue exists and
 * is open, and a watched issue exists in the same workspace. Shared by the
 * skill's preflight and {@link createIssueWakeup}.
 */
export async function validateIssueWakeupSpec(spec: IssueWakeupSpec): Promise<Issue> {
  const issue = await getIssue(spec.issueId)
  if (!issue) throw new IssueWakeupWriteError("issue-missing", `No issue ${spec.issueId}.`)
  if (isTerminalIssueStatus(issue.status)) {
    throw new IssueWakeupWriteError(
      "issue-finished",
      `${issue.identifier} is ${issue.status}; wakeups only watch open issues.`
    )
  }
  if (spec.trigger.on === "issue-finished") {
    const target = await getIssue(spec.trigger.targetIssueId)
    if (!target) {
      throw new IssueWakeupWriteError("target-missing", `No issue ${spec.trigger.targetIssueId}.`)
    }
    if (target.projectId !== issue.projectId) {
      throw new IssueWakeupWriteError(
        "target-other-workspace",
        `${target.identifier} belongs to another workspace.`
      )
    }
  }
  if (spec.trigger.on === "pr-merged") {
    // Pull request state only moves when the import sweep observes it. A rule
    // on a container that is not swept would wait forever, so say so now.
    const project = await getIssueProject(issue.issueProjectId)
    if (!project?.resources.some(isGithubImportBinding)) {
      throw new IssueWakeupWriteError(
        "pr-unobservable",
        `${issue.identifier}'s project is not bound to a GitHub repository in import mode, so a pull request merging would never be observed.`
      )
    }
  }
  // Compiling throws on an instruction, budget or trigger it cannot honour.
  compileIssueWakeup(spec)
  return issue
}

export async function createIssueWakeup(input: CreateIssueWakeupInput): Promise<ScheduledTask> {
  const issue = await validateIssueWakeupSpec(input)
  await authorize({
    source: input.source,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.humanConfirmed ? { humanConfirmed: true } : {}),
    operation: "create",
  })
  const compiled = compileIssueWakeup(input)
  return (await scheduler()).createTask({
    name: input.name?.trim() || `${issue.identifier} wakeup`,
    description: compiled.payload.instruction.slice(0, 200),
    type: ISSUE_WAKEUP_TASK_TYPE,
    trigger: compiled.trigger,
    payload: compiled.payload,
    config: compiled.config,
    // A fire that starts a run is visible on the issue; a pause or a refusal
    // is the thing worth hearing about.
    notification: { onStart: false, onComplete: false, onError: true },
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    // The issue decides the workspace; the creating conversation does not.
    projectId: issue.projectId,
    workspaceResolved: true,
    tags: ["issue-wakeup", issue.identifier],
    ...(compiled.endAt ? { endAt: compiled.endAt } : {}),
  })
}

async function requireWakeup(taskId: string): Promise<ScheduledTask> {
  const task = await getIssueWakeup(taskId)
  if (!task) throw new IssueWakeupWriteError("not-a-wakeup", `No issue wakeup ${taskId}.`)
  return task
}

export interface MutateIssueWakeupOptions {
  source: TaskWriteSource
  sessionId?: string
  humanConfirmed?: boolean
}

/**
 * Pause or resume. Resuming a rule on a finished issue is refused: reopening
 * the issue does not re-enable its wakeups either, so a resume is the one way
 * back and it has to find the issue open.
 */
export async function setIssueWakeupEnabled(
  taskId: string,
  enabled: boolean,
  options: MutateIssueWakeupOptions
): Promise<ScheduledTask> {
  const task = await requireWakeup(taskId)
  await authorize({ ...options, operation: "mutate" })
  const sched = await scheduler()
  if (enabled) {
    const payload = readWakeupPayload(task.payload)!
    const issue = await getIssue(payload.issueId)
    if (!issue) throw new IssueWakeupWriteError("issue-missing", `No issue ${payload.issueId}.`)
    if (isTerminalIssueStatus(issue.status)) {
      throw new IssueWakeupWriteError(
        "issue-finished",
        `${issue.identifier} is ${issue.status}; reopen it before resuming its wakeups.`
      )
    }
    await sched.resumeTask(taskId)
  } else {
    await sched.pauseTask(taskId)
  }
  return (await getIssueWakeup(taskId)) ?? task
}

export async function deleteIssueWakeup(
  taskId: string,
  options: MutateIssueWakeupOptions
): Promise<void> {
  await requireWakeup(taskId)
  await authorize({ ...options, operation: "mutate" })
  await (await scheduler()).deleteTask(taskId)
}

/**
 * Pause a wakeup on its own behalf and record why. The reason goes on
 * `lastTerminalReason`, which the board cue and the scheduler's attention
 * signal read; an executor that pauses also returns the same reason, so the
 * stats write that follows the execution leaves it in place.
 */
export async function pauseIssueWakeupFor(
  taskId: string,
  reason: IssueWakeupPauseReason,
  now = new Date()
): Promise<void> {
  await (await scheduler()).pauseTask(taskId)
  const table = await schedulerTable()
  await withWakeupLock(taskId, async () => {
    const latest = await table.getTask(taskId)
    if (!latest) return
    await table.updateTask({
      ...latest,
      lastTerminalReason: ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS[reason],
      lastTerminalAt: now,
      updatedAt: now,
    })
  })
}

/**
 * The issue finished: every active wakeup it owns stops. Reopening does not
 * re-enable them — a rule written for the old work should not silently start
 * waking agents on the new work.
 */
export async function pauseWakeupsForIssue(issueId: string): Promise<string[]> {
  const paused: string[] = []
  for (const task of await listIssueWakeups(issueId)) {
    if (task.status !== "active") continue
    await pauseIssueWakeupFor(task.id, "issue-closed")
    paused.push(task.id)
  }
  return paused
}

/** Consume a one-shot rule after its delivery. */
export async function consumeIssueWakeup(taskId: string): Promise<void> {
  await (await scheduler()).updateTask(taskId, { status: "expired" })
}

/** Replace the held inputs (empty clears them). Never re-arms the task. */
export async function setIssueWakeupDeferred(
  taskId: string,
  deferred: readonly IssueWakeupEvidence[]
): Promise<void> {
  const table = await schedulerTable()
  await withWakeupLock(taskId, async () => {
    const latest = await table.getTask(taskId)
    const payload = readWakeupPayload(latest?.payload)
    if (!latest || !payload) return
    const next = { ...payload }
    if (deferred.length > 0) next.deferred = [...deferred]
    else delete next.deferred
    await table.updateTask({ ...latest, payload: next, updatedAt: new Date() })
  })
}

/** Add inputs to what a rule holds, under the rule's lock. */
export async function holdIssueWakeupInputs(
  taskId: string,
  append: (held: readonly IssueWakeupEvidence[]) => IssueWakeupEvidence[]
): Promise<void> {
  const table = await schedulerTable()
  await withWakeupLock(taskId, async () => {
    const latest = await table.getTask(taskId)
    const payload = readWakeupPayload(latest?.payload)
    if (!latest || !payload) return
    await table.updateTask({
      ...latest,
      payload: { ...payload, deferred: append(payload.deferred ?? []) },
      updatedAt: new Date(),
    })
  })
}

/**
 * Cascade for deleted issues. Removes the rules the issues owned AND the rules
 * watching them (`issue-finished` on a deleted issue can never fire). Runs
 * after the deleting transaction commits: the scheduler has timers to disarm,
 * which a Dexie transaction cannot do.
 */
export async function deleteWakeupsForIssues(issueIds: readonly string[]): Promise<string[]> {
  if (issueIds.length === 0) return []
  const gone = new Set(issueIds)
  const removed: string[] = []
  const sched = await scheduler()
  for (const task of await listAllIssueWakeups()) {
    const payload = readWakeupPayload(task.payload)!
    const watched = payload.condition?.kind === "issue-finished" ? payload.condition.issueId : null
    if (!gone.has(payload.issueId) && !(watched && gone.has(watched))) continue
    await sched.deleteTask(task.id)
    removed.push(task.id)
  }
  return removed
}

/**
 * Fire-and-forget form of {@link deleteWakeupsForIssues} for the CRUD layer,
 * which must not import the scheduler graph statically nor fail a deletion
 * because a rule could not be removed (the executor also deletes a rule whose
 * issue is gone, the next time it fires).
 */
export function cascadeDeleteIssueWakeups(issueIds: readonly string[]): void {
  if (issueIds.length === 0) return
  void deleteWakeupsForIssues(issueIds).catch((error) => {
    console.warn(
      "[issues/wakeups] cascade delete failed:",
      error instanceof Error ? error.message : String(error)
    )
  })
}

// ─── System rule: the parent waits for its children (plan Phase 1) ─────────

/** Deterministic id, so "ensure" is a lookup rather than a scan. */
export function childrenDoneWakeupId(parentId: string): string {
  return `issue-wakeup::children-done::${parentId}`
}

/** The built-in instruction when the parent has none of its own. */
export const CHILDREN_DONE_INSTRUCTION =
  "Every sub-issue of this issue is now done or canceled. Review what they delivered and continue this issue: finish it, or say what is still missing."

/** The actor a platform-owned rule acts as. An id-less agent, never a person. */
export const SYSTEM_WAKEUP_ACTOR: IssueActor = { kind: "agent", label: "issue-wakeup" }

/**
 * Make sure a parent has its children-done rule. Idempotent. Skipped for a
 * finished parent. Written straight to the table: it is an event rule, so
 * there is no timer to arm, and the deterministic id is what keeps concurrent
 * ensures from creating two.
 */
export async function ensureChildrenDoneWakeup(
  parentId: string
): Promise<"created" | "exists" | "skipped"> {
  const table = await schedulerTable()
  const id = childrenDoneWakeupId(parentId)
  return withWakeupLock(id, async () => {
    if (await table.getTask(id)) return "exists"
    const parent = await getIssue(parentId)
    if (!parent || isTerminalIssueStatus(parent.status)) return "skipped"
    const compiled = compileIssueWakeup({
      issueId: parentId,
      instruction: CHILDREN_DONE_INSTRUCTION,
      trigger: { on: "children-done" },
      // Children can be added after the first batch finishes, and each batch
      // finishing is worth one delivery.
      once: false,
      author: SYSTEM_WAKEUP_ACTOR,
      system: "children-done",
    })
    const { resolveCatchupDefaults } = await import("@/lib/scheduler/catchup-policy")
    const now = new Date()
    await table.createTask({
      id,
      name: `${parent.identifier} — sub-issues finished`,
      description: CHILDREN_DONE_INSTRUCTION,
      type: ISSUE_WAKEUP_TASK_TYPE,
      trigger: compiled.trigger,
      payload: compiled.payload,
      config: {
        ...DEFAULT_EXECUTION_CONFIG,
        ...resolveCatchupDefaults(ISSUE_WAKEUP_TASK_TYPE),
        ...compiled.config,
      },
      notification: { onStart: false, onComplete: false, onError: true },
      status: "active",
      projectId: parent.projectId,
      tags: ["issue-wakeup", "system", parent.identifier],
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    return "created"
  })
}

/**
 * Boot reconcile: every open parent has its rule. Covers issues that gained
 * children before this feature existed, and children filed with a parent
 * (`createIssue` records `created`, not `parent_changed`) while the tracker
 * was not running.
 */
export async function reconcileChildrenDoneWakeups(): Promise<number> {
  const parentIds = (await getDb().issues.orderBy("parentId").uniqueKeys()) as string[]
  let created = 0
  for (const parentId of parentIds) {
    if (!parentId) continue
    if ((await ensureChildrenDoneWakeup(parentId)) === "created") created += 1
  }
  return created
}
