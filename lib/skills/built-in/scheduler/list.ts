/**
 * `schedule.list`: what is on the user's schedule.
 *
 * Read-only, so `imAccess: "always"` and no confirm card. This is the tool the
 * assistant needs before it can do anything else: every other skill in the
 * family takes a task id, and there was previously no way to obtain one on
 * the desktop at all.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { AGENT_SCHEDULABLE_TASK_TYPES, toAgentVisibleTask } from "./_core"

const schema = z.object({
  status: z
    .enum(["active", "paused", "disabled", "expired"])
    .optional()
    .describe("Only tasks in this state. Omit for every state."),
  type: z
    .enum(AGENT_SCHEDULABLE_TASK_TYPES)
    .optional()
    .describe("Only tasks of this type. Omit for every type."),
  search: z.string().optional().describe("Case-insensitive match on name and description."),
  limit: z.number().int().min(1).max(100).default(25).describe("Maximum rows to return."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "schedule.list",
  family: "schedule",
  label: { en: "List scheduled tasks", "zh-CN": "列出定时任务" },
  description: {
    en: "List the user's scheduled tasks with their trigger, next run and recent outcome. Use this to find a task id before inspecting, amending, pausing or running one.",
    "zh-CN":
      "列出用户的定时任务，含触发方式、下次运行时间与最近结果。在查看、修改、暂停或立即运行某个任务之前，先用它拿到任务 id。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "scheduler_list_tasks",
  inputSchema: schema,
  execute: async (args) => {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const all = await getTaskScheduler().getAllTasks()
    const needle = args.search?.trim().toLowerCase()
    const matched = all.filter((task) => {
      if (args.status && task.status !== args.status) return false
      if (args.type && task.type !== args.type) return false
      if (!needle) return true
      return (
        task.name.toLowerCase().includes(needle) ||
        (task.description?.toLowerCase().includes(needle) ?? false)
      )
    })
    // Soonest first, then the ones with no next run. A schedule is read to
    // answer "what happens next", so that is the useful order.
    const ordered = [...matched].sort((a, b) => {
      const left = a.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY
      const right = b.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY
      return left - right
    })
    return {
      total: matched.length,
      returned: Math.min(matched.length, args.limit),
      tasks: ordered.slice(0, args.limit).map(toAgentVisibleTask),
    }
  },
}

registerBuiltInSkill(skill)
