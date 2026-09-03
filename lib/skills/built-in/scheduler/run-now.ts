/**
 * `schedule.run_now`: run a scheduled task immediately.
 *
 * Does not touch the schedule. The task keeps its next run, and this execution
 * is recorded with `triggerSource: "run-now"` so the run history distinguishes
 * it from one the clock started. That distinction is what makes the history
 * usable for "is my cron actually firing".
 *
 * `mutation: "write"` even though nothing is stored, because it CAUSES the
 * task's effects: an `im-push` task sends a message, a `background-command`
 * task runs a command. Classifying it `read` because it writes no row would be
 * exactly the wrong reading of the tier.
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
  id: "schedule.run_now",
  family: "schedule",
  label: { en: "Run a scheduled task now", "zh-CN": "立即运行定时任务" },
  description: {
    en: "Run an existing scheduled task immediately, without changing its schedule. The task's next scheduled run is unaffected. Use this to test a task the user just set up, or to run one early.",
    "zh-CN":
      "立即运行一个已有的定时任务，不改变它的排程，下次触发时间不受影响。用于测试刚建好的任务，或者提前跑一次。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "scheduler_run_task_now",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const task = await requireTask(args.taskId)
    await resolveTaskWrite({ taskType: task.type, sessionId: ctx.sessionId })

    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const run = await getTaskScheduler().runTaskNow(args.taskId, { triggerSource: "run-now" })
    if (!run) throw new Error(`The scheduler did not start ${args.taskId}.`)
    return {
      status: run.status,
      runId: run.id,
      startedAt: run.startedAt.toISOString(),
      ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.output !== undefined ? { output: run.output } : {}),
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_run_${Date.now().toString(36)}`,
      title: "Run a scheduled task now",
      summary: `Run ${args.taskId} immediately. Its normal schedule is unchanged.`,
    }),
}

registerBuiltInSkill(skill)
