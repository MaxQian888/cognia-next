/**
 * `schedule.set_status`: pause, resume or disable a task.
 *
 * Its own skill rather than a flag on `schedule.update` because it is the one
 * amendment a user asks for conversationally ("stop the morning digest for
 * now"), and because pausing is reversible in a way that editing a payload is
 * not, which is worth a smaller and clearer confirmation card.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { requireTask, resolveTaskWrite, toAgentVisibleTask } from "./_core"

const schema = z.object({
  taskId: z.string().min(1).describe("Task id from scheduler_list_tasks."),
  status: z
    .enum(["active", "paused", "disabled"])
    .describe(
      "active resumes it and recomputes the next run; paused keeps it in the list but stops it firing; disabled is the same but signals the user is done with it."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.set_status",
  family: "schedule",
  label: { en: "Pause or resume a scheduled task", "zh-CN": "暂停或恢复定时任务" },
  description: {
    en: "Pause, resume or disable an existing scheduled task without deleting it. Prefer this over deleting when the user says 'stop' or 'hold off' rather than 'remove'.",
    "zh-CN":
      "暂停、恢复或停用一个已有的定时任务，不删除它。用户说「先停一下」而不是「删掉」时，用这个而不是删除。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "scheduler_set_task_status",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const existing = await requireTask(args.taskId)
    await resolveTaskWrite({ taskType: existing.type, sessionId: ctx.sessionId })

    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const scheduler = getTaskScheduler()
    // `pauseTask` / `resumeTask` rather than writing `status` through
    // `updateTask`: the scheduler owns re-arming, and resuming has to recompute
    // `nextRunAt`. Setting the field directly would leave a resumed task with a
    // next run in the past and hand it straight to the missed-run sweep.
    const ok =
      args.status === "active"
        ? await scheduler.resumeTask(args.taskId)
        : args.status === "paused"
          ? await scheduler.pauseTask(args.taskId)
          : Boolean(await scheduler.updateTask(args.taskId, { status: "disabled" }))
    if (!ok) throw new Error(`The scheduler refused the status change to ${args.taskId}.`)
    // Re-read rather than trusting the requested status: pause and resume
    // return a boolean, and the task the user sees next should be the one that
    // is actually persisted.
    const after = await requireTask(args.taskId)
    return { status: "updated", task: toAgentVisibleTask(after) }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_status_${Date.now().toString(36)}`,
      title: args.status === "active" ? "Resume a scheduled task" : "Stop a scheduled task",
      summary:
        args.status === "active"
          ? `Resume ${args.taskId}. It will start running on its schedule again.`
          : `Set ${args.taskId} to ${args.status}. It stays in your list but stops running.`,
    }),
}

registerBuiltInSkill(skill)
