/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

import {
  __resetPendingBotInstallationsForTests,
  hasPendingBotInstallationMutation,
  markPendingBotInstallationMutation,
  pendingBotInstallationIds,
} from "./pending-installations"

function queued(over: Partial<MobileOutboundJobRow> = {}): MobileOutboundJobRow {
  return {
    id: `job_${Math.random().toString(36).slice(2)}`,
    accountId: "acct_1",
    targetId: "tgt_1",
    command: "bot_trigger_set_armed" as MobileOutboundJobRow["command"],
    payload: { installationId: "boti_1", triggerId: "cron", armed: true },
    status: "pending",
    attempts: 0,
    createdAt: 1,
    nextAttemptAt: 0,
    idempotencyKey: "bot-arm:boti_1:cron:1",
    ...over,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetPendingBotInstallationsForTests()
})

describe("the in-memory marker", () => {
  it("covers the window before the queue row is persisted", async () => {
    const release = markPendingBotInstallationMutation("boti_1")
    expect(hasPendingBotInstallationMutation("boti_1")).toBe(true)
    await expect(pendingBotInstallationIds()).resolves.toEqual(new Set(["boti_1"]))
    release()
    expect(hasPendingBotInstallationMutation("boti_1")).toBe(false)
  })

  it("refcounts, so two overlapping writes do not release each other", () => {
    const first = markPendingBotInstallationMutation("boti_1")
    const second = markPendingBotInstallationMutation("boti_1")
    first()
    expect(hasPendingBotInstallationMutation("boti_1")).toBe(true)
    second()
    expect(hasPendingBotInstallationMutation("boti_1")).toBe(false)
  })

  it("ignores a double release", () => {
    const release = markPendingBotInstallationMutation("boti_1")
    release()
    release()
    expect(hasPendingBotInstallationMutation("boti_1")).toBe(false)
  })
})

describe("pendingBotInstallationIds", () => {
  it("reads the durable queue, which is what survives a reload", async () => {
    await getDb().mobileOutboundQueue.put(queued())
    await expect(pendingBotInstallationIds()).resolves.toEqual(new Set(["boti_1"]))
  })

  it.each([["sending"], ["failed"]] as const)("counts a %s row as in flight", async (status) => {
    await getDb().mobileOutboundQueue.put(
      queued({ status: status as MobileOutboundJobRow["status"] })
    )
    await expect(pendingBotInstallationIds()).resolves.toEqual(new Set(["boti_1"]))
  })

  it.each([["sent"], ["deadlettered"], ["rejected"]] as const)(
    "releases the id once the row is %s",
    async (status) => {
      // Once the Host has it, the Host's row is the newer one and must land.
      await getDb().mobileOutboundQueue.put(
        queued({ status: status as MobileOutboundJobRow["status"] })
      )
      await expect(pendingBotInstallationIds()).resolves.toEqual(new Set())
    }
  )

  it("ignores a queued command that is not an installation write", async () => {
    await getDb().mobileOutboundQueue.put(
      queued({ command: "connector_enqueue_outbound" as MobileOutboundJobRow["command"] })
    )
    await expect(pendingBotInstallationIds()).resolves.toEqual(new Set())
  })

  it("ignores a row whose payload names no installation", async () => {
    await getDb().mobileOutboundQueue.put(queued({ payload: { triggerId: "cron" } }))
    await expect(pendingBotInstallationIds()).resolves.toEqual(new Set())
  })

  it("degrades to the memory markers rather than throwing", async () => {
    // A pull that skipped nothing is a flicker. A pull that threw is a table
    // that stops updating.
    const release = markPendingBotInstallationMutation("boti_mem")
    const table = getDb().mobileOutboundQueue
    const original = table.toArray.bind(table)
    table.toArray = (() => Promise.reject(new Error("closed"))) as unknown as typeof table.toArray
    await expect(pendingBotInstallationIds()).resolves.toEqual(new Set(["boti_mem"]))
    table.toArray = original
    release()
  })
})
