/**
 * Lark Task skill family (ADR-0026).
 *
 *   - list_my_tasks      read
 *   - get_task           read
 *   - create             write
 *   - complete           write
 *   - update             write
 *   - assign             write
 *   - add_to_tasklist    write
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillMutation } from "../types"
import type { BuiltInSkillImAccess } from "../types"
import { argsToFlags, buildConfirmSurface, runLarkCli } from "./_helpers"

const FAMILY = "lark.task"
const PLATFORMS = ["lark"] as const

function mk<S extends z.ZodTypeAny>(input: {
  id: string
  mcpToolName: string
  label: { en: string; "zh-CN": string }
  description: { en: string; "zh-CN": string }
  schema: S
  subcommand: readonly string[]
  mutation: BuiltInSkillMutation
  imAccess: BuiltInSkillImAccess
  confirmTitle?: string
  confirmSummary?: (args: z.infer<S>) => {
    summary: string
    details?: { label: string; value: string }[]
  }
}): BuiltInSkill<S> {
  const skill: BuiltInSkill<S> = {
    id: input.id,
    family: FAMILY,
    label: input.label,
    description: input.description,
    platforms: PLATFORMS,
    mutation: input.mutation,
    imAccess: input.imAccess,
    mcpToolName: input.mcpToolName,
    inputSchema: input.schema,
    execute: async (args, ctx) =>
      runLarkCli({
        args: [...input.subcommand, ...argsToFlags(args as Record<string, unknown>)],
        confirmed: ctx.hitlBypass === true,
      }),
  }
  if (input.mutation !== "read") {
    const title = input.confirmTitle ?? input.label.en
    skill.hitlSurface = (args) => {
      const c = input.confirmSummary?.(args) ?? { summary: `${input.label.en}.` }
      return buildConfirmSurface({
        surfaceId: `sfc_${input.id.replace(/\./g, "_")}_${Date.now().toString(36)}`,
        title,
        summary: c.summary,
        details: c.details,
      })
    }
  }
  return skill
}

registerBuiltInSkill(
  mk({
    id: "lark.task.list_my_tasks",
    mcpToolName: "lark_task_list_my_tasks",
    label: { en: "My tasks", "zh-CN": "我的任务" },
    description: {
      en: "List the tasks assigned to the current user, optionally filtered by status.",
      "zh-CN": "列出当前用户的任务，可选按状态过滤。",
    },
    schema: z.object({
      status: z.enum(["pending", "completed", "all"]).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    }),
    subcommand: ["task", "+get-my-tasks"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.task.get_task",
    mcpToolName: "lark_task_get_task",
    label: { en: "Read task", "zh-CN": "读取任务" },
    description: {
      en: "Fetch a single Lark task by id.",
      "zh-CN": "按 id 读取单条 Lark 任务。",
    },
    schema: z.object({ taskGuid: z.string().min(1) }),
    subcommand: ["task", "+get-task"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.task.create",
    mcpToolName: "lark_task_create",
    label: { en: "Create task", "zh-CN": "创建任务" },
    description: {
      en: "Create a Lark task with optional due date and assignees.",
      "zh-CN": "创建 Lark 任务，可选截止时间和协作人。",
    },
    schema: z.object({
      summary: z.string().min(1),
      description: z.string().optional(),
      dueTime: z.string().optional().describe("RFC3339"),
      assignees: z.array(z.string()).optional().describe("Open IDs"),
      tasklistGuid: z.string().optional(),
    }),
    subcommand: ["task", "+create"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Create Lark task",
    confirmSummary: (args) => ({
      summary: `Create task "${args.summary}".`,
      details: [
        ...(args.dueTime ? [{ label: "Due", value: args.dueTime }] : []),
        ...(args.assignees?.length
          ? [{ label: "Assignees", value: args.assignees.join(", ") }]
          : []),
      ],
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.task.complete",
    mcpToolName: "lark_task_complete",
    label: { en: "Complete task", "zh-CN": "完成任务" },
    description: {
      en: "Mark a Lark task as done.",
      "zh-CN": "将 Lark 任务标记为完成。",
    },
    schema: z.object({ taskGuid: z.string().min(1) }),
    subcommand: ["task", "+complete"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Complete task",
    confirmSummary: (args) => ({
      summary: `Mark task ${args.taskGuid} as complete.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.task.update",
    mcpToolName: "lark_task_update",
    label: { en: "Update task", "zh-CN": "更新任务" },
    description: {
      en: "Patch the title, description, or due time of a Lark task.",
      "zh-CN": "更新 Lark 任务的标题、描述或截止时间。",
    },
    schema: z.object({
      taskGuid: z.string().min(1),
      summary: z.string().optional(),
      description: z.string().optional(),
      dueTime: z.string().optional(),
    }),
    subcommand: ["task", "+update"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Update task",
    confirmSummary: (args) => ({
      summary: `Update task ${args.taskGuid}.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.task.assign",
    mcpToolName: "lark_task_assign",
    label: { en: "Assign task", "zh-CN": "分配任务" },
    description: {
      en: "Assign one or more collaborators to a Lark task.",
      "zh-CN": "为 Lark 任务分配协作人。",
    },
    schema: z.object({
      taskGuid: z.string().min(1),
      assignees: z.array(z.string()).min(1).describe("Open IDs"),
    }),
    subcommand: ["task", "+assign"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Assign task",
    confirmSummary: (args) => ({
      summary: `Assign ${args.assignees.length} person(s) to task ${args.taskGuid}.`,
      details: [{ label: "Assignees", value: args.assignees.join(", ") }],
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.task.add_to_tasklist",
    mcpToolName: "lark_task_add_to_tasklist",
    label: { en: "Add to tasklist", "zh-CN": "加入清单" },
    description: {
      en: "Move a Lark task into a given tasklist.",
      "zh-CN": "将 Lark 任务加入指定的任务清单。",
    },
    schema: z.object({
      taskGuid: z.string().min(1),
      tasklistGuid: z.string().min(1),
    }),
    subcommand: ["task", "+add-to-tasklist"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Add task to tasklist",
    confirmSummary: (args) => ({
      summary: `Add task ${args.taskGuid} to tasklist ${args.tasklistGuid}.`,
    }),
  })
)
