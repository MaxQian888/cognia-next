/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"
import { claimNext, enqueue, listByStatus, retryDeadletter } from "./mobile-outbound-queue"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "./schema"

const scope = { accountId: "acct_queue", targetId: "desktop-studio" }

describe("mobile outbound queue target isolation", () => {
  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.targetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.targetId)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("persists the account and runtime target that owned an enqueued action", async () => {
    const row = await enqueue({
      command: "connector_send",
      payload: { text: "hello" },
      ...scope,
    })

    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject(scope)
  })

  it("shows quarantined legacy actions to their account without dispatching them", async () => {
    await getDb().mobileOutboundQueue.put({
      id: "legacy-action",
      accountId: scope.accountId,
      targetId: LEGACY_MIXED_TARGET_ID,
      command: "workflow_trigger_manual",
      payload: { workflowId: "wf-1" },
      status: "deadlettered",
      attempts: 0,
      createdAt: 100,
      nextAttemptAt: 100,
      idempotencyKey: "legacy-key",
      lastError: "Legacy outbound action could not be safely attributed to a runtime target.",
    })

    await expect(listByStatus("deadlettered", scope)).resolves.toEqual([
      expect.objectContaining({ id: "legacy-action" }),
    ])

    await expect(retryDeadletter("legacy-action", 200)).rejects.toThrow(/cannot be retried/i)
    await expect(claimNext(200, scope)).resolves.toBeNull()
  })
})
