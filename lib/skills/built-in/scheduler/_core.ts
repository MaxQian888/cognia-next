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
    "Type-specific configuration. chat/agent/skill: { prompt, characterId?, skillId?, sessionTitle?, model?, maxTurns? }. goal: { objective, characterId? }. plan: { planId }. agent-team: { teamId }. workflow: { workflowId }. external-agent: { prompt, agentId }. im-push: { adapterId, conversationKey, text }. background-command: { command, cwd, maxRuntimeMs? } (maxRuntimeMs kills the spawned process once it has run that long; omit for no limit). backup: { backupType?, destination? }."
  )

/** A task as the agent sees it. Trimmed: no serialized blobs, no internals. */
export interface AgentVisibleTask {
  id: string
  name: string
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
}

export function toAgentVisibleTask(task: ScheduledTask): AgentVisibleTask {
  return {
    id: task.id,
    name: task.name,
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
  }
}

/**
 * Ask the policy and the host, once, before any write.
 *
 * Returns nothing on success and THROWS on refusal, because the dispatcher
 * turns a thrown error into a `{ status: "error", message }` the assistant can
 * read and relay. A refusal is information the user needs, not a silent no-op.
 *
 * `requiresConfirmation` is NOT a refusal here, unlike in the plugin API: the
 * dispatcher has already shown this skill's `hitlSurface` and had the user
 * press Confirm by the time `execute` runs, for any skill whose `mutation` is
 * not `read`. Treating it as a second refusal would make a confirmed write
 * fail after the user had already said yes.
 */
export async function resolveTaskWrite(input: {
  taskType: ScheduledTaskType
  sessionId?: string
}): Promise<{ source: TaskWriteSource }> {
  const { authorizeTaskWrite, verdictNeedsConfirmation } =
    await import("@/lib/scheduler/write-authority")
  const verdict = await authorizeTaskWrite({
    taskType: input.taskType,
    source: "agent",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  if (!verdict.allowed) throw new Error(verdict.message)
  if (verdictNeedsConfirmation(verdict)) {
    // Reached only when the dispatcher already collected a confirmation. Left
    // as an explicit no-op branch so the reasoning is visible at the site.
  }
  return { source: "agent" }
}

/** Load one task, or throw a message naming the id the agent passed. */
export async function requireTask(taskId: string): Promise<ScheduledTask> {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  const task = await getTaskScheduler().getTask(taskId)
  if (!task) throw new Error(`No scheduled task with id ${taskId}. Use scheduler_list_tasks first.`)
  return task
}

/** Short human summary of a trigger, for confirm cards. */
export function describeTrigger(trigger: z.infer<typeof triggerSchema>): string {
  switch (trigger.type) {
    case "cron":
      return `cron ${trigger.cronExpression}${trigger.timezone ? ` (${trigger.timezone})` : ""}`
    case "interval":
      return `every ${Math.round(trigger.intervalMs / 1000)}s`
    case "once":
      return `once at ${trigger.runAt}`
    case "event":
      return `on event ${trigger.eventType}`
  }
}
