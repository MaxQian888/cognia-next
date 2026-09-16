import { __resetBreakerForTesting, getBreakerSnapshot, isSurfaceTripped } from "./breaker"
import {
  RouterFusionInfrastructureError,
  RouterFusionRefusalError,
  RouterFusionUnavailableError,
} from "./faults"
import {
  runExplicitFusion,
  runOrdinaryWithFallback,
  trippedSurfaceError,
  type BypassNotice,
} from "./guard"

function dbClosed(): Error {
  const error = new Error("Database has been closed")
  error.name = "DatabaseClosedError"
  return error
}

describe("router-fusion guards", () => {
  beforeEach(() => __resetBreakerForTesting())

  it("[ACC:ISO-01] runs the original path with a notice when the fusion step faults", async () => {
    const notices: BypassNotice[] = []
    const original = jest.fn(async () => "original answer")
    const result = await runOrdinaryWithFallback({
      surface: "chat",
      threshold: 3,
      fusion: async () => {
        throw dbClosed()
      },
      original,
      onBypass: (notice) => notices.push(notice),
    })
    expect(result).toBe("original answer")
    expect(original).toHaveBeenCalledTimes(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ surface: "chat", justTripped: false, consecutiveFaults: 1 })
    expect(notices[0].fault.code).toBe("db_unavailable")
  })

  it("[ACC:ISO-02] trips the surface on the Nth consecutive fault and says so", async () => {
    const notices: BypassNotice[] = []
    const run = () =>
      runOrdinaryWithFallback({
        surface: "chat",
        threshold: 2,
        fusion: async () => {
          throw new RouterFusionInfrastructureError("import_failed", "chunk")
        },
        original: async () => "ok",
        onBypass: (notice) => notices.push(notice),
      })
    await run()
    await run()
    expect(notices.map((n) => n.justTripped)).toEqual([false, true])
    expect(isSurfaceTripped("chat")).toBe(true)
  })

  it("[ACC:ISO-04] rethrows a refusal without touching the original path or the breaker", async () => {
    const original = jest.fn(async () => "never")
    const refusal = new RouterFusionRefusalError("RUN_BUDGET_EXHAUSTED", "no money")
    await expect(
      runOrdinaryWithFallback({
        surface: "chat",
        threshold: 1,
        fusion: async () => {
          throw refusal
        },
        original,
        onBypass: () => undefined,
      })
    ).rejects.toBe(refusal)
    expect(original).not.toHaveBeenCalled()
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
  })

  it("resets the fault count after a success and survives a throwing notice", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    await runOrdinaryWithFallback({
      surface: "chat",
      threshold: 5,
      fusion: async () => {
        throw new Error("boom")
      },
      original: async () => 1,
      onBypass: () => {
        throw new Error("toast failed")
      },
    })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
    await expect(
      runOrdinaryWithFallback({
        surface: "chat",
        threshold: 5,
        fusion: async () => 2,
        original: async () => 1,
        onBypass: () => undefined,
      })
    ).resolves.toBe(2)
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
    spy.mockRestore()
  })

  it("[ACC:ISO-03] fails explicit fusion work explicitly on a fault", async () => {
    await expect(
      runExplicitFusion({
        surface: "gatewayRuns",
        threshold: 3,
        fusion: async () => {
          throw dbClosed()
        },
      })
    ).rejects.toBeInstanceOf(RouterFusionUnavailableError)
    expect(getBreakerSnapshot("gatewayRuns").consecutiveFaults).toBe(1)

    const refusal = new RouterFusionRefusalError("MODE_NOT_ALLOWED", "no")
    await expect(
      runExplicitFusion({
        surface: "gatewayRuns",
        threshold: 3,
        fusion: async () => {
          throw refusal
        },
      })
    ).rejects.toBe(refusal)
    await expect(
      runExplicitFusion({ surface: "gatewayRuns", threshold: 3, fusion: async () => "done" })
    ).resolves.toBe("done")
    expect(getBreakerSnapshot("gatewayRuns").consecutiveFaults).toBe(0)
  })

  it("names the tripped surface in the explicit error", () => {
    const error = trippedSurfaceError("chat")
    expect(error.fault.code).toBe("breaker_tripped")
    expect(error.code).toBe("ROUTER_FUSION_UNAVAILABLE")
  })
})
