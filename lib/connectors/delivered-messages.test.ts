/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  DELIVERED_LEDGER_NAMESPACE,
  recordDeliveredMessage,
  wasDeliveredByUs,
} from "./delivered-messages"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("delivered-messages ledger", () => {
  it("records a delivered id under the outbound namespace and finds it again", async () => {
    await recordDeliveredMessage("tg-1", "telegram:tg-1:100", "42")
    await expect(wasDeliveredByUs("tg-1", "telegram:tg-1:100", "42")).resolves.toBe(true)
    const rows = await getDb().inboundLedger.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].namespace).toBe(DELIVERED_LEDGER_NAMESPACE)
  })

  it("scopes by conversation — the same id in another chat is not ours", async () => {
    await recordDeliveredMessage("tg-1", "telegram:tg-1:100", "42")
    await expect(wasDeliveredByUs("tg-1", "telegram:tg-1:200", "42")).resolves.toBe(false)
  })

  it("scopes by adapter", async () => {
    await recordDeliveredMessage("tg-1", "telegram:tg-1:100", "42")
    await expect(wasDeliveredByUs("tg-2", "telegram:tg-1:100", "42")).resolves.toBe(false)
  })

  it("does not collide with the inbound namespace", async () => {
    await getDb().inboundLedger.add({
      id: "tg-1:inbound:telegram:tg-1:100#42",
      adapterId: "tg-1",
      namespace: "inbound",
      platformMessageId: "telegram:tg-1:100#42",
      receivedAt: Date.now(),
    })
    await expect(wasDeliveredByUs("tg-1", "telegram:tg-1:100", "42")).resolves.toBe(false)
  })

  it("is idempotent on repeated records", async () => {
    await recordDeliveredMessage("tg-1", "telegram:tg-1:100", "42")
    await recordDeliveredMessage("tg-1", "telegram:tg-1:100", "42")
    expect(await getDb().inboundLedger.count()).toBe(1)
  })

  it("ignores empty ids without touching the ledger", async () => {
    await recordDeliveredMessage("", "telegram:tg-1:100", "42")
    await recordDeliveredMessage("tg-1", "", "42")
    await recordDeliveredMessage("tg-1", "telegram:tg-1:100", "")
    expect(await getDb().inboundLedger.count()).toBe(0)
    await expect(wasDeliveredByUs("", "c", "42")).resolves.toBe(false)
    await expect(wasDeliveredByUs("tg-1", "", "42")).resolves.toBe(false)
    await expect(wasDeliveredByUs("tg-1", "c", "")).resolves.toBe(false)
  })

  it("swallows storage failures on both paths", async () => {
    await getDb().close()
    // With the connection closed Dexie auto-reopens; force a hard failure by
    // deleting the database mid-flight and asserting neither call throws.
    const failing = getDb()
    jest.spyOn(failing.inboundLedger, "add").mockRejectedValueOnce(new Error("boom"))
    await expect(recordDeliveredMessage("tg-1", "telegram:tg-1:100", "42")).resolves.toBeUndefined()
    jest.spyOn(failing.inboundLedger, "where").mockImplementationOnce(() => {
      throw new Error("boom")
    })
    await expect(wasDeliveredByUs("tg-1", "telegram:tg-1:100", "42")).resolves.toBe(false)
  })
})
