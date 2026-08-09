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
import { argsToFlags, buildConfirmSurface, larkAdapterIdFromCtx, runLarkCli } from "./_helpers"

const FAMILY = "lark.task"
const PLATFORMS = ["lark"] as const

// Shared, described params (serialized to the model via manifest.ts).
const taskGuidParam = z
  .string()
  .min(1)
  .describe("Task GUID. Obtain it from lark.task.list_my_tasks or lark.task.create.")
const tasklistGuidParam = z.string().min(1).describe("Tasklist GUID to file the task under.")
const assigneesParam = z
  .array(z.string())
  .describe("Collaborator open_ids (resolve names → open_id via the lark-contact skill first).")

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
  buildArgs?: (args: z.infer<S>) => string[]
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
        args: [
          ...input.subcommand,
          ...(input.buildArgs?.(args) ?? argsToFlags(args as Record<string, unknown>)),
        ],
        confirmed: ctx.hitlBypass === true,
        adapterId: larkAdapterIdFromCtx(ctx),
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
      status: z
        .enum(["pending", "completed", "all"])
        .optional()
        .describe("Filter by completion status (default pending)."),
      pageSize: z.number().int().min(1).max(40).optional().describe("Max tasks to return (1–100)."),
    }),
    subcommand: ["task", "+get-my-tasks"],
    buildArgs: (args) => [
      ...(args.status === "completed"
        ? ["--complete"]
        : args.status === "pending"
          ? ["--complete=false"]
          : []),
      ...argsToFlags({ pageLimit: args.pageSize }),
    ],
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
    schema: z.object({ taskGuid: taskGuidParam }),
    subcommand: ["task", "tasks", "get"],
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
      summary: z.string().min(1).describe("Task title."),
      description: z.string().optional().describe("Optional longer task description."),
      dueTime: z
        .string()
        .optional()
        .describe("Optional due time in RFC3339, e.g. 2026-07-01T17:00:00Z."),
      assignees: assigneesParam.optional(),
      tasklistGuid: z
        .string()
        .optional()
        .describe("Optional tasklist GUID to file the task under."),
    }),
    subcommand: ["task", "+create"],
    buildArgs: (args) =>
      argsToFlags({
        summary: args.summary,
        description: args.description,
        due: args.dueTime,
        assignee: args.assignees?.join(","),
        tasklistId: args.tasklistGuid,
      }),
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
    schema: z.object({ taskGuid: taskGuidParam }),
    subcommand: ["task", "+complete"],
    buildArgs: (args) => argsToFlags({ taskId: args.taskGuid }),
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
      taskGuid: taskGuidParam,
      summary: z.string().optional().describe("New task title."),
      description: z.string().optional().describe("New task description."),
      dueTime: z.string().optional().describe("New due time in RFC3339."),
    }),
    subcommand: ["task", "+update"],
    buildArgs: (args) =>
      argsToFlags({
        taskId: args.taskGuid,
        summary: args.summary,
        description: args.description,
        due: args.dueTime,
      }),
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
      taskGuid: taskGuidParam,
      assignees: assigneesParam.min(1),
    }),
    subcommand: ["task", "+assign"],
    buildArgs: (args) => argsToFlags({ taskId: args.taskGuid, add: args.assignees.join(",") }),
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
      taskGuid: taskGuidParam,
      tasklistGuid: tasklistGuidParam,
    }),
    subcommand: ["task", "+tasklist-task-add"],
    buildArgs: (args) => argsToFlags({ taskId: args.taskGuid, tasklistId: args.tasklistGuid }),
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Add task to tasklist",
    confirmSummary: (args) => ({
      summary: `Add task ${args.taskGuid} to tasklist ${args.tasklistGuid}.`,
    }),
  })
)
