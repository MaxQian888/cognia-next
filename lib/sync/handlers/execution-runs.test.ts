/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ExecutionRun } from "@/types/execution/run"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncExecutionRuns } from "./execution-runs"

function makeTransport(rows: ExecutionRun[], nextSince = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids: [], next_since: nextSince })) as never,
    subscribe: jest.fn(() => () => {}) as never,
  }
}

describe("syncExecutionRuns", () => {
  beforeEach(async () => {
    await getDb().executionRuns.clear()
  })

  it("pulls and persists canonical execution summaries", async () => {
    const row: ExecutionRun = {
      id: "execution-run-1",
      kind: "goal",
      sourceId: "goal-1",
      title: "Goal",
      status: "running",
      currentRevision: 1,
      startedAt: 5,
      updatedAt: 7,
    }
    const transport = makeTransport([row], 7)

    const outcome = await syncExecutionRuns(transport, { since: 3 })

    expect(transport.call).toHaveBeenCalledWith("sync_pull", {
      table: "executionRuns",
      since: 3,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(outcome).toEqual({
      ok: true,
      result: { table: "executionRuns", applied: 1, nextSince: 7 },
    })
    expect(await getDb().executionRuns.get(row.id)).toEqual(row)
  })
})
