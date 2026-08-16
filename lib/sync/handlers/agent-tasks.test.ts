/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import { syncAgentTaskAttempts, syncAgentTasks } from "./agent-tasks"

function transport(rows: unknown[]): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 10,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

beforeEach(async () => {
  await getDb().agentTasks.clear()
  await getDb().agentTaskAttempts.clear()
})

it("mirrors portable Agent task cards", async () => {
  await syncAgentTasks(
    transport([{ id: "task-1", agentId: "agent-1", status: "pending", updatedAt: 10 }]),
    { since: 0 }
  )
  expect((await getDb().agentTasks.get("task-1"))?.agentId).toBe("agent-1")
})

it("mirrors immutable attempt history", async () => {
  await syncAgentTaskAttempts(
    transport([
      { id: "attempt-1", taskId: "task-1", agentId: "agent-1", status: "failed", updatedAt: 10 },
    ]),
    { since: 0 }
  )
  expect((await getDb().agentTaskAttempts.get("attempt-1"))?.status).toBe("failed")
})
