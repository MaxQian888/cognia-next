/**
 * `schedule.update`: amend a task that already exists.
 *
 * Every field is optional and only the ones supplied are changed, so "move it
 * to 10am" does not require the agent to restate the payload it never saw.
 *
 * `payload` is the exception and is REPLACED wholesale when supplied. Merging
 * it would be worse: a partial merge of a chat payload can leave `prompt` from
 * the old task beside `characterId` from the new one, which is a task the user
 * never asked for and never reviewed.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import {
  describeTrigger,
  payloadSchema,
  requireTask,
  resolveTaskWrite,
  toAgentVisibleTask,
  toTaskTrigger,
  triggerSchema,
} from "./_core"

const schema = z.object({
  taskId: z.string().min(1).describe("Task id from scheduler_list_tasks."),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  trigger: triggerSchema.optional().describe("Replaces the schedule when supplied."),
  payload: payloadSchema
    .optional()
    .describe(
      "REPLACES the whole payload when supplied. Read it with scheduler_inspect_task first."
    ),
  tags: z.array(z.string()).max(10).optional(),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.update",
  family: "schedule",
  label: { en: "Amend a scheduled task", "zh-CN": "修改定时任务" },
  description: {
    en: "Change the name, description, schedule, payload or tags of an existing scheduled task. Only the fields you supply change, except payload, which is replaced whole. Inspect the task first if you intend to change its payload.",
    "zh-CN":
      "修改已有定时任务的名称、说明、触发时间、载荷或标签。只有你传入的字段会变，但 payload 是整体替换。如果要改 payload，先用 scheduler_inspect_task 看一下现有内容。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "scheduler_update_task",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const existing = await requireTask(args.taskId)
    // Gated on the EXISTING type: this skill cannot change a task's type, so
    // that is the type whose host support and policy standing matter.
    await resolveTaskWrite({ taskType: existing.type, sessionId: ctx.sessionId })

    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const updated = await getTaskScheduler().updateTask(args.taskId, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.trigger ? { trigger: toTaskTrigger(args.trigger) } : {}),
      ...(args.payload ? { payload: args.payload } : {}),
      ...(args.tags ? { tags: args.tags } : {}),
    })
    if (!updated) throw new Error(`The scheduler refused the update to ${args.taskId}.`)
    return { status: "updated", task: toAgentVisibleTask(updated) }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_update_${Date.now().toString(36)}`,
      title: "Change a scheduled task",
      summary: `Amend the scheduled task ${args.taskId}.`,
      details: [
        ...(args.name ? [{ label: "New name", value: args.name }] : []),
        ...(args.trigger ? [{ label: "New schedule", value: describeTrigger(args.trigger) }] : []),
        ...(args.payload
          ? [{ label: "Replaces details with", value: JSON.stringify(args.payload).slice(0, 300) }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
