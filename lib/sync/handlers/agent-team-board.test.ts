/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { AgentTeamBoardRow } from "@/lib/db/agent-team-board"
import type { Transport } from "@/lib/tauri/transport-types"
import { getDb } from "@/lib/db/schema"

import { syncAgentTeamBoard } from "./agent-team-board"
import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"

function makeTransport(
  rows: AgentTeamBoardRow[],
  deleted_ids: string[] = [],
  next_since = 1
): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

const taskRow = (id: string, updatedAt = 100): AgentTeamBoardRow => ({
  id,
  kind: "task",
  teamId: "team-a",
  title: id,
  description: "",
  status: "pending",
  priority: "normal",
  dependencies: [],
  tags: [],
  order: 0,
  commentCount: 0,
  comments: [],
  attachmentsCount: 0,
  createdAt: updatedAt,
  updatedAt,
})

describe("syncAgentTeamBoard", () => {
  it("calls sync_pull with table=agentTeamBoard + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncAgentTeamBoard(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "agentTeamBoard",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("persists board upserts and applies tombstones", async () => {
    await getDb().agentTeamBoard.put(taskRow("stale-task"))
    const out = await syncAgentTeamBoard(
      makeTransport([taskRow("t1"), taskRow("t2", 120)], ["stale-task"]),
      { since: 0 }
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(3)
    expect(await getDb().agentTeamBoard.get("stale-task")).toBeUndefined()
    expect(await getDb().agentTeamBoard.get("t1")).toBeDefined()
  })
})
