/**
 * @jest-environment node
 */
import { meterColor, meterFill, meterLabel, meterResetText, meterRightLabel } from "./limits"

import type { LimitsMeter } from "@/types/subscription"

const NOW = 1_000_000_000_000

function meter(over: Partial<LimitsMeter> = {}): LimitsMeter {
  return { id: "session", kind: "window", usedPct: 21, status: "ok", ...over }
}

describe("meterLabel", () => {
  it("maps built-in ids to English labels", () => {
    expect(meterLabel(meter({ id: "session" }))).toBe("Current session")
    expect(meterLabel(meter({ id: "weekly" }))).toBe("Current week (all models)")
    expect(meterLabel(meter({ id: "weekly_sonnet" }))).toBe("Current week (Sonnet only)")
    expect(meterLabel(meter({ id: "credit", kind: "balance" }))).toBe("Credit balance")
  })

  it("falls back to label then id", () => {
    expect(meterLabel(meter({ id: "x", label: "Custom" }))).toBe("Custom")
    expect(meterLabel(meter({ id: "x" }))).toBe("x")
  })
})

describe("meterColor", () => {
  it("maps status to a palette token", () => {
    expect(meterColor("ok")).toBe("success")
    expect(meterColor("warn")).toBe("warning")
    expect(meterColor("crit")).toBe("danger")
    expect(meterColor("exceeded")).toBe("danger")
    expect(meterColor("unknown")).toBe("muted")
  })
})

describe("meterFill", () => {
  it("scales a percent across the width and clamps", () => {
    expect(meterFill(50, 10)).toBe(5)
    expect(meterFill(0, 10)).toBe(0)
    expect(meterFill(140, 10)).toBe(10)
    expect(meterFill(null, 10)).toBe(0)
  })
})

describe("meterRightLabel", () => {
  it("shows '% used' for window meters", () => {
    expect(meterRightLabel(meter({ usedPct: 21 }))).toBe("21% used")
    expect(meterRightLabel(meter({ usedPct: null }))).toBe("0% used")
  })

  it("shows currency-prefixed credit for balance meters", () => {
    expect(
      meterRightLabel(meter({ kind: "balance", remaining: 88.5, currency: "CNY", usedPct: null }))
    ).toBe("¥88.50 left")
    expect(
      meterRightLabel(meter({ kind: "balance", remaining: 12, currency: "USD", usedPct: null }))
    ).toBe("$12 left")
  })

  it("shows a unit suffix when there's no currency symbol", () => {
    expect(
      meterRightLabel(meter({ kind: "balance", remaining: 1000, unit: "tokens", usedPct: null }))
    ).toBe("1000 tokens left")
  })

  it("shows a bare amount when there's neither currency nor unit", () => {
    expect(meterRightLabel(meter({ kind: "balance", remaining: 5, usedPct: null }))).toBe("5 left")
  })

  it("falls back to percent then em-dash for a balance with no amount", () => {
    expect(meterRightLabel(meter({ kind: "balance", usedPct: 40, remaining: undefined }))).toBe(
      "40% used"
    )
    expect(meterRightLabel(meter({ kind: "balance", usedPct: null, remaining: undefined }))).toBe(
      "—"
    )
  })
})

describe("meterResetText", () => {
  it("renders hours+minutes, minutes-only, expired, and null", () => {
    expect(meterResetText(meter({ resetAt: NOW + 2 * 3600_000 + 5 * 60_000 }), NOW)).toBe(
      "Resets in 2h 5m"
    )
    expect(meterResetText(meter({ resetAt: NOW + 12 * 60_000 }), NOW)).toBe("Resets in 12m")
    expect(meterResetText(meter({ resetAt: NOW - 1000 }), NOW)).toBe("Resets shortly")
    expect(meterResetText(meter({ resetAt: null }), NOW)).toBeNull()
    expect(meterResetText(meter({ resetAt: undefined }), NOW)).toBeNull()
  })
})
