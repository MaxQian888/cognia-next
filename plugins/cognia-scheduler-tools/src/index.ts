/**
 * Scheduler Tools — built-in plugin.
 *
 * Registers a `manage_scheduled_task` agent tool so an in-chat agent can
 * create / list / cancel / run scheduled tasks during a turn (closing the
 * agent → scheduler half of the interconnection: the scheduler can already
 * drive agents via the agent-team / goal / plan executors).
 *
 * The tool executes in the renderer (via the plugin-tool IPC round-trip), so
 * it can reach the Dexie-backed scheduler store directly. Every create is
 * gated by the `SchedulerPermissionPolicy` (ADR-style): agents cannot create
 * tasks unless `agentAutoCreate` is on, `script` tasks need
 * `scriptTasksEnabled`, and any type in `confirmationRequired` returns a
 * `needsConfirmation` result instead of silently creating.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskType,
  SchedulerPermissionPolicy,
  TaskExecution,
  TaskExecutionTriggerSource,
  TaskTrigger,
} from "@cognia/plugin-sdk"
/** Task types an agent is allowed to schedule (never raw "script" by default). */
const AGENT_CREATABLE_TYPES: ScheduledTaskType[] = [
  "chat",
  "agent",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
  "script",
]

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

export interface ManageScheduledTaskArgs {
  action: "create" | "list" | "cancel" | "run"
  // create
  name?: string
  description?: string
  taskType?: ScheduledTaskType
  trigger?: {
    type: "cron" | "interval" | "once" | "event"
    cronExpression?: string
    intervalMinutes?: number
    runAt?: string
    eventType?: string
    timezone?: string
  }
  payload?: Record<string, unknown>
  // cancel / run
  taskId?: string
}

export type ManageScheduledTaskResult =
  | { ok: true; action: string; [k: string]: unknown }
  | { ok: false; error?: string; needsConfirmation?: boolean; message?: string }

function buildTrigger(input: NonNullable<ManageScheduledTaskArgs["trigger"]>): TaskTrigger {
  const trigger: TaskTrigger = { type: input.type }
  if (input.timezone) trigger.timezone = input.timezone
  switch (input.type) {
    case "cron":
      trigger.cronExpression = input.cronExpression ?? "0 9 * * *"
      break
    case "interval":
      trigger.intervalMs = Math.max(1, input.intervalMinutes ?? 60) * 60_000
      break
    case "once":
      trigger.runAt = input.runAt ? new Date(input.runAt) : new Date(Date.now() + 60_000)
      break
    case "event":
      trigger.eventType = input.eventType ?? "custom"
      break
  }
  return trigger
}

/**
 * Core action handler — pure aside from the injected deps, so it is unit
 * testable without the plugin runtime or the real store.
 */
export async function runSchedulerToolAction(
  args: ManageScheduledTaskArgs,
  deps: SchedulerToolDeps
): Promise<ManageScheduledTaskResult> {
  switch (args.action) {
    case "list": {
      const tasks = (await deps.listTasks()).map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        status: t.status,
        nextRunAt: t.nextRunAt ?? null,
        trigger: t.trigger.type,
      }))
      return { ok: true, action: "list", count: tasks.length, tasks }
    }

    case "cancel": {
      if (!args.taskId) return { ok: false, error: "taskId is required for cancel" }
      const deleted = await deps.deleteTask(args.taskId)
      return { ok: true, action: "cancel", taskId: args.taskId, deleted }
    }

    case "run": {
      if (!args.taskId) return { ok: false, error: "taskId is required for run" }
      const execution = await deps.runTaskNow(args.taskId, { triggerSource: "run-now" })
      return { ok: true, action: "run", taskId: args.taskId, executionId: execution?.id ?? null }
    }

    case "create": {
      const policy = await deps.getPolicy()
      if (!policy.agentAutoCreate) {
        return {
          ok: false,
          needsConfirmation: true,
          message:
            "Agent task creation is disabled. Ask the user to enable it in Settings → Scheduler (agentAutoCreate), or to create the task manually.",
        }
      }
      const name = args.name?.trim()
      if (!name) return { ok: false, error: "name is required for create" }
      const taskType = args.taskType
      if (!taskType || !AGENT_CREATABLE_TYPES.includes(taskType)) {
        return {
          ok: false,
          error: `unsupported or missing taskType for agent creation: ${taskType}`,
        }
      }
      if (taskType === "script" && !policy.scriptTasksEnabled) {
        return { ok: false, error: "script tasks are disabled by the scheduler policy" }
      }
      if (policy.confirmationRequired.includes(taskType)) {
        return {
          ok: false,
          needsConfirmation: true,
          message: `Creating a "${taskType}" task requires explicit user confirmation. Present the proposed task to the user and ask them to confirm.`,
        }
      }
      const existing = (await deps.listTasks()).length
      if (existing >= policy.maxTasksPerSource) {
        return {
          ok: false,
          error: `task limit reached (${policy.maxTasksPerSource}); delete an existing task first`,
        }
      }
      if (!args.trigger) return { ok: false, error: "trigger is required for create" }

      const input: CreateScheduledTaskInput = {
        name,
        description: args.description?.trim() || undefined,
        type: taskType,
        trigger: buildTrigger(args.trigger),
        payload: args.payload ?? {},
      }
      const created = await deps.createTask(input)
      if (!created) return { ok: false, error: "task creation failed" }
      return { ok: true, action: "create", taskId: created.id, name: created.name }
    }

    default:
      return { ok: false, error: `unknown action: ${String((args as { action?: string }).action)}` }
  }
}

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-scheduler-tools",
    name: "Scheduler Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "scheduler"],
    permissions: ["settings:read", "database:read", "database:write", "agent:control"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("scheduler-tools activated")
    ctx.agent?.registerTool?.({
      name: "manage_scheduled_task",
      pluginId: ctx.pluginId,
      definition: {
        name: "manage_scheduled_task",
        description:
          "Create, list, cancel, or run a scheduled task. Use to schedule follow-up agent work (chat/agent/skill/goal/plan/agent-team/external-agent) on a cron/interval/once/event trigger, or to inspect and manage existing schedules. Creation is gated by the scheduler permission policy and may return needsConfirmation.",
        parametersSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list", "cancel", "run"] },
            name: { type: "string", description: "Task name (create)" },
            description: { type: "string" },
            taskType: {
              type: "string",
              enum: AGENT_CREATABLE_TYPES,
              description: "Task type (create)",
            },
            trigger: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["cron", "interval", "once", "event"] },
                cronExpression: { type: "string" },
                intervalMinutes: { type: "number" },
                runAt: { type: "string", description: "ISO datetime (once)" },
                eventType: { type: "string" },
                timezone: { type: "string" },
              },
              required: ["type"],
            },
            payload: {
              type: "object",
              description:
                "Task payload, e.g. { planId } for plan, { teamId } for agent-team, { objective } for goal, { prompt, characterId } for agent.",
              additionalProperties: true,
            },
            taskId: { type: "string", description: "Target task id (cancel / run)" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      } as never,
      execute: async (rawArgs: unknown) => {
        try {
          const deps = defaultDeps(ctx)
          return await runSchedulerToolAction(rawArgs as ManageScheduledTaskArgs, deps)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
  deactivate: async () => {
    // Tools are unregistered by the runtime on deactivate.
  },
}

export default definition
