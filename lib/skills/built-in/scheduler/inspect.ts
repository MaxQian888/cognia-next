/**
 * `schedule.inspect`: one task, with its recent runs.
 *
 * Separate from `schedule.list` because the run history is the expensive half
 * and is almost never wanted for every task at once. It is also the half that
 * answers "why did this stop working", which needs the terminal reason and the
 * error text, not just a success count.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { requireTask, toAgentVisibleTask } from "./_core"

const schema = z.object({
  taskId: z.string().min(1).describe("Task id from scheduler_list_tasks."),
  runLimit: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(5)
    .describe("How many recent runs to include. 0 for none."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.inspect",
  family: "schedule",
  label: { en: "Inspect a scheduled task", "zh-CN": "查看定时任务详情" },
  description: {
    en: "Full configuration of one scheduled task plus its recent runs, including why each ended. Use this to diagnose a task that is failing or not firing.",
    "zh-CN":
      "查看单个定时任务的完整配置与最近几次运行，含每次的结束原因。用于排查失败或没有按时触发的任务。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "scheduler_inspect_task",
  inputSchema: schema,
  execute: async (args) => {
    const task = await requireTask(args.taskId)
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const runs =
      args.runLimit > 0
        ? await getTaskScheduler().getTaskExecutions(args.taskId, args.runLimit)
        : []
    return {
      task: {
        ...toAgentVisibleTask(task),
        description: task.description,
        payload: task.payload,
        config: task.config,
        notification: task.notification,
        projectId: task.projectId,
      },
      runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
        ...(run.duration !== undefined ? { durationMs: run.duration } : {}),
        ...(run.triggerSource ? { triggerSource: run.triggerSource } : {}),
        // The terminal reason is the field that actually explains a stuck
        // task: "unsupported-on-host", "overlap-skipped", "executor-not-found"
        // all look identical in a plain failure count.
        ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
        ...(run.error ? { error: run.error } : {}),
      })),
    }
  },
}

registerBuiltInSkill(skill)
