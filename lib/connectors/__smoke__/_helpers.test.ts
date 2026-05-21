/**
 * @jest-environment jsdom
 *
 * Coverage for the smoke-suite helpers. Sibling `*.smoke.test.ts` files
 * exercise the helpers end-to-end against the real Dexie schema; this spec
 * keeps a co-located unit test so the row factory and reset routine carry
 * their own contract assertions without depending on a full pipeline run.
 */

import "fake-indexeddb/auto"
import { makeAdapterRow, resetSmokeState } from "./_helpers"
import { getDb } from "@/lib/db/schema"

describe("makeAdapterRow", () => {
  it("fills sensible defaults for every required AdapterInstanceRow column", () => {
    const row = makeAdapterRow({ id: "a-1", type: "slack" })
    expect(row.id).toBe("a-1")
    expect(row.type).toBe("slack")
    expect(row.displayName).toBe("slack-test")
    expect(row.enabled).toBe(true)
    expect(row.transportMode).toBe("gateway")
    expect(row.settings).toEqual({})
    expect(row.credentialsRef).toEqual({ keyringService: "x", accounts: [] })
    expect(row.defaultMode).toBe("auto")
    expect(row.createdAt).toBe(0)
    expect(row.updatedAt).toBe(0)
  })

  it("derives displayName from the supplied type when no override is given", () => {
    const row = makeAdapterRow({ id: "b-1", type: "discord" })
    expect(row.displayName).toBe("discord-test")
  })

  it("respects caller-supplied overrides without losing required fields", () => {
    const row = makeAdapterRow({
      id: "c-1",
      type: "lark",
      displayName: "Custom Lark Bot",
      enabled: false,
      settings: { custom: 1 },
      transportMode: "webhook",
      createdAt: 100,
      updatedAt: 200,
    })
    expect(row.id).toBe("c-1")
    expect(row.type).toBe("lark")
    expect(row.displayName).toBe("Custom Lark Bot")
    expect(row.enabled).toBe(false)
    expect(row.settings).toEqual({ custom: 1 })
    expect(row.transportMode).toBe("webhook")
    expect(row.createdAt).toBe(100)
    expect(row.updatedAt).toBe(200)
  })
})

describe("resetSmokeState", () => {
  it("deletes the live Dexie instance and clears the cached handle", async () => {
    const before = getDb()
    await resetSmokeState()
    const after = getDb()
    // __resetDbForTesting() nulls the cached singleton, so `getDb()` after
    // reset must return a fresh instance, not the one we held a reference to
    // before the reset.
    expect(after).not.toBe(before)
  })

  it("can be called twice without throwing (first call may race the lazy init)", async () => {
    await expect(resetSmokeState()).resolves.toBeUndefined()
    await expect(resetSmokeState()).resolves.toBeUndefined()
  })

  it("swallows a thrown delete() and still nulls the cached singleton", async () => {
    const live = getDb()
    const deleteSpy = jest.spyOn(live, "delete").mockRejectedValueOnce(new Error("simulated race"))
    try {
      await expect(resetSmokeState()).resolves.toBeUndefined()
      // Even when delete() rejects, __resetDbForTesting() runs so the next
      // getDb() returns a fresh instance.
      expect(getDb()).not.toBe(live)
    } finally {
      deleteSpy.mockRestore()
    }
  })
})
