/**
 * Scheduler Tools — built-in plugin.
 *
 * Gives an in-chat agent three tools over the USER's schedule (the agent →
 * scheduler half of the interconnection: the scheduler can already drive
 * agents via the agent-team / goal / plan executors):
 *
 *   - `manage_scheduled_task` — `list` and `create`;
 *   - `delete_scheduled_task` — approval-gated, removes one task;
 *   - `run_scheduled_task`    — approval-gated, runs one task now (never a
 *     `script` task).
 *
 * Every action honours the user's "Allow agents to manage scheduled tasks"
 * switch (`SchedulerPermissionPolicy.agentToolsEnabled`), read fresh on each
 * call — the same rule the built-in scheduler skill applies to its reads and
 * writes. Creation is attributed to the agent (`createdBy.kind: "agent"`), so
 * the host's write gate (`assertTaskWriteAllowed`) applies the rest of the
 * policy: `agentAutoCreate`, `confirmationRequired`, the per-source quota and
 * the script switch. This plugin does not re-implement any of those.
 *
 * The tools execute in the renderer (via the plugin-tool IPC round-trip), so
 * they reach the Dexie-backed scheduler store through `ctx.userScheduler`.
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type BotHandlerV1,
  type CreateScheduledTaskInput,
  type PluginContext,
  type PluginToolContext,
  type ScheduledTask,
  type ScheduledTaskType,
  type SchedulerPermissionPolicy,
  type TaskExecution,
  type TaskExecutionTriggerSource,
  type TaskTrigger,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

import { createScheduleDigestBot } from "./bot"

export const PLUGIN_ID = "cognia-scheduler-tools"

export const MANAGE_TOOL = "manage_scheduled_task"
export const DELETE_TOOL = "delete_scheduled_task"
export const RUN_TOOL = "run_scheduled_task"

/**
 * Task types an agent may schedule. `script` is deliberately absent: a raw
 * shell script on the user's schedule is something the user adds themselves,
 * from the scheduler panel, not something an agent authors.
 */
export const AGENT_CREATABLE_TYPES: readonly ScheduledTaskType[] = [
  "chat",
  "agent",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
]

/** Task types an agent may never run on demand, even with approval. */
const AGENT_UNRUNNABLE_TYPES: ReadonlySet<ScheduledTaskType> = new Set(["script"])

export interface SchedulerToolDeps {
  getPolicy: () => Promise<SchedulerPermissionPolicy>
  listTasks: () => Promise<ScheduledTask[]>
  createTask: (input: CreateScheduledTaskInput) => Promise<ScheduledTask | null>
  deleteTask: (taskId: string) => Promise<boolean>
  runTaskNow: (
    taskId: string,
    opts?: { triggerSource?: TaskExecutionTriggerSource }
  ) => Promise<TaskExecution | null>
}

/** Who is calling: the chat turn's session, attributed to this plugin. */
export interface SchedulerToolCaller {
  sessionId?: string
}

/**
 * The production wiring uses `ctx.userScheduler`. This is separate from
 * `ctx.scheduler` — the latter owns tasks a PLUGIN creates for itself,
 * keyed by a handler name, and cannot see the user's schedule or the
 * permission policy guarding it.
 */
function defaultDeps(ctx: PluginContext): SchedulerToolDeps {
  return {
    getPolicy: ctx.userScheduler.getPolicy,
    listTasks: ctx.userScheduler.listTasks,
    createTask: ctx.userScheduler.createTask,
    deleteTask: ctx.userScheduler.deleteTask,
    runTaskNow: ctx.userScheduler.runTaskNow,
  }
}

/**
 * The plugin context, captured on activate.
 *
 * Null before the first activate and after deactivate, and the handler says so
 * rather than reading an empty schedule: "the plugin is not running" and "you
 * have no scheduled tasks" are different answers, and a digest reporting zero
 * for the first one is a lie the run list would keep.
 */
let activeContext: PluginContext | null = null

function requireActiveContext(): PluginContext {
  if (!activeContext) throw new Error("scheduler-tools is not active")
  return activeContext
}

/**
 * The named export `manifest.bots[].export` resolves to.
 *
 * A thin binding over {@link createScheduleDigestBot} so the logic stays
 * testable without a plugin runtime, and so the capability is read at CALL
 * time rather than captured at module load, when nothing has activated yet.
 */
export const scheduleDigestBot: BotHandlerV1 = (ctx) =>
  createScheduleDigestBot({
    listTasks: () => requireActiveContext().userScheduler.listTasks(),
    t: (key, params) => requireActiveContext().i18n.t(key, params),
  })(ctx)

export interface TriggerArgs {
  type: "cron" | "interval" | "once" | "event"
  cronExpression?: string
  intervalMinutes?: number
  runAt?: string
  eventType?: string
  timezone?: string
}

export interface ManageScheduledTaskArgs {
  action: "list" | "create"
  // create
  name?: string
  description?: string
  taskType?: ScheduledTaskType
  trigger?: TriggerArgs
  payload?: Record<string, unknown>
}

export interface TaskIdArgs {
  taskId?: string
}

export type SchedulerToolResult =
  { ok: true; action: string; [k: string]: unknown } | { ok: false; error: string; reason?: string }

const AGENT_TOOLS_DISABLED =
  'Agents are not allowed to manage the user\'s schedule. Ask the user to turn on "Allow agents to manage scheduled tasks" in the scheduler settings, or to make this change themselves from the scheduler panel.'

/**
 * The switch every action answers to first. `false` is an explicit "no";
 * `undefined` (a policy persisted before the field existed) reads as the
 * default, which is on.
 */
async function refuseWhenAgentToolsDisabled(
  deps: SchedulerToolDeps
): Promise<SchedulerToolResult | null> {
  const policy = await deps.getPolicy()
  if (policy.agentToolsEnabled === false) {
    return { ok: false, error: AGENT_TOOLS_DISABLED, reason: "agent-tools-disabled" }
  }
  return null
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Turn the model's trigger arguments into a `TaskTrigger`, or say exactly what
 * is missing. No field is defaulted: a cron the model forgot to write, or a
 * one-off time it did not give, is a question for the user, not a guess.
 */
export function parseTrigger(
  input: TriggerArgs | undefined,
  now: number = Date.now()
): { ok: true; trigger: TaskTrigger } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "trigger is required" }
  const trigger: TaskTrigger = { type: input.type }
  if (input.timezone !== undefined) {
    if (!nonEmpty(input.timezone) || !isValidTimeZone(input.timezone)) {
      return {
        ok: false,
        error: `trigger.timezone is not a valid IANA time zone: ${input.timezone}`,
      }
    }
    trigger.timezone = input.timezone
  }
  switch (input.type) {
    case "cron":
      if (!nonEmpty(input.cronExpression)) {
        return { ok: false, error: "trigger.cronExpression is required for a cron trigger" }
      }
      trigger.cronExpression = input.cronExpression.trim()
      return { ok: true, trigger }
    case "interval":
      if (
        typeof input.intervalMinutes !== "number" ||
        !Number.isFinite(input.intervalMinutes) ||
        input.intervalMinutes < 1
      ) {
        return {
          ok: false,
          error: "trigger.intervalMinutes must be a number of minutes, at least 1",
        }
      }
      trigger.intervalMs = Math.round(input.intervalMinutes * 60_000)
      return { ok: true, trigger }
    case "once": {
      if (!nonEmpty(input.runAt)) {
        return { ok: false, error: "trigger.runAt (ISO date-time) is required for a once trigger" }
      }
      const runAt = new Date(input.runAt)
      if (Number.isNaN(runAt.getTime())) {
        return { ok: false, error: `trigger.runAt is not a valid ISO date-time: ${input.runAt}` }
      }
      if (runAt.getTime() <= now) {
        return { ok: false, error: `trigger.runAt is in the past: ${input.runAt}` }
      }
      trigger.runAt = runAt
      return { ok: true, trigger }
    }
    case "event":
      if (!nonEmpty(input.eventType)) {
        return { ok: false, error: "trigger.eventType is required for an event trigger" }
      }
      trigger.eventType = input.eventType.trim()
      return { ok: true, trigger }
    default:
      return {
        ok: false,
        error: `trigger.type must be one of cron, interval, once, event (got ${String((input as { type?: unknown }).type)})`,
      }
  }
}

function summarizeTask(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    status: task.status,
    nextRunAt: task.nextRunAt ?? null,
    trigger: task.trigger.type,
    createdBy: task.createdBy?.kind ?? null,
  }
}

/**
 * `list` / `create`. Pure aside from the injected deps, so it is unit
 * testable without the plugin runtime or the real store.
 */
export async function runSchedulerToolAction(
  args: ManageScheduledTaskArgs,
  deps: SchedulerToolDeps,
  caller: SchedulerToolCaller = {}
): Promise<SchedulerToolResult> {
  const refused = await refuseWhenAgentToolsDisabled(deps)
  if (refused) return refused

  switch (args.action) {
    case "list": {
      const tasks = (await deps.listTasks()).map(summarizeTask)
      return { ok: true, action: "list", count: tasks.length, tasks }
    }

    case "create": {
      const name = args.name?.trim()
      if (!name) return { ok: false, error: "name is required for create" }
      const taskType = args.taskType
      if (!taskType || !AGENT_CREATABLE_TYPES.includes(taskType)) {
        return {
          ok: false,
          error: `taskType must be one of ${AGENT_CREATABLE_TYPES.join(", ")} (got ${String(taskType)})`,
        }
      }
      const parsed = parseTrigger(args.trigger)
      if (!parsed.ok) return parsed
      if (args.payload !== undefined && (typeof args.payload !== "object" || !args.payload)) {
        return { ok: false, error: "payload must be an object" }
      }

      const input: CreateScheduledTaskInput = {
        name,
        description: args.description?.trim() || undefined,
        type: taskType,
        trigger: parsed.trigger,
        payload: args.payload ?? {},
        // Attribution is what makes the host's write gate apply the AGENT
        // policy (`agentAutoCreate`, `confirmationRequired`, the per-agent
        // quota). Without it the write was gated as a generic plugin write.
        createdBy: {
          kind: "agent",
          pluginId: PLUGIN_ID,
          ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
        },
      }
      try {
        const created = await deps.createTask(input)
        if (!created) return { ok: false, error: "the scheduler did not save the task" }
        return { ok: true, action: "create", taskId: created.id, name: created.name }
      } catch (error) {
        // The policy refusal, verbatim: it names the setting to change or the
        // panel to use instead, which is what the user needs to hear.
        return {
          ok: false,
          reason: "policy",
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    default:
      return {
        ok: false,
        error: `unknown action: ${String((args as { action?: unknown }).action)}`,
      }
  }
}

async function findTask(deps: SchedulerToolDeps, taskId: string): Promise<ScheduledTask | null> {
  return (await deps.listTasks()).find((task) => task.id === taskId) ?? null
}

/** `delete_scheduled_task` — the user approves each call before it runs. */
export async function deleteScheduledTask(
  args: TaskIdArgs,
  deps: SchedulerToolDeps
): Promise<SchedulerToolResult> {
  const refused = await refuseWhenAgentToolsDisabled(deps)
  if (refused) return refused
  if (!nonEmpty(args.taskId)) return { ok: false, error: "taskId is required" }
  const task = await findTask(deps, args.taskId)
  if (!task) {
    return { ok: false, error: `No scheduled task with id ${args.taskId}. List the tasks first.` }
  }
  const deleted = await deps.deleteTask(task.id)
  if (!deleted) return { ok: false, error: `The scheduler did not delete task ${task.id}.` }
  return { ok: true, action: "delete", taskId: task.id, name: task.name }
}

/** `run_scheduled_task` — the user approves each call; `script` tasks are refused. */
export async function runScheduledTask(
  args: TaskIdArgs,
  deps: SchedulerToolDeps
): Promise<SchedulerToolResult> {
  const refused = await refuseWhenAgentToolsDisabled(deps)
  if (refused) return refused
  if (!nonEmpty(args.taskId)) return { ok: false, error: "taskId is required" }
  const task = await findTask(deps, args.taskId)
  if (!task) {
    return { ok: false, error: `No scheduled task with id ${args.taskId}. List the tasks first.` }
  }
  if (AGENT_UNRUNNABLE_TYPES.has(task.type)) {
    return {
      ok: false,
      reason: "script-task",
      error: `"${task.name}" is a ${task.type} task. Agents cannot run those; the user can run it from the scheduler panel.`,
    }
  }
  const execution = await deps.runTaskNow(task.id, { triggerSource: "run-now" })
  if (!execution) return { ok: false, error: `The scheduler did not start task ${task.id}.` }
  return {
    ok: true,
    action: "run",
    taskId: task.id,
    executionId: execution.id,
    status: execution.status,
  }
}

const TASK_ID_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", minLength: 1, description: "Target task id (from list)." },
  },
  required: ["taskId"],
  additionalProperties: false,
} as const

/** The three tools, bound to their dependencies. */
export function createSchedulerTools(deps: SchedulerToolDeps) {
  const guard = async (fn: () => Promise<SchedulerToolResult>): Promise<SchedulerToolResult> => {
    try {
      return await fn()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return [
    definePluginTool({
      name: MANAGE_TOOL,
      definition: {
        name: MANAGE_TOOL,
        description:
          "List the user's scheduled tasks, or create one to schedule follow-up agent work (chat/agent/skill/goal/plan/agent-team/external-agent) on a cron/interval/once/event trigger. Creation follows the user's scheduler permission policy and may be refused with a reason to relay. Script tasks cannot be created by agents. To delete or run a task use delete_scheduled_task / run_scheduled_task.",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create"] },
            name: { type: "string", description: "Task name (create)" },
            description: { type: "string" },
            taskType: {
              type: "string",
              enum: [...AGENT_CREATABLE_TYPES],
              description: "Task type (create)",
            },
            trigger: {
              type: "object",
              description:
                "Required for create. cron needs cronExpression; interval needs intervalMinutes (>= 1); once needs runAt (future ISO date-time); event needs eventType.",
              properties: {
                type: { type: "string", enum: ["cron", "interval", "once", "event"] },
                cronExpression: { type: "string" },
                intervalMinutes: { type: "number", minimum: 1 },
                runAt: { type: "string", description: "ISO date-time (once)" },
                eventType: { type: "string" },
                timezone: { type: "string", description: "IANA time zone, e.g. Asia/Shanghai" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            payload: {
              type: "object",
              description:
                "Task payload, e.g. { planId } for plan, { teamId } for agent-team, { objective } for goal, { prompt, characterId } for agent.",
              additionalProperties: true,
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      execute: (args: Record<string, unknown>, callCtx: PluginToolContext) =>
        guard(() =>
          runSchedulerToolAction(args as unknown as ManageScheduledTaskArgs, deps, {
            ...(callCtx.sessionId ? { sessionId: callCtx.sessionId } : {}),
          })
        ),
    }),
    definePluginTool({
      name: DELETE_TOOL,
      definition: {
        name: DELETE_TOOL,
        description:
          "Delete one of the user's scheduled tasks by id. The user is asked to approve every call.",
        requiresApproval: true,
        parametersSchema: TASK_ID_SCHEMA,
      },
      execute: (args: Record<string, unknown>) =>
        guard(() => deleteScheduledTask(args as TaskIdArgs, deps)),
    }),
    definePluginTool({
      name: RUN_TOOL,
      definition: {
        name: RUN_TOOL,
        description:
          "Run one of the user's scheduled tasks now, out of band from its trigger. The user is asked to approve every call. Script tasks cannot be run by agents.",
        requiresApproval: true,
        // A task run can be a whole agent / team / goal turn.
        timeoutMs: 600_000,
        parametersSchema: TASK_ID_SCHEMA,
      },
      execute: (args: Record<string, unknown>) =>
        guard(() => runScheduledTask(args as TaskIdArgs, deps)),
    }),
  ]
}

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    // The Bot handler is a MODULE EXPORT the bots bridge resolves by name, so
    // it cannot be handed the context the way a tool's `execute` closure is.
    // `BotRunContextV1` carries no `PluginContext` on purpose: the same shape
    // has to reach a Python handler across stdio, where a live object with
    // methods cannot go. Capturing it here is what a JS handler is left with,
    // and it is released with the activation because a disabled plugin must
    // not keep a live capability handle.
    activeContext = ctx
    ctx.lifecycle.onDispose(() => {
      if (activeContext === ctx) activeContext = null
    }, "cognia-scheduler-tools:active-context")

    const deps = defaultDeps(ctx)
    for (const tool of createSchedulerTools(deps)) ctx.agent.registerTool(tool)
  },
})
