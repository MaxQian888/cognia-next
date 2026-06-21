/**
 * @jest-environment node
 */
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  resolveAutoCompactThreshold,
  shouldAutoCompact,
} from "./auto-compact"
import type { UsageInfo } from "@/lib/claude/adapter"

/** Usage that fills `frac` of a 1000-token window via inputTokens. */
function usageAt(frac: number): UsageInfo {
  return { inputTokens: Math.round(frac * 1000) } as UsageInfo
}

const WINDOW = 1000

describe("resolveAutoCompactThreshold", () => {
  it("defaults when unset / NaN", () => {
    expect(resolveAutoCompactThreshold(undefined)).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD)
    expect(resolveAutoCompactThreshold(Number.NaN)).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD)
  })

  it("clamps into [0.5, 0.98]", () => {
    expect(resolveAutoCompactThreshold(0.1)).toBe(0.5)
    expect(resolveAutoCompactThreshold(0.99)).toBe(0.98)
    expect(resolveAutoCompactThreshold(0.7)).toBe(0.7)
  })
})

describe("shouldAutoCompact", () => {
  it("fires once the fill reaches the threshold", () => {
    expect(
      shouldAutoCompact({
        usage: usageAt(0.9),
        contextWindow: WINDOW,
        enabled: true,
        threshold: 0.85,
      })
    ).toBe(true)
  })

  it("does not fire below the threshold", () => {
    expect(
      shouldAutoCompact({
        usage: usageAt(0.5),
        contextWindow: WINDOW,
        enabled: true,
        threshold: 0.85,
      })
    ).toBe(false)
  })

  it("is off when disabled, regardless of fill", () => {
    expect(shouldAutoCompact({ usage: usageAt(0.99), contextWindow: WINDOW, enabled: false })).toBe(
      false
    )
  })

  it("is off with no usage to measure", () => {
    expect(shouldAutoCompact({ usage: null, contextWindow: WINDOW, enabled: true })).toBe(false)
    expect(shouldAutoCompact({ usage: undefined, contextWindow: WINDOW, enabled: true })).toBe(
      false
    )
  })

  it("is off when the window can't be resolved (max ≤ 0)", () => {
    // No model + no window override → the per-model table can't produce a window.
    expect(shouldAutoCompact({ usage: usageAt(0.9), contextWindow: 0, enabled: true })).toBe(false)
  })

  it("uses the default threshold when none is given", () => {
    expect(shouldAutoCompact({ usage: usageAt(0.86), contextWindow: WINDOW, enabled: true })).toBe(
      true
    )
    expect(shouldAutoCompact({ usage: usageAt(0.8), contextWindow: WINDOW, enabled: true })).toBe(
      false
    )
  })
})
