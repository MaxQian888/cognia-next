// Session-scoped structured task tools for the ai-sdk core tool path. The
// task graph itself lives in `src/tools/state/tasks.ts`.
//
// Claude Code replaced the legacy, stateless TodoWrite surface with four
// incremental tools: TaskCreate / TaskGet / TaskList / TaskUpdate. Cognia keeps
// TodoWrite for renderer/backward compatibility, while these tools provide
// stable ids, dependency edges, ownership, metadata, and deletion for models
// that need to manage a non-trivial plan over several tool steps.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../../kernel/result.ts"
import { createSessionTaskStore } from "../../state/tasks.ts"

export const SESSION_TASK_TOOL_NAMES = Object.freeze([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
])

const metadataSchema = z.record(z.string(), z.unknown())

export const taskCreateShape = {
  subject: z.string().min(1).describe("Short imperative task title."),
  description: z.string().min(1).describe("Detailed definition of the work and expected outcome."),
  activeForm: z
    .string()
    .min(1)
    .optional()
    .describe('Present-continuous label shown while running (for example, "Running tests").'),
  metadata: metadataSchema
    .optional()
    .describe("Optional structured metadata attached to the task."),
}

export const taskGetShape = {
  taskId: z.string().min(1).describe("Stable id returned by TaskCreate or TaskList."),
}

export const taskUpdateShape = {
  taskId: z.string().min(1).describe("Stable id of the task to update."),
  status: z
    .enum(["pending", "in_progress", "completed", "deleted"])
    .optional()
    .describe('New lifecycle state. Use "deleted" to remove the task.'),
  subject: z.string().min(1).optional().describe("Replacement task title."),
  description: z.string().min(1).optional().describe("Replacement task description."),
  activeForm: z
    .union([z.string().min(1), z.null()])
    .optional()
    .describe("Replacement running label; null clears it."),
  addBlocks: z.array(z.string().min(1)).optional().describe("Task ids this task should block."),
  removeBlocks: z
    .array(z.string().min(1))
    .optional()
    .describe("Task ids this task should stop blocking."),
  addBlockedBy: z
    .array(z.string().min(1))
    .optional()
    .describe("Task ids that must complete before this task can complete."),
  removeBlockedBy: z
    .array(z.string().min(1))
    .optional()
    .describe("Prerequisite task ids to remove."),
  owner: z
    .union([z.string().min(1), z.null()])
    .optional()
    .describe("Optional owner id or name; null clears it."),
  metadata: metadataSchema.optional().describe("Replacement structured metadata."),
}

function jsonResult(value: unknown) {
  return toolText(JSON.stringify(value, null, 2))
}

export function createSessionTaskTools(store = createSessionTaskStore()) {
  const createTool = tool(
    "TaskCreate",
    "Create one session task and return its stable id. Use for multi-step work; create dependencies afterward with TaskUpdate.",
    taskCreateShape,
    async (args) => {
      try {
        const created = store.create(args)
        return jsonResult({ task: { id: created.id, subject: created.subject } })
      } catch (error) {
        return toolError(error, "TaskCreate")
      }
    },
    { alwaysLoad: true }
  )

  const getTool = tool(
    "TaskGet",
    "Get the complete current state of one session task, including dependencies, owner, metadata, and timestamps.",
    taskGetShape,
    async ({ taskId }) => {
      try {
        const task = store.get(taskId)
        if (!task) throw new Error(`task ${taskId} not found`)
        return jsonResult({ task })
      } catch (error) {
        return toolError(error, "TaskGet")
      }
    },
    { alwaysLoad: true }
  )

  const listTool = tool(
    "TaskList",
    "List every task in this Agent session with status and dependency state. Use this to recover task ids and choose the next unblocked task.",
    {},
    async () => jsonResult({ tasks: store.list() }),
    { alwaysLoad: true }
  )

  const updateTool = tool(
    "TaskUpdate",
    "Patch one session task. Supports lifecycle state, details, owner, metadata, dependency edges, and deletion. A blocked task cannot be completed until every prerequisite is completed.",
    taskUpdateShape,
    async (args) => {
      try {
        const task = store.update(args)
        return jsonResult({ task })
      } catch (error) {
        return toolError(error, "TaskUpdate")
      }
    },
    { alwaysLoad: true }
  )

  return [createTool, getTool, listTool, updateTool]
}
