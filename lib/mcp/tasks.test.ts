import { cancelMcpTask, getMcpTask, getMcpTaskResult, listMcpTasks, projectMcpTask } from "./tasks"
import type { McpClientLike } from "./transport"

const wireTask = {
  taskId: "task-1",
  status: "working" as const,
  ttl: 5_000,
  createdAt: "2026-08-23T00:00:00.000Z",
  lastUpdatedAt: "2026-08-23T00:00:01.000Z",
  pollInterval: 250,
  statusMessage: "Rendering",
}

function clientWithRequest(request: jest.Mock): McpClientLike {
  return { request } as unknown as McpClientLike
}

describe("MCP durable tasks", () => {
  it("normalizes protocol statuses, TTL and polling metadata", () => {
    expect(projectMcpTask(wireTask)).toEqual({
      id: "task-1",
      status: "running",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      expiresAt: "2026-08-23T00:00:06.000Z",
      pollIntervalMs: 250,
      message: "Rendering",
      provider: "mcp",
    })
    expect(projectMcpTask({ ...wireTask, status: "input_required" }).status).toBe("awaiting_input")
    expect(projectMcpTask({ ...wireTask, status: "completed" }).status).toBe("succeeded")
  })

  it("lists and gets tasks through the standard task methods", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ tasks: [wireTask], nextCursor: "next" })
      .mockResolvedValueOnce(wireTask)
    const client = clientWithRequest(request)

    await expect(listMcpTasks(client, "cursor")).resolves.toMatchObject({
      jobs: [{ id: "task-1", status: "running" }],
      nextCursor: "next",
    })
    await expect(getMcpTask(client, "task-1")).resolves.toMatchObject({ id: "task-1" })
    expect(request.mock.calls[0][0]).toEqual({ method: "tasks/list", params: { cursor: "cursor" } })
    expect(request.mock.calls[1][0]).toEqual({ method: "tasks/get", params: { taskId: "task-1" } })
  })

  it("uses protocol cancellation and result retrieval", async () => {
    const cancelled = { ...wireTask, status: "cancelled" as const }
    const request = jest
      .fn()
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "done" }] })
    const client = clientWithRequest(request)

    await expect(cancelMcpTask(client, "task-1")).resolves.toMatchObject({
      status: "cancelled",
    })
    await expect(getMcpTaskResult(client, "task-1")).resolves.toEqual({
      content: [{ type: "text", text: "done" }],
    })
    expect(request.mock.calls.map(([input]) => input.method)).toEqual([
      "tasks/cancel",
      "tasks/result",
    ])
  })

  it("fails closed when the connected client lacks task support", async () => {
    await expect(listMcpTasks({} as McpClientLike)).rejects.toThrow("does not support task")
  })
})
