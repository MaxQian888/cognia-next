/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import { getDb } from "@/lib/db/schema"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncWorkflowRuns } from "./workflow-runs"

function makeTransport(
  rows: WorkflowRunRow[],
  deleted_ids: string[] = [],
  next_since = 1
): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncWorkflowRuns", () => {
  beforeEach(async () => {
    await getDb().workflowRuns.clear()
  })

  it("calls sync_pull with table=workflowRuns + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncWorkflowRuns(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "workflowRuns",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("persists pulled run rows into the local workflowRuns table", async () => {
    const rows = [
      {
        id: "run-a",
        workflowId: "wf-1",
        status: "running",
        startedAt: 5,
      } as unknown as WorkflowRunRow,
      {
        id: "run-b",
        workflowId: "wf-1",
        status: "succeeded",
        startedAt: 6,
        completedAt: 9,
      } as unknown as WorkflowRunRow,
    ]
    const tx = makeTransport(rows)
    const out = await syncWorkflowRuns(tx, { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
    expect(await getDb().workflowRuns.get("run-b")).toMatchObject({ status: "succeeded" })
  })
})
