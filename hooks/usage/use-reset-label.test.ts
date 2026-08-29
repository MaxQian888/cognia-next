/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { formatResetDescriptor, formatResetInstant, useResetLabel } from "./use-reset-label"
import { describeReset } from "@/lib/subscription/anthropic/usage-analytics"

// next-intl is globally mocked against en.json in jest.setup.ts, so the hook
// resolves real English copy without a provider.

const NOW = new Date("2026-08-29T12:00:00Z").getTime()
const HOUR = 3_600_000

describe("describeReset", () => {
  it("reports unknown for an absent or non-finite reset", () => {
    expect(describeReset(null, NOW)).toEqual({ kind: "unknown" })
    expect(describeReset(undefined, NOW)).toEqual({ kind: "unknown" })
    expect(describeReset(Number.NaN, NOW)).toEqual({ kind: "unknown" })
  })

  it("reports expired at or past the reset instant", () => {
    expect(describeReset(NOW, NOW)).toEqual({ kind: "expired" })
    expect(describeReset(NOW - 1, NOW)).toEqual({ kind: "expired" })
  })

  it("counts down while the reset is under a day away", () => {
    expect(describeReset(NOW + 2 * HOUR + 41 * 60_000, NOW)).toEqual({
      kind: "countdown",
      hours: 2,
      minutes: 41,
    })
  })

  it("switches to an absolute instant at a day out", () => {
    const at = NOW + 24 * HOUR
    expect(describeReset(at, NOW)).toEqual({ kind: "absolute", at })
  })
})

describe("useResetLabel", () => {
  it("renders nothing when the window reported no reset time", () => {
    const { result } = renderHook(() => useResetLabel(null, NOW))
    expect(result.current).toBeNull()
  })

  it("renders an hours+minutes countdown", () => {
    const { result } = renderHook(() => useResetLabel(NOW + 2 * HOUR + 41 * 60_000, NOW))
    expect(result.current).toBe("Resets in 2h 41m")
  })

  it("drops the hour segment under an hour", () => {
    const { result } = renderHook(() => useResetLabel(NOW + 12 * 60_000, NOW))
    expect(result.current).toBe("Resets in 12m")
  })

  it("renders the expired phrasing at the reset instant", () => {
    const { result } = renderHook(() => useResetLabel(NOW, NOW))
    expect(result.current).toBe("Resets shortly")
  })

  it("renders a weekday and clock time for a week-scale window", () => {
    const { result } = renderHook(() => useResetLabel(NOW + 3 * 24 * HOUR, NOW))
    // The exact clock text is locale/timezone dependent; what must hold is that
    // it stopped being an unreadable three-digit hour count.
    expect(result.current).toMatch(/^Resets /)
    expect(result.current).not.toMatch(/\d+h \d+m/)
  })
})

describe("formatResetDescriptor", () => {
  it("is the same mapping the hook uses, with the translator injected", () => {
    const translate = (key: string, values?: Record<string, string | number>) =>
      `${key}:${JSON.stringify(values ?? {})}`
    expect(formatResetDescriptor({ kind: "unknown" }, "en", translate)).toBeNull()
    expect(formatResetDescriptor({ kind: "expired" }, "en", translate)).toBe("resetExpired:{}")
    expect(
      formatResetDescriptor({ kind: "countdown", hours: 0, minutes: 5 }, "en", translate)
    ).toBe('resetsInM:{"minutes":5}')
    expect(
      formatResetDescriptor({ kind: "countdown", hours: 1, minutes: 5 }, "en", translate)
    ).toBe('resetsInHm:{"hours":1,"minutes":5}')
  })
})

describe("formatResetInstant", () => {
  it("falls back to a plain locale string for an unusable locale tag", () => {
    expect(formatResetInstant(NOW, "not a locale")).toBe(new Date(NOW).toLocaleString())
  })
})
