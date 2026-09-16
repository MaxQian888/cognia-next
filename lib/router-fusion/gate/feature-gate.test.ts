import { __resetBreakerForTesting, recordFusionFault } from "./breaker"
import { breakerThresholdOf, routerFusionGate } from "./feature-gate"

describe("routerFusionGate", () => {
  beforeEach(() => __resetBreakerForTesting())

  it("[ACC:OFF-01] is off for a settings row that never heard of Router + Fusion", () => {
    expect(routerFusionGate(undefined, "chat")).toBe("off")
    expect(routerFusionGate(null, "chat")).toBe("off")
    expect(routerFusionGate({}, "chat")).toBe("off")
    expect(routerFusionGate({ routerFusion: null }, "chat")).toBe("off")
  })

  it("needs the master switch and the surface switch", () => {
    expect(routerFusionGate({ routerFusion: { enabled: true } }, "chat")).toBe("off")
    expect(
      routerFusionGate({ routerFusion: { enabled: false, surfaces: { chat: true } } }, "chat")
    ).toBe("off")
    const on = { routerFusion: { enabled: true, surfaces: { chat: true } } }
    expect(routerFusionGate(on, "chat")).toBe("on")
    expect(routerFusionGate(on, "gatewayRuns")).toBe("off")
  })

  it("reports tripped from the live breaker or a persisted trip, but only when on", () => {
    const on = { routerFusion: { enabled: true, surfaces: { chat: true } } }
    recordFusionFault("chat", "db_unavailable", 1)
    expect(routerFusionGate(on, "chat")).toBe("tripped")
    // Off wins over tripped: the user turned the surface off, so nothing changes.
    expect(
      routerFusionGate({ routerFusion: { enabled: false, surfaces: { chat: true } } }, "chat")
    ).toBe("off")

    __resetBreakerForTesting()
    const persisted = {
      routerFusion: {
        enabled: true,
        surfaces: { chat: true },
        trippedSurfaces: { chat: { trippedAt: 5, reason: "import_failed" } },
      },
    }
    expect(routerFusionGate(persisted, "chat")).toBe("tripped")
  })

  it("reads the breaker threshold defensively", () => {
    expect(breakerThresholdOf(undefined)).toBe(3)
    expect(breakerThresholdOf({ routerFusion: { breakerThreshold: 5 } as never })).toBe(5)
    expect(breakerThresholdOf({ routerFusion: { breakerThreshold: 0 } as never })).toBe(3)
    expect(breakerThresholdOf({ routerFusion: { breakerThreshold: "7" } as never })).toBe(3)
  })
})
