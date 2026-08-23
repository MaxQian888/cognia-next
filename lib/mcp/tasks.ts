import type { McpClientLike } from "./transport"

export type McpDurableJobStatus =
  "running" | "awaiting_input" | "succeeded" | "failed" | "cancelled"

interface McpWireTask {
  taskId: string
  status: "working" | "input_required" | "completed" | "failed" | "cancelled"
  ttl: number | null
  createdAt: string
  lastUpdatedAt: string
  pollInterval?: number
  statusMessage?: string
}

export interface McpDurableJob {
  id: string
  status: McpDurableJobStatus
  expiresAt?: string
  createdAt: string
  updatedAt: string
  pollIntervalMs?: number
  message?: string
  provider: "mcp"
}

interface TaskSchemas {
  ListTasksResultSchema: unknown
  GetTaskResultSchema: unknown
  CancelTaskResultSchema: unknown
  GetTaskPayloadResultSchema: unknown
}

async function loadTaskSchemas(): Promise<TaskSchemas> {
  return import("@modelcontextprotocol/core")
}

function requireRequest(client: McpClientLike): NonNullable<McpClientLike["request"]> {
  if (!client.request) throw new Error("Connected MCP client does not support task requests")
  return client.request.bind(client)
}

function toExpiresAt(task: McpWireTask): string | undefined {
  if (task.ttl === null || task.ttl <= 0) return undefined
  const base = Date.parse(task.lastUpdatedAt)
  return Number.isFinite(base) ? new Date(base + task.ttl).toISOString() : undefined
}

export function projectMcpTask(task: McpWireTask): McpDurableJob {
  const status: Record<McpWireTask["status"], McpDurableJobStatus> = {
    working: "running",
    input_required: "awaiting_input",
    completed: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
  }
  return {
    id: task.taskId,
    status: status[task.status],
    createdAt: task.createdAt,
    updatedAt: task.lastUpdatedAt,
    provider: "mcp",
    ...(toExpiresAt(task) ? { expiresAt: toExpiresAt(task) } : {}),
    ...(task.pollInterval !== undefined ? { pollIntervalMs: task.pollInterval } : {}),
    ...(task.statusMessage ? { message: task.statusMessage } : {}),
  }
}

export async function listMcpTasks(
  client: McpClientLike,
  cursor?: string
): Promise<{ jobs: McpDurableJob[]; nextCursor?: string }> {
  const schemas = await loadTaskSchemas()
  const result = await requireRequest(client)<{ tasks: McpWireTask[]; nextCursor?: string }>(
    { method: "tasks/list", ...(cursor ? { params: { cursor } } : {}) },
    schemas.ListTasksResultSchema
  )
  return {
    jobs: result.tasks.map(projectMcpTask),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  }
}

export async function getMcpTask(client: McpClientLike, taskId: string): Promise<McpDurableJob> {
  const schemas = await loadTaskSchemas()
  const result = await requireRequest(client)<McpWireTask>(
    { method: "tasks/get", params: { taskId } },
    schemas.GetTaskResultSchema
  )
  return projectMcpTask(result)
}

export async function cancelMcpTask(client: McpClientLike, taskId: string): Promise<McpDurableJob> {
  const schemas = await loadTaskSchemas()
  const result = await requireRequest(client)<McpWireTask>(
    { method: "tasks/cancel", params: { taskId } },
    schemas.CancelTaskResultSchema
  )
  return projectMcpTask(result)
}

export async function getMcpTaskResult(client: McpClientLike, taskId: string): Promise<unknown> {
  const schemas = await loadTaskSchemas()
  return requireRequest(client)(
    { method: "tasks/result", params: { taskId } },
    schemas.GetTaskPayloadResultSchema
  )
}
