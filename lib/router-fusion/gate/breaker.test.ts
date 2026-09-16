import {
  __resetBreakerForTesting,
  getBreakerSnapshot,
  hydrateBreakerTrips,
  isSurfaceTripped,
  rearmSurface,
  recordFusionFault,
  recordFusionSuccess,
  subscribeBreaker,
  type BreakerEvent,
} from "./breaker"

describe("router-fusion runtime breaker", () => {
  beforeEach(() => __resetBreakerForTesting())

  it("[ACC:ISO-02] trips after N consecutive faults and stays tripped until re-armed", () => {
    const events: BreakerEvent[] = []
    subscribeBreaker((event) => events.push(event))
    expect(recordFusionFault("chat", "db_unavailable", 3, 1)).toMatchObject({ tripped: false })
    expect(recordFusionFault("chat", "db_unavailable", 3, 2)).toMatchObject({ tripped: false })
    expect(recordFusionFault("chat", "db_transaction", 3, 3)).toEqual({
      consecutiveFaults: 3,
      tripped: true,
      justTripped: true,
    })
    expect(isSurfaceTripped("chat")).toBe(true)
    expect(isSurfaceTripped("gatewayRuns")).toBe(false)
    // A later fault reports the trip but does not re-announce it.
    expect(recordFusionFault("chat", "internal", 3, 4).justTripped).toBe(false)
    expect(events.filter((e) => e.type === "tripped")).toEqual([
      { type: "tripped", surface: "chat", trip: { trippedAt: 3, reason: "db_transaction" } },
    ])

    rearmSurface("chat")
    expect(isSurfaceTripped("chat")).toBe(false)
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
    expect(events.at(-1)).toEqual({ type: "rearmed", surface: "chat" })
  })

  it("resets the count on success so only consecutive faults trip", () => {
    recordFusionFault("utilityLedger", "internal", 2)
    recordFusionSuccess("utilityLedger")
    expect(recordFusionFault("utilityLedger", "internal", 2).tripped).toBe(false)
    expect(recordFusionFault("utilityLedger", "internal", 2).tripped).toBe(true)
  })

  it("restores persisted trips without clearing live ones", () => {
    hydrateBreakerTrips({ chat: { trippedAt: 42, reason: "import_failed" } })
    expect(getBreakerSnapshot("chat").trip).toEqual({ trippedAt: 42, reason: "import_failed" })
    hydrateBreakerTrips({ chat: { trippedAt: 99, reason: "other" } })
    expect(getBreakerSnapshot("chat").trip?.trippedAt).toBe(42)
    hydrateBreakerTrips(undefined)
    expect(isSurfaceTripped("chat")).toBe(true)
  })

  it("isolates a throwing listener from the fault path", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    subscribeBreaker(() => {
      throw new Error("settings write failed")
    })
    expect(() => recordFusionFault("chat", "internal", 1)).not.toThrow()
    expect(isSurfaceTripped("chat")).toBe(true)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("treats a nonsensical threshold as 1", () => {
    expect(recordFusionFault("companion", "internal", 0).tripped).toBe(true)
  })
})
