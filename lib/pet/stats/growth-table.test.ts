import { ZERO_STAT_PROGRESS } from "@/types/pet"
import {
  BURST_CHAOS,
  CHAOS_BURST_COUNT,
  CHAOS_BURST_WINDOW_MS,
  ERROR_RECOVERY_DEBUGGING,
  STAT_GROWTH_TABLE,
  statDeltaForEvent,
} from "./growth-table"

const NOW = 1_000_000

describe("statDeltaForEvent", () => {
  it("returns all-zero for a kind with no growth", () => {
    expect(statDeltaForEvent({ kind: "idle", source: "system", now: NOW })).toEqual(
      ZERO_STAT_PROGRESS
    )
  })

  it("maps goalComplete to patience + wisdom", () => {
    const d = statDeltaForEvent({ kind: "goalComplete", source: "goal", now: NOW })
    expect(d.patience).toBe(1.5)
    expect(d.wisdom).toBe(1.0)
    expect(d.chaos).toBe(0)
  })

  it("maps inboundMessage to snark only", () => {
    const d = statDeltaForEvent({ kind: "inboundMessage", source: "connector", now: NOW })
    expect(d).toEqual({ ...ZERO_STAT_PROGRESS, snark: 0.5 })
  })

  it("adds error-recovery debugging on a success that followed an error", () => {
    const plain = statDeltaForEvent({ kind: "success", source: "terminal", now: NOW })
    const recovered = statDeltaForEvent(
      { kind: "success", source: "terminal", now: NOW },
      { recoveredFromError: true }
    )
    expect(recovered.debugging).toBeCloseTo(plain.debugging + ERROR_RECOVERY_DEBUGGING)
  })

  it("does not add recovery debugging to non-success kinds", () => {
    const d = statDeltaForEvent(
      { kind: "error", source: "terminal", now: NOW },
      { recoveredFromError: true }
    )
    expect(d.debugging).toBe(STAT_GROWTH_TABLE.error?.debugging)
  })

  it("awards chaos once a burst threshold of recent events is hit", () => {
    const within = Array.from({ length: CHAOS_BURST_COUNT }, (_, i) => NOW - i * 1000)
    const d = statDeltaForEvent(
      { kind: "success", source: "agent-team", now: NOW },
      { recentEventTs: within }
    )
    expect(d.chaos).toBe(BURST_CHAOS)
  })

  it("does not award chaos just below the burst threshold", () => {
    const few = Array.from({ length: CHAOS_BURST_COUNT - 1 }, (_, i) => NOW - i * 1000)
    const d = statDeltaForEvent(
      { kind: "success", source: "agent-team", now: NOW },
      { recentEventTs: few }
    )
    expect(d.chaos).toBe(0)
  })

  it("ignores recent events outside the burst window", () => {
    const old = Array.from(
      { length: CHAOS_BURST_COUNT },
      (_, i) => NOW - CHAOS_BURST_WINDOW_MS - 1 - i
    )
    const d = statDeltaForEvent(
      { kind: "success", source: "agent-team", now: NOW },
      { recentEventTs: old }
    )
    expect(d.chaos).toBe(0)
  })
})
