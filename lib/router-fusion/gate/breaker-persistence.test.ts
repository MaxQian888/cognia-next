import { __resetBreakerForTesting, getBreakerSnapshot, recordFusionFault } from "./breaker"
import {
  rearmRouterFusionSurface,
  startBreakerPersistence,
  type PersistedTrips,
} from "./breaker-persistence"

function harness(initial: PersistedTrips = {}) {
  let trips: PersistedTrips = initial
  const writeTrips = jest.fn(async (next: PersistedTrips) => {
    trips = next
  })
  const notifyTripped = jest.fn()
  return {
    deps: { readTrips: () => trips, writeTrips, notifyTripped },
    trips: () => trips,
    writeTrips,
    notifyTripped,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("breaker persistence", () => {
  afterEach(() => __resetBreakerForTesting())

  it("[ACC:ISO-02] persists a trip, tells the user, and keeps it across a restart", async () => {
    const h = harness()
    const stop = startBreakerPersistence(h.deps)
    recordFusionFault("chat", "db_unavailable", 2, 100)
    expect(h.writeTrips).not.toHaveBeenCalled()
    recordFusionFault("chat", "db_unavailable", 2, 200)
    await flush()
    expect(h.trips()).toEqual({ chat: { trippedAt: 200, reason: "db_unavailable" } })
    expect(h.notifyTripped).toHaveBeenCalledWith("chat", {
      trippedAt: 200,
      reason: "db_unavailable",
    })
    stop()

    // A new window: memory is empty, the persisted trip comes back.
    __resetBreakerForTesting()
    startBreakerPersistence(h.deps)
    expect(getBreakerSnapshot("chat").trip).toEqual({ trippedAt: 200, reason: "db_unavailable" })
  })

  it("[ACC:ISO-02] re-arming clears the breaker and the persisted trip, including a hydrated one", async () => {
    const h = harness({
      chat: { trippedAt: 5, reason: "import_failed" },
      utilityLedger: { trippedAt: 6, reason: "internal" },
    })
    startBreakerPersistence(h.deps)
    await rearmRouterFusionSurface("chat", h.deps)
    await flush()
    expect(getBreakerSnapshot("chat").trip).toBeNull()
    expect(h.trips()).toEqual({ utilityLedger: { trippedAt: 6, reason: "internal" } })
  })

  it("does not write when re-arming a surface that was never tripped", async () => {
    const h = harness()
    await rearmRouterFusionSurface("chat", h.deps)
    expect(h.writeTrips).not.toHaveBeenCalled()
  })

  it("serializes writes so back-to-back trips on two surfaces both persist", async () => {
    const h = harness()
    let release!: () => void
    h.writeTrips.mockImplementationOnce(
      (next: PersistedTrips) =>
        new Promise<void>((resolve) => {
          release = () => {
            h.deps.readTrips = () => next
            resolve()
          }
        })
    )
    startBreakerPersistence(h.deps)
    recordFusionFault("chat", "db_unavailable", 1, 1)
    recordFusionFault("utilityLedger", "db_transaction", 1, 2)
    await flush()
    release()
    await flush()
    await flush()
    expect(h.writeTrips).toHaveBeenLastCalledWith({
      chat: { trippedAt: 1, reason: "db_unavailable" },
      utilityLedger: { trippedAt: 2, reason: "db_transaction" },
    })
  })

  it("never lets a failed write escape into the send that tripped the breaker", async () => {
    const h = harness()
    h.writeTrips.mockRejectedValueOnce(new Error("quota"))
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    startBreakerPersistence(h.deps)
    expect(() => recordFusionFault("chat", "db_unavailable", 1, 1)).not.toThrow()
    await flush()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
