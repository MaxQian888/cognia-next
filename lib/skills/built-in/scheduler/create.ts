/**
 * `schedule.create`: put something on the user's schedule.
 *
 * The write this whole family exists for. The three legacy MCP tools could
 * create a `chat` task on a cron or interval and nothing else, so an agent
 * asked to "run my release checklist squad every Friday" or "kick off that
 * plan tomorrow morning" had no way to do it.
 *
 * `mutation: "write"`, so the dispatcher shows `hitlSurface` and the user
 * presses Confirm before `execute` runs. On top of that the user's
 * `SchedulerPermissionPolicy` is consulted in `resolveTaskWrite`: the card is
 * this skill's own confirmation, the policy is the user's standing rule about
 * whether agents may schedule at all, and both have to say yes.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import {
  describeTrigger,
  payloadSchema,
  resolveTaskWrite,
  taskTypeSchema,
  toAgentVisibleTask,
  toTaskTrigger,
  triggerSchema,
} from "./_core"

const schema = z.object({
  name: z.string().min(1).max(120).describe("Short name shown in the scheduler panel."),
  description: z.string().max(1000).optional().describe("Optional longer note for the user."),
  type: taskTypeSchema,
  trigger: triggerSchema,
  payload: payloadSchema,
  tags: z.array(z.string()).max(10).optional().describe("Optional tags for filtering."),
  paused: z
    .boolean()
    .default(false)
    .describe("Create it paused instead of active. Use when the user wants to review it first."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.create",
  family: "schedule",
  label: { en: "Schedule a task", "zh-CN": "新建定时任务" },
  description: {
    en: "Add a recurring or one-off task to the user's schedule. Can run a chat turn, a named agent, a skill, a goal, an approved plan, a squad, a published workflow, an external ACP agent, an IM message, a shell command, or a backup. Confirm the exact time and what will run with the user before calling this.",
    "zh-CN":
      "在用户的日程上新增一个重复或一次性任务。可以运行一次对话、指定角色、技能、目标、已批准的计划、小队、已发布的工作流、外部 ACP agent、IM 消息、shell 命令或备份。调用前先与用户确认时间和要运行的内容。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "scheduler_create_task",
  inputSchema: schema,
  execute: async (args, ctx) => {
    await resolveTaskWrite({ taskType: args.type, sessionId: ctx.sessionId })
    const trigger = toTaskTrigger(args.trigger)

    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const task = await getTaskScheduler().createTask({
      name: args.name,
      ...(args.description ? { description: args.description } : {}),
      type: args.type,
      trigger,
      payload: args.payload,
      ...(args.tags?.length ? { tags: args.tags } : {}),
      // Provenance, so the panel can show who authored this and the per-source
      // quota can count it. Without the session id the user cannot trace a
      // surprising schedule back to the conversation that created it.
      createdBy: { kind: "agent", sessionId: ctx.sessionId },
      ...(args.paused ? { status: "paused" as const } : {}),
    })

    return {
      status: "created",
      task: toAgentVisibleTask(task),
      // The panel is where the user amends or cancels it. Saying so once here
      // is more useful than the assistant inventing its own phrasing.
      hint: "The user can review, amend or cancel this from the Scheduler panel.",
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_create_${Date.now().toString(36)}`,
      title: "Add to your schedule",
      summary: `Run "${args.name}" ${describeTrigger(args.trigger)}.`,
      details: [
        { label: "Runs", value: args.type },
        ...(args.paused ? [{ label: "Starts", value: "paused, until you enable it" }] : []),
        // The payload is what will actually execute, so it belongs on the card
        // the user is approving. Truncated, because a prompt can be long and a
        // card the user will not read is not a confirmation.
        {
          label: "Details",
          value: JSON.stringify(args.payload).slice(0, 300),
        },
      ],
    }),
}

registerBuiltInSkill(skill)
