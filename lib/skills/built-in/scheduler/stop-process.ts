/**
 * `schedule.stop_process`: kill an OS process a scheduled task started.
 *
 * Distinct from `schedule.cancel_run`, and the distinction is not a nicety.
 * A `background-command` execution finishes in milliseconds because its job is
 * to START the process, so by the time anyone wants the command stopped there
 * is no run left to cancel. `cancel_run` on it would report "already-finished"
 * while the build kept going. This is the verb that actually reaches the
 * process.
 *
 * The kill goes to the whole process group. `crates/cognia-jobs` spawns into
 * its own group (`setsid` on Unix, `CREATE_NEW_PROCESS_GROUP` on Windows)
 * exactly so a scheduled `pnpm build` does not strand its children.
 *
 * `mutation: "destructive"`. Unlike stopping a scheduled run, this ends a
 * process mid-write with a signal, and whatever it was part-way through
 * doing stays part-way done. There is no cancelled-run record to inspect
 * afterwards and no way to resume, so it is the one verb in the family
 * besides `delete` that is gated on a channel opt-in.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { requireTask, resolveTaskWrite } from "./_core"

const schema = z.object({
  taskId: z.string().min(1).describe("Task that owns the process, from scheduler_list_tasks."),
  processId: z
    .string()
    .min(1)
    .describe(
      "Job or monitor id from the `processes` block of scheduler_inspect_task. Not an OS PID."
    ),
  kind: z
    .enum(["job", "monitor"])
    .describe(
      "`job` kills a spawned command and its process group. `monitor` stops a watcher and leaves any job it was watching alone."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.stop_process",
  family: "schedule",
  label: { en: "Stop a process a schedule started", "zh-CN": "停止定时任务启动的进程" },
  description: {
    en: "Kill an OS process (or stop a monitor) that a scheduled background-command or monitor task started, and which is still running after its execution finished. Get the id from the `processes` block of scheduler_inspect_task. Use scheduler_cancel_task_run instead for a task execution that is itself still running.",
    "zh-CN":
      "结束由 background-command 或 monitor 定时任务启动、且在该次执行结束后仍在运行的系统进程（或停止一个监视器）。id 取自 scheduler_inspect_task 的 processes 字段。如果要停的是还在进行中的那次执行，请改用 scheduler_cancel_task_run。",
  },
  platforms: "any",
  mutation: "destructive",
  imAccess: "opt-in",
  mcpToolName: "scheduler_stop_task_process",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const task = await requireTask(args.taskId)
    await resolveTaskWrite({ taskType: task.type, sessionId: ctx.sessionId })

    const { cancelTaskMonitor, killTaskJob, listTaskProcesses, taskTypeSpawnsProcesses } =
      await import("@/lib/scheduler/task-processes")

    if (!taskTypeSpawnsProcesses(task.type)) {
      return {
        status: "not-applicable",
        message: `A "${task.type}" task does not start host processes. Only background-command and monitor tasks do.`,
      }
    }

    // Ownership is verified before the kill rather than trusted from the
    // arguments. Otherwise this verb would kill any job on the host given its
    // id, with the task id as decoration, which is a much wider power than the
    // one it is described as having.
    const processes = await listTaskProcesses({ id: task.id, type: task.type })
    if (!processes.supported) {
      return { status: "unavailable", message: processes.reason }
    }

    const owned =
      args.kind === "job"
        ? processes.jobs.some((job) => job.id === args.processId)
        : processes.monitors.some((monitor) => monitor.id === args.processId)
    if (!owned) {
      return {
        status: "not-found",
        message: `Task ${task.name} owns no ${args.kind} with id ${args.processId}. Use scheduler_inspect_task to list what it is running.`,
      }
    }

    const record =
      args.kind === "job"
        ? await killTaskJob(args.processId)
        : await cancelTaskMonitor(args.processId)

    return {
      status: "stopped",
      taskId: task.id,
      taskName: task.name,
      processId: args.processId,
      kind: args.kind,
      resultStatus: record.status,
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_schedule_stop_proc_${Date.now().toString(36)}`,
      title: args.kind === "job" ? "Kill a running process" : "Stop a monitor",
      summary:
        args.kind === "job"
          ? `Kill ${args.processId} and its child processes, started by task ${args.taskId}. Work in progress is lost.`
          : `Stop monitor ${args.processId}, started by task ${args.taskId}. Anything it watches keeps running.`,
    }),
}

registerBuiltInSkill(skill)
