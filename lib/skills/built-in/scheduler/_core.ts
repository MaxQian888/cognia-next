/**
 * Shared vocabulary and the single write path for the `schedule.*` family.
 *
 * Before this family existed, the only way an agent could touch the schedule
 * was three MCP tools in `lib/external-bridge/handlers/scheduling.ts`, gated
 * behind an IM adapter capability. A desktop chat had no scheduler tools at
 * all, and even in IM the tools could create exactly two task types on two
 * kinds of trigger, with no way to inspect, amend, pause or run one.
 *
 * Everything here funnels through {@link resolveTaskWrite} so the policy gate,
 * the host-capability gate and the workspace binding are asked in one place.
 * A second write path is how one of them ends up skipped.
 */

import { z } from "zod"

import type { ScheduledTask, ScheduledTaskType, TaskTrigger } from "@/types/scheduler"
import type { TaskWriteSource } from "@/lib/scheduler/write-authority"

/**
 * Task types an agent may author.
 *
 * Deliberately narrower than `ScheduledTaskType`. Left out are the types a
 * subsystem owns and authors from its own settings card (`twin`, `wiki-*`,
 * `radar-report`, `github-issue-sync`, every `connection:*`), the two
 * deprecated ones, and `custom` / `plugin`, whose payloads only mean something
 * to the code that registered the executor. Also left out is `script`: the
 * user has a dedicated switch for it, and an agent that wants a command has
 * `background-command`, which the same switch does not silently cover.
 */
export const AGENT_SCHEDULABLE_TASK_TYPES = [
  "chat",
  "agent",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
  "workflow",
  "im-push",
  "background-command",
  "backup",
] as const satisfies readonly ScheduledTaskType[]

export type AgentSchedulableTaskType = (typeof AGENT_SCHEDULABLE_TASK_TYPES)[number]

export const taskTypeSchema = z
  .enum(AGENT_SCHEDULABLE_TASK_TYPES)
  .describe(
    "What the task runs. chat/agent/skill drive a Claude turn; goal runs a self-driving objective to terminal; plan executes an approved plan; agent-team runs a squad; workflow runs a published visual workflow; external-agent drives a configured ACP agent; im-push sends a message to a bound conversation; background-command runs a shell command; backup runs a data backup."
  )

/**
 * Trigger vocabulary, mirroring `TaskTrigger` minus the fields a scheduler
 * subsystem sets for itself.
 *
 * `once` and `event` are here because their absence was a real gap: an agent
 * asked to "do X tomorrow at 9" had to express it as a cron expression that
 * would then repeat every day, and an agent could not react to another task
 * finishing at all.
 */
export const triggerSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("cron"),
      cronExpression: z
        .string()
        .min(1)
        .describe("5-field or 6-field cron, e.g. '0 9 * * 1-5' for weekdays at 09:00."),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, e.g. 'Asia/Shanghai'. Defaults to the user's setting."),
    }),
    z.object({
      type: z.literal("interval"),
      intervalMs: z.number().int().positive().describe("Milliseconds between runs."),
    }),
    z.object({
      type: z.literal("once"),
      runAt: z.string().describe("ISO-8601 instant to run at, once."),
    }),
    z.object({
      type: z.literal("event"),
      eventType: z
        .string()
        .min(1)
        .describe(
          "Scheduler event that fires this task, e.g. 'chat:completed' or '<taskType>:completed'."
        ),
    }),
  ])
  .describe("When the task runs. Exactly one shape.")

/** Convert the wire shape into the scheduler's own `TaskTrigger`. */
export function toTaskTrigger(input: z.infer<typeof triggerSchema>): TaskTrigger {
  switch (input.type) {
    case "cron":
      return {
        type: "cron",
        cronExpression: input.cronExpression,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      }
    case "interval":
      return { type: "interval", intervalMs: input.intervalMs }
    case "once": {
      const runAt = new Date(input.runAt)
      if (Number.isNaN(runAt.getTime())) {
        throw new Error(`runAt is not a valid ISO-8601 instant: ${input.runAt}`)
      }
      return { type: "once", runAt }
    }
    case "event":
      return { type: "event", eventType: input.eventType }
  }
}

/**
 * The payload, kept loose on purpose.
 *
 * A discriminated union mirroring every `*TaskPayload` in `types/scheduler`
 * would be a second copy of a contract that already changes when executors
 * change, and the two would drift. The executors validate their own payloads
 * and fail with a real message, so the schema's job here is to describe the
 * shape well enough that a model fills it in correctly.
 */
export const payloadSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Type-specific configuration. chat: { prompt, characterId?, sessionTitle?, model?, maxTurns? }. agent: { prompt, characterId (required) }. skill: { prompt, skillId (required), characterId? }. goal: { objective, characterId? }. plan: { planId }. agent-team: { teamId }. workflow: { workflowId }. external-agent: { prompt, agentId }. im-push: { adapterId, conversationKey, text }. background-command: { command, cwd, maxRuntimeMs? } (maxRuntimeMs kills the spawned process once it has run that long; omit for no limit). backup: { backupType?, destination? }."
  )

/**
 * Reject a payload the executor would reject, before anyone is asked to
 * confirm it.
 *
 * The four conversational types go through the scheduler's own normalizer,
 * which `TaskScheduler.createTask` runs anyway, so this only moves the failure
 * earlier. The rest mirror the check at the top of each executor (named per
 * line) rather than inventing stricter rules the scheduler itself would not
 * enforce.
 */
export async function assertAgentTaskPayload(
  taskType: AgentSchedulableTaskType,
  payload: Record<string, unknown>
): Promise<void> {
  const text = (key: string): boolean =>
    typeof payload[key] === "string" && (payload[key] as string).trim().length > 0
  const requireKey = (key: string, executor: string): void => {
    if (!text(key)) {
      throw new Error(`A ${taskType} task needs "${key}" in its payload (${executor}).`)
    }
  }
  switch (taskType) {
    case "chat":
    case "agent":
    case "skill":
    case "external-agent": {
      const { normalizeConversationalTaskPayload } =
        await import("@/lib/scheduler/conversational-task-authoring")
      normalizeConversationalTaskPayload(taskType, payload as never)
      // The normalizer accepts an agent task without a character; the
      // executor does not (`executeAgentTask` in executors/index.ts).
      if (taskType === "agent") requireKey("characterId", "executors/index.ts")
      return
    }
    case "goal":
      return requireKey("objective", "goal-executor.ts")
    case "plan":
      return requireKey("planId", "plan-executor.ts")
    case "agent-team":
      return requireKey("teamId", "team-executor.ts")
    case "workflow":
      return requireKey("workflowId", "workflow-executor.ts")
    case "im-push": {
      requireKey("conversationKey", "im-push-executor.ts")
      const segments = payload.segments
      if (!text("text") && !(Array.isArray(segments) && segments.length > 0)) {
        throw new Error('An im-push task needs a non-empty "text" or "segments" in its payload.')
      }
      return
    }
    case "background-command":
      requireKey("command", "background-job-executor.ts")
      return requireKey("cwd", "background-job-executor.ts")
    case "backup":
      return
  }
}

/**
 * Reject a trigger the scheduler would reject: an unparseable cron, an unknown
 * timezone, a one-off time already in the past. Same normalizer
 * `TaskScheduler.createTask` / `updateTask` run.
 */
export async function assertAgentTaskTrigger(
  trigger: z.infer<typeof triggerSchema>,
  now: Date = new Date()
): Promise<void> {
  const { normalizeTaskTrigger } = await import("@/lib/scheduler/trigger-normalizer")
  normalizeTaskTrigger(toTaskTrigger(trigger), { now })
}

/** A task as the agent sees it. Trimmed: no serialized blobs, no internals. */
export interface AgentVisibleTask {
  id: string
  name: string
  description?: string
  type: string
  status: string
  trigger: TaskTrigger
  nextRunAt?: string
  lastRunAt?: string
  runCount: number
  successCount: number
  failureCount: number
  lastError?: string
  lastTerminalReason?: string
  createdBy?: string
  tags?: string[]
  /** Owning workspace, so the assistant can tell the user where it lives. */
  projectId?: string
}

export function toAgentVisibleTask(task: ScheduledTask): AgentVisibleTask {
  return {
    id: task.id,
    name: task.name,
    ...(task.description ? { description: task.description } : {}),
    type: task.type,
    status: task.status,
    trigger: task.trigger,
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt.toISOString() } : {}),
    ...(task.lastRunAt ? { lastRunAt: task.lastRunAt.toISOString() } : {}),
    runCount: task.runCount,
    successCount: task.successCount,
    failureCount: task.failureCount,
    ...(task.lastError ? { lastError: task.lastError } : {}),
    ...(task.lastTerminalReason ? { lastTerminalReason: task.lastTerminalReason } : {}),
    ...(task.createdBy ? { createdBy: task.createdBy.kind } : {}),
    ...(task.tags?.length ? { tags: task.tags } : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
  }
}

/**
 * Ask the policy and the host, once, before any write.
 *
 * Returns nothing on success and THROWS on refusal, because the dispatcher
 * turns a thrown error into a `{ status: "error", message }` the assistant can
 * read and relay. A refusal is information the user needs, not a silent no-op.
 *
 * `humanConfirmed` comes from the dispatcher (`ctx.humanConfirmed`): true when
 * the user pressed Confirm on THIS write. It satisfies both "may agents act
 * unattended" (`agentAutoCreate`) and "which kinds always need me"
 * (`confirmationRequired`). Without it, a verdict that still needs a person is
 * a refusal: an IM channel that turned write confirmations off must not slip a
 * `goal` or `agent-team` task through that the user said always needs them.
 *
 * `operation` scopes the quota to creation, so an agent at its limit can still
 * pause, amend, run or delete what it already owns.
 */
export async function resolveTaskWrite(input: {
  taskType: ScheduledTaskType
  sessionId?: string
  humanConfirmed?: boolean
  operation: "create" | "mutate"
}): Promise<{ source: TaskWriteSource }> {
  const { authorizeTaskWrite, verdictNeedsConfirmation } =
    await import("@/lib/scheduler/write-authority")
  const verdict = await authorizeTaskWrite({
    taskType: input.taskType,
    source: "agent",
    operation: input.operation,
    humanConfirmed: input.humanConfirmed === true,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  if (!verdict.allowed) throw new Error(verdict.message)
  if (verdictNeedsConfirmation(verdict)) {
    throw new Error(
      `${verdict.message} This conversation did not ask you to confirm it, so it was not added. Confirm writes for this channel, or add it from the scheduler panel.`
    )
  }
  return { source: "agent" }
}

/**
 * The read verbs' half of the "may agents manage the schedule" switch.
 *
 * `build-options.ts` withholds the whole family while the switch is off, and
 * `authorizeTaskWrite` refuses every agent write; this covers the reads for a
 * turn that was handed the tools before the user turned it off. Writes are
 * gated in `resolveTaskWrite`, so only `list` and `inspect` call this.
 */
export async function assertAgentMayRead(): Promise<void> {
  const { loadSchedulerPolicy } = await import("@/lib/scheduler/write-authority")
  const policy = await loadSchedulerPolicy()
  if (policy.agentToolsEnabled === false) {
    throw new Error(
      'Agents are not allowed to manage your schedule. Turn on "Allow agents to manage scheduled tasks" in the scheduler settings.'
    )
  }
}

/** Load one task, or throw a message naming the id the agent passed. */
export async function requireTask(taskId: string): Promise<ScheduledTask> {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  const task = await getTaskScheduler().getTask(taskId)
  if (!task) throw new Error(`No scheduled task with id ${taskId}. Use scheduler_list_tasks first.`)
  return task
}

/** A one-off time as confirm cards show it: local wall clock, zone named. */
const ONCE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
}

/** Short human summary of a trigger, for confirm cards. */
export function describeTrigger(trigger: z.infer<typeof triggerSchema>): string {
  switch (trigger.type) {
    case "cron":
      return `cron ${trigger.cronExpression}${trigger.timezone ? ` (${trigger.timezone})` : ""}`
    case "interval":
      return `every ${formatDuration(trigger.intervalMs)}`
    case "once": {
      // The wall clock of the device that will run it, zone named, so the
      // person confirming reads the time they asked for rather than GMT.
      const at = new Date(trigger.runAt)
      return `once at ${Number.isNaN(at.getTime()) ? trigger.runAt : at.toLocaleString("en-US", ONCE_TIME_FORMAT)}`
    }
    case "event":
      return `on event ${trigger.eventType}`
  }
}

/** "90 min" → "1 h 30 min"; "45000 ms" → "45 s". For confirm cards only. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours} h`)
  if (minutes > 0) parts.push(`${minutes} min`)
  if (seconds > 0 && hours === 0) parts.push(`${seconds} s`)
  return parts.join(" ")
}

/**
 * Preflight for the verbs that act on an existing task: the id names a task,
 * and the policy would let this write through once the user confirms it. Run
 * by the dispatcher before the confirmation, so "no such task", "agents may
 * not manage your schedule" and "cannot run on this host" arrive as answers,
 * not as a dialog the user approves only to see the write fail.
 */
export async function preflightExistingTaskWrite(
  taskId: string,
  ctx: { sessionId?: string; humanConfirmed?: boolean }
): Promise<ScheduledTask> {
  const task = await requireTask(taskId)
  await resolveTaskWrite({
    taskType: task.type,
    sessionId: ctx.sessionId,
    humanConfirmed: ctx.humanConfirmed,
    operation: "mutate",
  })
  return task
}
