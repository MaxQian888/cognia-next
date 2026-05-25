import { decideBadge, STATE_ICON, STATE_TINT, type BadgeState } from "./adapter-health-decision"
import type { UseAdapterHealthResult } from "@/hooks/connectors/use-adapter-health"

function health(partial: Partial<UseAdapterHealthResult>): UseAdapterHealthResult {
  return {
    current: { state: "running" },
    buckets: [],
    pendingOutboundCount: 0,
    breaker: null,
    rateBucket: null,
    atGateBlocks: { total: 0, reasons: [] },
    ...partial,
  } as unknown as UseAdapterHealthResult
}

describe("decideBadge", () => {
  it("returns null when nominal", () => {
    expect(decideBadge(health({}))).toBeNull()
  })

  it("prefers breaker-open over rate-limited and degraded", () => {
    const decision = decideBadge(
      health({
        breaker: { state: "open", openedAt: 1, failureRate: 90, eventCount: 10 },
        rateBucket: { available: 0, capacity: 20, refillPerSec: 5, nextRefillAt: 200 },
        current: { state: "degraded" } as UseAdapterHealthResult["current"],
        lastError: { message: "boom" } as UseAdapterHealthResult["lastError"],
      })
    )
    expect(decision?.state).toBe("breaker-open")
    expect(decision?.reason).toBe("boom")
  })

  it("returns rate-limited with eta when bucket exhausted and breaker closed", () => {
    const decision = decideBadge(
      health({
        breaker: { state: "closed", openedAt: null, failureRate: 0, eventCount: 0 },
        rateBucket: { available: 0, capacity: 20, refillPerSec: 5, nextRefillAt: 999 },
      })
    )
    expect(decision?.state).toBe("rate-limited")
    expect(decision?.etaMs).toBe(999)
  })

  it("derives degraded / down from current.state", () => {
    expect(
      decideBadge(health({ current: { state: "degraded" } as UseAdapterHealthResult["current"] }))
        ?.state
    ).toBe("degraded")
    expect(
      decideBadge(health({ current: { state: "down" } as UseAdapterHealthResult["current"] }))
        ?.state
    ).toBe("down")
  })
})

describe("presentation tables", () => {
  it.each<BadgeState>(["breaker-open", "rate-limited", "degraded", "down"])(
    "has a tint + icon for %s",
    (state) => {
      expect(STATE_TINT[state]).toBeTruthy()
      expect(STATE_ICON[state]).toBeTruthy()
    }
  )
})
