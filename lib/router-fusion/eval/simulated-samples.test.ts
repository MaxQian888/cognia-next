/**
 * simulated-samples — the deterministic sample set the offline routing
 * experiment runs on.
 */

import { ROUTING_FEATURE_NAMES, ROUTING_FEATURES_VERSION } from "./routing-sample"
import {
  DEFAULT_SIMULATED_SAMPLE_OPTIONS,
  SIMULATED_ACTIONS,
  simulatedRoutingSamples,
} from "./simulated-samples"

describe("simulatedRoutingSamples", () => {
  it("is byte-identical for the same seed and differs for another", () => {
    const first = simulatedRoutingSamples({ seed: 7, sessionCount: 20 })
    const second = simulatedRoutingSamples({ seed: 7, sessionCount: 20 })
    const other = simulatedRoutingSamples({ seed: 8, sessionCount: 20 })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first))
  })

  it("labels every row simulated and encodes the current feature version", () => {
    const rows = simulatedRoutingSamples({ seed: 1, sessionCount: 12 })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.origin).toBe("simulated")
      expect(row.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
      expect(row.features).toHaveLength(ROUTING_FEATURE_NAMES.length)
      expect(Number.isSafeInteger(row.costMicrousd)).toBe(true)
      expect(row.costMicrousd).toBeGreaterThan(0)
    }
  })

  it("logs an exploration slice with a propensity below 1 and a rules slice at 1", () => {
    const rows = simulatedRoutingSamples({ seed: 3, sessionCount: 60 })
    const explored = rows.filter((row) => row.propensity < 1)
    const rules = rows.filter((row) => row.propensity === 1)
    expect(explored.length).toBeGreaterThan(0)
    expect(rules.length).toBeGreaterThan(0)
    // An exploration turn may differ from the session's rules action; a rules
    // turn never can.
    expect(explored.some((row) => row.actionId !== row.baselineActionId)).toBe(true)
    expect(rules.every((row) => row.actionId === row.baselineActionId)).toBe(true)
    expect(explored.every((row) => row.propensity === 1 / SIMULATED_ACTIONS.length)).toBe(true)
  })

  it("gives every action both classes, so no head is refused for a single class", () => {
    const rows = simulatedRoutingSamples({ seed: 1 })
    for (const action of SIMULATED_ACTIONS) {
      const mine = rows.filter((row) => row.actionId === action.actionId)
      expect(mine.filter((row) => row.accepted).length).toBeGreaterThan(20)
      expect(mine.filter((row) => !row.accepted).length).toBeGreaterThan(20)
    }
  })

  it("spreads decisions along a time axis the split can shift on", () => {
    const rows = simulatedRoutingSamples({ seed: 2, sessionCount: 30 })
    const times = rows.map((row) => row.decidedAt)
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThanOrEqual(
      29 * DEFAULT_SIMULATED_SAMPLE_OPTIONS.sessionSpacingMs
    )
  })

  it("refuses a non-integer seed and an impossible exploration rate", () => {
    expect(() => simulatedRoutingSamples({ seed: 1.5 })).toThrow(/integer seed/)
    expect(() => simulatedRoutingSamples({ seed: 1, explorationRate: 2 })).toThrow(
      /explorationRate/
    )
  })
})
