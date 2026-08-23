/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  acknowledgeMobileStepResultChunk,
  beginMobileStepReceipt,
  MOBILE_STEP_TOMBSTONE_MS,
  persistMobileStepResult,
  recoverInterruptedMobileSteps,
  vacuumMobileStepTombstones,
} from "./mobile-step-receipts"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "./schema"

const NOW = 1_700_000_000_000

describe("mobile step receipts", () => {
  beforeEach(async () => {
    activateAccountDatabase("acct-mobile", "host-a")
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase("acct-mobile", "host-a")
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("persists an executing replay guard before allowing native UI", async () => {
    const input = {
      requestId: "rst-1",
      deviceId: "phone-1",
      kind: "action.mobile.camera",
      timeoutAt: NOW + 60_000,
      now: NOW,
      accountId: "acct-mobile",
      targetId: "host-a",
    }
    await expect(beginMobileStepReceipt(input)).resolves.toMatchObject({ execute: true })
    await expect(beginMobileStepReceipt(input)).resolves.toEqual({
      execute: false,
      status: "executing",
    })
  })

  it("turns a process-killed execution into an interrupted result without re-execution", async () => {
    await beginMobileStepReceipt({
      requestId: "rst-crash",
      deviceId: "phone-1",
      kind: "action.mobile.camera",
      timeoutAt: NOW + 60_000,
      now: NOW,
      accountId: "acct-mobile",
      targetId: "host-a",
    })
    const makeChunks = (requestId: string, result: unknown) => [
      { requestId, seq: 0, total: 1, chunk: JSON.stringify(result) },
    ]

    await expect(recoverInterruptedMobileSteps("phone-1", makeChunks, NOW + 1)).resolves.toBe(1)
    await expect(getDb().mobileStepReceipts.get("rst-crash")).resolves.toMatchObject({
      status: "result-pending",
    })
    const [queued] = await getDb().mobileOutboundQueue.toArray()
    expect(queued).toMatchObject({
      command: "workflow_step_result",
      idempotencyKey: "mobile-step-result:rst-crash:0",
    })
    expect(JSON.parse(queued!.payload.chunk as string)).toMatchObject({
      ok: false,
      code: "interrupted",
    })
  })

  it("queues stable result chunks once and erases sensitive content after every ACK", async () => {
    await beginMobileStepReceipt({
      requestId: "rst-result",
      deviceId: "phone-1",
      kind: "action.mobile.camera",
      timeoutAt: NOW + 60_000,
      now: NOW,
      accountId: "acct-mobile",
      targetId: "host-a",
    })
    const chunks = [
      { requestId: "rst-result", seq: 0, total: 2, chunk: '{"ok":true,"output":"' },
      { requestId: "rst-result", seq: 1, total: 2, chunk: 'secret"}' },
    ]
    await persistMobileStepResult("rst-result", chunks, NOW + 1)
    await persistMobileStepResult("rst-result", chunks, NOW + 2)
    expect(await getDb().mobileOutboundQueue.count()).toBe(2)

    await expect(acknowledgeMobileStepResultChunk("rst-result", 0, NOW + 3)).resolves.toBe(false)
    expect((await getDb().mobileStepReceipts.get("rst-result"))?.resultJson).toContain("secret")
    await expect(acknowledgeMobileStepResultChunk("rst-result", 1, NOW + 4)).resolves.toBe(true)
    const tombstone = await getDb().mobileStepReceipts.get("rst-result")
    expect(tombstone).toMatchObject({
      status: "acknowledged",
      expiresAt: NOW + 4 + MOBILE_STEP_TOMBSTONE_MS,
    })
    expect(tombstone).not.toHaveProperty("resultJson")
    expect(tombstone).not.toHaveProperty("acknowledgedChunks")
  })

  it("removes only expired acknowledged tombstones", async () => {
    await getDb().mobileStepReceipts.bulkPut([
      {
        requestId: "expired",
        deviceId: "phone-1",
        accountId: "acct-mobile",
        targetId: "host-a",
        kind: "action.mobile.location",
        status: "acknowledged",
        createdAt: NOW,
        updatedAt: NOW,
        timeoutAt: NOW,
        expiresAt: NOW,
      },
      {
        requestId: "live",
        deviceId: "phone-1",
        accountId: "acct-mobile",
        targetId: "host-a",
        kind: "action.mobile.location",
        status: "acknowledged",
        createdAt: NOW,
        updatedAt: NOW,
        timeoutAt: NOW,
        expiresAt: NOW + 1,
      },
    ])
    await expect(vacuumMobileStepTombstones(NOW)).resolves.toBe(1)
    await expect(getDb().mobileStepReceipts.get("live")).resolves.toBeDefined()
  })
})
