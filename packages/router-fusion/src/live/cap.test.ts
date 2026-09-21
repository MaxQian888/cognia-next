import { DEFAULT_RUN_CAP_USD_BY_MODE } from "../config/builtin-catalog"
import { planRunCreation } from "../ledger/planner"
import {
  assertLiveCapInPlace,
  formatUsd,
  ledgerRefusedOverCap,
  LIVE_SMOKE_BUDGET_MODE,
  LIVE_SMOKE_HARD_CAP_MICROUSD,
  LiveCapError,
  planLiveSmokeCaps,
  remainingTotalMicrousd,
} from "./cap"
import { LIVE_SMOKE_CASES } from "./cases"

function codeOf(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof LiveCapError ? error.code : "not a LiveCapError"
  }
}

describe("live smoke caps", () => {
  it("holds the D20 hard total of $5 and runs every case under a strict budget", () => {
    expect(LIVE_SMOKE_HARD_CAP_MICROUSD).toBe(5_000_000)
    expect(LIVE_SMOKE_BUDGET_MODE).toBe("strict")
  })

  it("plans the shipped cases within the total under the default run caps", () => {
    const plan = planLiveSmokeCaps(LIVE_SMOKE_CASES, DEFAULT_RUN_CAP_USD_BY_MODE)
    expect(plan.cases.map((entry) => [entry.definition.id, entry.capMicrousd])).toEqual([
      ["direct", 400_000],
      ["cascade", 800_000],
      ["panel", 1_600_000],
      ["delegate", 2_000_000],
    ])
    expect(plan.plannedMicrousd).toBe(4_800_000)
    expect(plan.totalCapMicrousd).toBe(5_000_000)
    expect(() => assertLiveCapInPlace(plan)).not.toThrow()
  })

  it("lowers a case to the account's run cap for its mode, never raises it (D22)", () => {
    const plan = planLiveSmokeCaps(LIVE_SMOKE_CASES, {
      ...DEFAULT_RUN_CAP_USD_BY_MODE,
      direct: "0.10",
      panel: "9.00",
    })
    const byId = Object.fromEntries(plan.cases.map((entry) => [entry.definition.id, entry]))
    expect(byId.direct).toMatchObject({
      requestedCapMicrousd: 400_000,
      modeRunCapMicrousd: 100_000,
      capMicrousd: 100_000,
    })
    expect(byId.panel.capMicrousd).toBe(1_600_000)
  })

  it("refuses a plan whose cap is missing, too high, unusable or smaller than its cases", () => {
    const plan = planLiveSmokeCaps(LIVE_SMOKE_CASES, DEFAULT_RUN_CAP_USD_BY_MODE)
    expect(codeOf(() => assertLiveCapInPlace({ ...plan, totalCapMicrousd: 0 }))).toBe(
      "TOTAL_CAP_INVALID"
    )
    expect(codeOf(() => assertLiveCapInPlace({ ...plan, totalCapMicrousd: 1.5 }))).toBe(
      "TOTAL_CAP_INVALID"
    )
    expect(codeOf(() => assertLiveCapInPlace({ ...plan, totalCapMicrousd: 5_000_001 }))).toBe(
      "TOTAL_CAP_ABOVE_HARD_LIMIT"
    )
    expect(
      codeOf(() =>
        assertLiveCapInPlace(
          planLiveSmokeCaps(LIVE_SMOKE_CASES, { ...DEFAULT_RUN_CAP_USD_BY_MODE, cascade: "0" })
        )
      )
    ).toBe("CASE_CAP_INVALID")
    expect(
      codeOf(() =>
        assertLiveCapInPlace(
          planLiveSmokeCaps(LIVE_SMOKE_CASES, DEFAULT_RUN_CAP_USD_BY_MODE, 4_000_000)
        )
      )
    ).toBe("CASE_CAPS_EXCEED_TOTAL")
  })

  it("never lets the remaining total go below zero", () => {
    expect(remainingTotalMicrousd(5_000_000, 1_250_000)).toBe(3_750_000)
    expect(remainingTotalMicrousd(5_000_000, 6_000_000)).toBe(0)
  })

  it("recognizes only the ledger's tenant-budget refusal as proof the cap is in place", () => {
    // The ledger's own planner: a run one microusd over what remains is refused.
    const remaining = 3_000_000
    const probe = planRunCreation(
      { limitRemainingMicrousd: remaining, activeHoldsMicrousd: 0 },
      { capMicrousd: remaining + 1, maxModelCalls: 1 }
    )
    expect(ledgerRefusedOverCap(probe)).toBe(true)
    expect(ledgerRefusedOverCap({ ok: true })).toBe(false)
    expect(ledgerRefusedOverCap({ ok: false, code: "SESSION_BUSY" })).toBe(false)
    // No tenant limit at all: the same run is created — the cap would not be in place.
    const unlimited = planRunCreation(
      { limitRemainingMicrousd: null, activeHoldsMicrousd: 0 },
      { capMicrousd: remaining + 1, maxModelCalls: 1 }
    )
    expect(ledgerRefusedOverCap(unlimited)).toBe(false)
  })

  it("formats microusd as the contract decimal", () => {
    expect(formatUsd(400_000)).toBe("$0.400000")
    expect(formatUsd(5_000_000)).toBe("$5.000000")
  })
})
