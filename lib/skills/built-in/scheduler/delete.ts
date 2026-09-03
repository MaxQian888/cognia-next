/**
 * `schedule.delete`: remove a task and its run history.
 *
 * `mutation: "destructive"` and `imAccess: "opt-in"`, so a channel has to name
 * this skill in `allowedBuiltInSkillIds` before the assistant can reach it at
 * all, and the confirm card is never skippable.
 *
 * The reason for the stricter tier is that this is the only irreversible verb
 * in the family. A schedule the user spent time configuring, together with the
 * history that shows whether it was working, does not come back. Anything the
 * user phrases as "stop" or "pause" should go to `schedule.set_status`.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { requireTask, resolveTaskWrite } from "./_core"

const schema = z.object({
  taskId: z.string().min(1).describe("Task id from scheduler_list_tasks."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.delete",
  family: "schedule",
  label: { en: "Delete a scheduled task", "zh-CN": "删除定时任务" },
  description: {
    en: "Permanently remove a scheduled task and its run history. This cannot be undone. When the user says 'stop' or 'pause' rather than 'delete', use scheduler_set_task_status instead.",
    "zh-CN":
      "永久删除一个定时任务及其运行历史，不可撤销。用户说的是「停一下」或「暂停」而不是「删除」时，改用 scheduler_set_task_status。",
  },
  platforms: "any",
  mutation: "destructive",
  imAccess: "opt-in",
  mcpToolName: "scheduler_delete_task",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const task = await requireTask(args.taskId)
    await resolveTaskWrite({ taskType: task.type, sessionId: ctx.sessionId })

    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const deleted = await getTaskScheduler().deleteTask(args.taskId)
    if (!deleted) throw new Error(`No scheduled task with id ${args.taskId} to delete.`)
    return { status: "deleted", taskId: args.taskId, name: task.name }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_delete_${Date.now().toString(36)}`,
      title: "Delete a scheduled task",
      summary: `Permanently delete ${args.taskId} and its run history. This cannot be undone.`,
      confirmLabel: "Delete",
    }),
}

registerBuiltInSkill(skill)
