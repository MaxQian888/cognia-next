/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowDeployment } from "@/types/workflow/deployment"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

import { syncWorkflowDeployments } from "./workflow-deployments"

function deployment(id: string, over: Partial<WorkflowDeployment> = {}): WorkflowDeployment {
  return {
    id,
    accountId: "acct-1",
    workflowId: `wf-${id}`,
    environment: "production" as WorkflowDeployment["environment"],
    versionId: "v1",
    revision: 1,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeTransport(rows: WorkflowDeployment[]): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 3,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncWorkflowDeployments", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("mirrors deployments and lets a disabled-in-place row overwrite the active one", async () => {
    const tx = makeTransport([deployment("d1")])
    const out = await syncWorkflowDeployments(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "workflowDeployments",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect((await getDb().workflowDeployments.get("d1"))?.status).toBe("active")

    await syncWorkflowDeployments(
      makeTransport([deployment("d1", { status: "disabled", updatedAt: 2 })]),
      { since: 1 }
    )
    expect((await getDb().workflowDeployments.get("d1"))?.status).toBe("disabled")
  })
})
