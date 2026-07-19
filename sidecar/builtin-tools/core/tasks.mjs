// Session-scoped structured task tools for the ai-sdk core tool path.
//
// Claude Code replaced the legacy, stateless TodoWrite surface with four
// incremental tools: TaskCreate / TaskGet / TaskList / TaskUpdate. Cognia keeps
// TodoWrite for renderer/backward compatibility, while these tools provide
// stable ids, dependency edges, ownership, metadata, and deletion for models
// that need to manage a non-trivial plan over several tool steps.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"

export const SESSION_TASK_TOOL_NAMES = Object.freeze([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
])

const metadataSchema = z.record(z.string(), z.unknown())
const taskStatusSchema = z.enum(["pending", "in_progress", "completed"])

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

function cloneTask(task) {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  }
}

function unique(values) {
  return [...new Set(values ?? [])]
}

/**
 * Create an isolated task graph for one Agent session.
 *
 * @param {{ now?: () => number }} [options]
 */
export function createSessionTaskStore({ now = Date.now } = {}) {
  const tasks = new Map()
  let nextId = 1

  function requireTask(taskId) {
    const task = tasks.get(String(taskId))
    if (!task) throw new Error(`task ${taskId} not found`)
    return task
  }

  function reaches(graph, startId, targetId) {
    const queue = [String(startId)]
    const seen = new Set()
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === String(targetId)) return true
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(graph.get(id) ?? []))
    }
    return false
  }

  function validateProjectedEdges(task, input, addBlocks, addBlockedBy) {
    const graph = new Map([...tasks.values()].map((entry) => [entry.id, new Set(entry.blocks)]))
    for (const blockedId of unique(input.removeBlocks)) graph.get(task.id)?.delete(blockedId)
    for (const blockerId of unique(input.removeBlockedBy)) graph.get(blockerId)?.delete(task.id)

    const additions = [
      ...addBlocks.map((blockedId) => [task.id, blockedId]),
      ...addBlockedBy.map((blockerId) => [blockerId, task.id]),
    ]
    for (const [blockerId, blockedId] of additions) {
      const blocker = requireTask(blockerId)
      const blocked = requireTask(blockedId)
      if (blocker.id === blocked.id) throw new Error(`task ${blocker.id} cannot depend on itself`)
      if (reaches(graph, blocked.id, blocker.id)) {
        throw new Error(`dependency cycle: task ${blocker.id} cannot block task ${blocked.id}`)
      }
      graph.get(blocker.id).add(blocked.id)
    }
  }

  function create({ subject, description, activeForm, metadata }) {
    const id = String(nextId++)
    const timestamp = now()
    const task = {
      id,
      subject,
      description,
      status: "pending",
      blocks: [],
      blockedBy: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(activeForm ? { activeForm } : {}),
      ...(metadata ? { metadata: { ...metadata } } : {}),
    }
    tasks.set(id, task)
    return cloneTask(task)
  }

  function get(taskId) {
    const task = tasks.get(String(taskId))
    return task ? cloneTask(task) : undefined
  }

  function list() {
    return [...tasks.values()].map(cloneTask)
  }

  function removeEdge(blockerId, blockedId, timestamp) {
    const blocker = tasks.get(String(blockerId))
    const blocked = tasks.get(String(blockedId))
    if (blocker) {
      blocker.blocks = blocker.blocks.filter((id) => id !== String(blockedId))
      blocker.updatedAt = timestamp
    }
    if (blocked) {
      blocked.blockedBy = blocked.blockedBy.filter((id) => id !== String(blockerId))
      blocked.updatedAt = timestamp
    }
  }

  function addEdge(blockerId, blockedId, timestamp) {
    const blocker = requireTask(blockerId)
    const blocked = requireTask(blockedId)
    if (!blocker.blocks.includes(blocked.id)) blocker.blocks.push(blocked.id)
    if (!blocked.blockedBy.includes(blocker.id)) blocked.blockedBy.push(blocker.id)
    blocker.updatedAt = timestamp
    blocked.updatedAt = timestamp
  }

  function remove(task) {
    const timestamp = now()
    for (const blockedId of [...task.blocks]) removeEdge(task.id, blockedId, timestamp)
    for (const blockerId of [...task.blockedBy]) removeEdge(blockerId, task.id, timestamp)
    tasks.delete(task.id)
    return { id: task.id, deleted: true }
  }

  function update(input) {
    const task = requireTask(input.taskId)
    if (input.status === "deleted") return remove(task)

    const addBlocks = unique(input.addBlocks)
    const addBlockedBy = unique(input.addBlockedBy)
    // Validate the entire mutation before changing any edge, so a bad final id
    // cannot leave a half-applied dependency graph.
    validateProjectedEdges(task, input, addBlocks, addBlockedBy)

    if (input.status === "completed") {
      const incomplete = task.blockedBy.filter((id) => tasks.get(id)?.status !== "completed")
      if (incomplete.length > 0) {
        throw new Error(`task ${task.id} is still blocked by task ${incomplete.join(", ")}`)
      }
    }

    const timestamp = now()
    for (const blockedId of unique(input.removeBlocks)) removeEdge(task.id, blockedId, timestamp)
    for (const blockerId of unique(input.removeBlockedBy)) {
      removeEdge(blockerId, task.id, timestamp)
    }
    for (const blockedId of addBlocks) addEdge(task.id, blockedId, timestamp)
    for (const blockerId of addBlockedBy) addEdge(blockerId, task.id, timestamp)

    if (input.status) task.status = input.status
    if (input.subject !== undefined) task.subject = input.subject
    if (input.description !== undefined) task.description = input.description
    if (input.activeForm !== undefined) {
      if (input.activeForm === null) delete task.activeForm
      else task.activeForm = input.activeForm
    }
    if (input.owner !== undefined) {
      if (input.owner === null) delete task.owner
      else task.owner = input.owner
    }
    if (input.metadata !== undefined) task.metadata = { ...input.metadata }
    task.updatedAt = timestamp
    return cloneTask(task)
  }

  return { create, get, list, update }
}

function jsonResult(value) {
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
