/**
 * @jest-environment node
 */

import { deriveAdapterStatus } from "./adapter-status"
import type { UseAdapterHealthResult } from "@/hooks/connectors/use-adapter-health"

function health(overrides: Partial<UseAdapterHealthResult> = {}): UseAdapterHealthResult {
  return {
    current: { state: "running" },
    breaker: null,
    rateBucket: null,
    ...overrides,
  } as UseAdapterHealthResult
}

describe("deriveAdapterStatus", () => {
  it("returns disabled (grey) when the adapter is not enabled, ignoring health", () => {
    const info = deriveAdapterStatus(false, health({ current: { state: "down" } }))
    expect(info.status).toBe("disabled")
    expect(info.labelKey).toBe("status.disabled")
    expect(info.tint).toMatch(/muted-foreground/)
  })

  it("returns connected (green) when enabled and nominal", () => {
    const info = deriveAdapterStatus(true, health())
    expect(info.status).toBe("connected")
    expect(info.labelKey).toBe("status.connected")
    expect(info.tint).toMatch(/green/)
  })

  it("maps degraded → warning (amber) with the rowHealth label", () => {
    const info = deriveAdapterStatus(true, health({ current: { state: "degraded" } }))
    expect(info.status).toBe("warning")
    expect(info.labelKey).toBe("rowHealth.degraded")
    expect(info.tint).toMatch(/amber/)
  })

  it("maps a tripped rate bucket → warning (amber)", () => {
    const info = deriveAdapterStatus(
      true,
      health({ rateBucket: { available: 0, nextRefillAt: 123 } } as Partial<UseAdapterHealthResult>)
    )
    expect(info.status).toBe("warning")
    expect(info.labelKey).toBe("rowHealth.rateLimited")
  })

  it("maps down → error (red)", () => {
    const info = deriveAdapterStatus(true, health({ current: { state: "down" } }))
    expect(info.status).toBe("error")
    expect(info.labelKey).toBe("rowHealth.down")
    expect(info.tint).toMatch(/red/)
  })

  it("surfaces the health reason code so the badge can tooltip why it is red", () => {
    const info = deriveAdapterStatus(
      true,
      health({ current: { state: "down", reason: "credentials_missing" } })
    )
    expect(info.reason).toBe("credentials_missing")
  })

  it("carries no reason when connected/nominal", () => {
    expect(deriveAdapterStatus(true, health()).reason).toBeUndefined()
  })

  it("maps an open breaker → error (red), trumping other signals", () => {
    const info = deriveAdapterStatus(
      true,
      health({ breaker: { state: "open" } } as Partial<UseAdapterHealthResult>)
    )
    expect(info.status).toBe("error")
    expect(info.labelKey).toBe("rowHealth.breakerOpen")
  })
})
