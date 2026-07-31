/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import type { AuditEntry } from "@/types/connectors/audit"

let mockRows: AuditEntry[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { useOutboundSaturation } from "./use-outbound-saturation"
import { DISMISS_TTL_MS } from "@/lib/inbox/notice-dismiss"

const DISMISS_KEY = "inbox.outboundSaturationBanner.dismiss"
/** Mirrors SATURATION_THRESHOLD in the hook. */
const THRESHOLD = 100

function capped(adapterId: string, count: number, lastAt = 1_000): AuditEntry[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `${adapterId}-${i}`,
        adapterId,
        kind: "outbound.queue_capped",
        at: lastAt - i,
      }) as never
  )
}

beforeEach(() => {
  mockRows = []
  window.sessionStorage.clear()
})

describe("useOutboundSaturation", () => {
  it("returns nothing with no capped rows", () => {
    expect(renderHook(() => useOutboundSaturation()).result.current.adapters).toEqual([])
  })

  it("stays quiet below the saturation threshold", () => {
    mockRows = capped("a", THRESHOLD - 1)
    expect(renderHook(() => useOutboundSaturation()).result.current.adapters).toEqual([])
  })

  it("surfaces an adapter at the threshold with its capped count", () => {
    mockRows = capped("a", THRESHOLD)
    const { result } = renderHook(() => useOutboundSaturation())
    expect(result.current.adapters).toEqual([
      { adapterId: "a", cappedCount: THRESHOLD, lastAt: 1_000 },
    ])
  })

  it("orders saturated adapters newest-first", () => {
    mockRows = [...capped("a", THRESHOLD, 1_000), ...capped("b", THRESHOLD, 5_000)]
    const { result } = renderHook(() => useOutboundSaturation())
    expect(result.current.adapters.map((a) => a.adapterId)).toEqual(["b", "a"])
  })

  it("hides the current set once dismissed and persists to sessionStorage", () => {
    mockRows = capped("a", THRESHOLD)
    const { result } = renderHook(() => useOutboundSaturation())
    act(() => result.current.dismiss())
    expect(result.current.adapters).toEqual([])
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toContain('"hash":"a"')
    // Deliberately NOT localStorage — this failing set is short-lived.
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull()
  })

  it("starts hidden when a matching dismissal is already stored", () => {
    window.sessionStorage.setItem(DISMISS_KEY, JSON.stringify({ hash: "a", at: Date.now() }))
    mockRows = capped("a", THRESHOLD)
    expect(renderHook(() => useOutboundSaturation()).result.current.adapters).toEqual([])
  })

  it("reappears when the saturated set changes", () => {
    mockRows = capped("a", THRESHOLD)
    const { result, rerender } = renderHook(() => useOutboundSaturation())
    act(() => result.current.dismiss())
    expect(result.current.adapters).toEqual([])

    mockRows = [...capped("a", THRESHOLD), ...capped("b", THRESHOLD, 2_000)]
    rerender()

    expect(result.current.adapters).toHaveLength(2)
  })

  it("lets the notice back once the dismissal TTL expires", () => {
    jest.useFakeTimers()
    try {
      mockRows = capped("a", THRESHOLD)
      const { result } = renderHook(() => useOutboundSaturation())
      act(() => result.current.dismiss())
      expect(result.current.adapters).toEqual([])

      act(() => {
        jest.advanceTimersByTime(DISMISS_TTL_MS + 1)
      })

      expect(result.current.adapters).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
