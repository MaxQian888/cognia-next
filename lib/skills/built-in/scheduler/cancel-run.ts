/**
 * `schedule.cancel_run`: stop an execution that is running right now.
 *
 * The family shipped with `set_status` as the only way to stop anything, and
 * pausing a task does not touch a run already in flight. So an agent that had
 * just started a long backup, or that had been asked to stop one, could pause
 * the schedule and then watch the run it was asked about continue. There was no
 * verb for it anywhere: the panel's one cancel button reached plugin runs only.
 *
 * `mutation: "write"`, for the mirror of the reason `run_now` is a write. It
 * stores no row of its own, and it causes an effect on the user's machine: an
 * agent turn is abandoned mid-way, a spawned command is signalled. That is not
 * a read.
 *
 * `imAccess: "always"` rather than opt-in like `delete`. Stopping something is
 * the recoverable direction. The run is recorded as cancelled with its logs
 * intact, and the task keeps its schedule and will run again, so the worst
 * outcome is a run the user has to start again with `run_now`.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { requireTask, resolveTaskWrite } from "./_core"

const schema = z.object({
  taskId: z
    .string()
    .min(1)
    .describe("Task the run belongs to, from scheduler_list_tasks. Used to check permission."),
  runId: z
    .string()
    .min(1)
    .describe(
      "Run to stop, from the `runs` list of scheduler_inspect_task. Must still be running."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.cancel_run",
  family: "schedule",
  label: { en: "Stop a running scheduled task", "zh-CN": "停止正在运行的定时任务" },
  description: {
    en: "Stop an execution of a scheduled task that is running right now. The task itself is untouched and will run again at its next scheduled time — use scheduler_set_task_status to pause the schedule instead. Get the run id from scheduler_inspect_task.",
    "zh-CN":
      "停止某个定时任务当前正在进行的一次运行。任务本身不受影响，下次到点仍会运行；要暂停排程请改用 scheduler_set_task_status。run id 从 scheduler_inspect_task 获取。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "scheduler_cancel_task_run",
  inputSchema: schema,
  execute: async (args, ctx) => {
    // The task is loaded first so a bad id is named as such, and so the policy
    // gate is asked about a real task type rather than about a run id that may
    // belong to nothing.
    const task = await requireTask(args.taskId)
    await resolveTaskWrite({ taskType: task.type, sessionId: ctx.sessionId })

    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const outcome = await getTaskScheduler().cancelExecution(args.runId)

    if (outcome.cancelled) {
      return { status: "cancelled", taskId: task.id, taskName: task.name, runId: args.runId }
    }

    // Every refusal is returned rather than thrown, because none of them is an
    // error on the agent's part and each suggests a different next step. A
    // thrown message would read to the model as "the tool broke".
    switch (outcome.reason) {
      case "not-found":
        return {
          status: "not-found",
          runId: args.runId,
          message: `No run with id ${args.runId}. Use scheduler_inspect_task to list this task's runs.`,
        }
      case "already-settled":
        return {
          status: "already-finished",
          runId: args.runId,
          runStatus: outcome.status,
          message: `That run had already finished with status "${outcome.status}". Nothing was changed.`,
        }
      case "requested":
        return {
          status: "requested",
          runId: args.runId,
          message:
            "The run is owned by another window, and the stop request was sent to it. Check scheduler_inspect_task in a moment to see whether it stopped.",
        }
      case "unsupported-on-remote":
        return {
          status: "unsupported",
          runId: args.runId,
          message:
            "This schedule belongs to a paired host, and runs on it cannot be stopped remotely. Ask the user to stop it from the scheduler panel on that machine.",
        }
      default:
        return {
          status: "unreachable",
          runId: args.runId,
          message:
            "The run is recorded as active but nothing here holds it, so it could not be stopped. It may be left over from a previous session.",
        }
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_cancel_${Date.now().toString(36)}`,
      title: "Stop a running scheduled task",
      summary: `Stop run ${args.runId} of task ${args.taskId}. The task keeps its schedule and will run again.`,
    }),
}

registerBuiltInSkill(skill)
