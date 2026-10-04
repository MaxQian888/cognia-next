import { describe, expect, it } from "vitest"

import { testEnv } from "../../test/helpers"
import { cancelDeletion, dueDeletions, getDeletion, markPurged, requestDeletion } from "./store"

const T0 = new Date("2026-10-05T00:00:00.000Z")
const days = (n: number) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000)

describe("account deletion store", () => {
  it("starts a cooling-off period and keeps its date when asked again", async () => {
    const first = await requestDeletion(testEnv.DB, "usr_store_a", T0, 7)
    expect(first).toMatchObject({
      status: "pending",
      requestedAt: T0.toISOString(),
      purgeAfter: days(7).toISOString(),
    })
    const again = await requestDeletion(testEnv.DB, "usr_store_a", days(3), 7)
    expect(again.purgeAfter).toBe(days(7).toISOString())
  })

  it("cancels a pending request and can start over", async () => {
    await requestDeletion(testEnv.DB, "usr_store_b", T0, 7)
    expect(await cancelDeletion(testEnv.DB, "usr_store_b", days(1))).toMatchObject({
      status: "cancelled",
    })
    expect(await cancelDeletion(testEnv.DB, "usr_store_b", days(1))).toBeNull()
    const restarted = await requestDeletion(testEnv.DB, "usr_store_b", days(2), 7)
    expect(restarted).toMatchObject({
      status: "pending",
      purgeAfter: days(9).toISOString(),
      cancelledAt: null,
    })
  })

  it("lists only pending requests that are due, oldest first, and marks them purged", async () => {
    await requestDeletion(testEnv.DB, "usr_store_c", T0, 1)
    await requestDeletion(testEnv.DB, "usr_store_d", days(-1), 1)
    await requestDeletion(testEnv.DB, "usr_store_e", T0, 30)
    const due = await dueDeletions(testEnv.DB, days(1), 10)
    expect(due.indexOf("usr_store_d")).toBeLessThan(due.indexOf("usr_store_c"))
    expect(due).not.toContain("usr_store_e")
    await markPurged(testEnv.DB, "usr_store_c", days(1))
    expect(await getDeletion(testEnv.DB, "usr_store_c")).toMatchObject({
      status: "purged",
      purgedAt: days(1).toISOString(),
    })
    // A purged request is not re-opened by a later request.
    expect(await requestDeletion(testEnv.DB, "usr_store_c", days(2), 7)).toMatchObject({
      status: "purged",
    })
  })
})
