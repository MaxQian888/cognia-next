/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import type { ConnectorHeartbeatRow } from "@/lib/db/connector-types"

let mockRows: ConnectorHeartbeatRow[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { useDegradedAdapters } from "./use-degraded-adapters"
import { DISMISS_TTL_MS } from "@/lib/inbox/notice-dismiss"

const DISMISS_KEY = "inbox.connectionLossBanner.dismiss"

function heartbeat(
  adapterId: string,
  state: string,
  at: number,
  extra: Partial<ConnectorHeartbeatRow> = {}
): ConnectorHeartbeatRow {
  return { id: `${adapterId}@${at}`, adapterId, at, fields: { state }, ...extra } as never
}

beforeEach(() => {
  mockRows = []
  window.localStorage.clear()
})

describe("useDegradedAdapters", () => {
  it("returns nothing while every adapter is healthy", () => {
    mockRows = [heartbeat("a", "running", 10)]
    expect(renderHook(() => useDegradedAdapters()).result.current.adapters).toEqual([])
  })

  it("surfaces degraded and down adapters", () => {
    mockRows = [heartbeat("a", "degraded", 10), heartbeat("b", "down", 20)]
    const { result } = renderHook(() => useDegradedAdapters())
    expect(result.current.adapters.map((a) => a.adapterId)).toEqual(["b", "a"])
    expect(result.current.adapters[0]).toMatchObject({ state: "down", at: 20 })
  })

  // A healed adapter emits a fresh `running` heartbeat; the stale `down` row is
  // still inside the 5-minute window and must not keep the notice alive.
  it("keeps only the newest heartbeat per adapter", () => {
    mockRows = [heartbeat("a", "down", 10), heartbeat("a", "running", 50)]
    expect(renderHook(() => useDegradedAdapters()).result.current.adapters).toEqual([])
  })

  it("defaults a heartbeat with no state to running", () => {
    mockRows = [{ id: "x", adapterId: "a", at: 10, fields: {} } as never]
    expect(renderHook(() => useDegradedAdapters()).result.current.adapters).toEqual([])
  })

  it("prefers the fields reason and falls back to the row reason", () => {
    mockRows = [
      heartbeat("a", "down", 10, { fields: { state: "down", reason: "inner" } } as never),
      heartbeat("b", "down", 9, { reason: "outer" } as never),
    ]
    const { result } = renderHook(() => useDegradedAdapters())
    expect(result.current.adapters.find((a) => a.adapterId === "a")?.reason).toBe("inner")
    expect(result.current.adapters.find((a) => a.adapterId === "b")?.reason).toBe("outer")
  })

  it("reports a null reason when neither source carries one", () => {
    mockRows = [heartbeat("a", "down", 10)]
    expect(renderHook(() => useDegradedAdapters()).result.current.adapters[0]!.reason).toBeNull()
  })

  it("hides the current set once dismissed and persists the snapshot", () => {
    mockRows = [heartbeat("a", "down", 10)]
    const { result } = renderHook(() => useDegradedAdapters())
    act(() => result.current.dismiss())
    expect(result.current.adapters).toEqual([])
    expect(window.localStorage.getItem(DISMISS_KEY)).toContain('"hash":"a"')
  })

  it("starts hidden when a matching dismissal survives a reload", () => {
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify({ hash: "a", at: Date.now() }))
    mockRows = [heartbeat("a", "down", 10)]
    expect(renderHook(() => useDegradedAdapters()).result.current.adapters).toEqual([])
  })

  // The dismissal is per-set, not permanent: a different failure deserves a
  // fresh notice.
  it("reappears and clears the snapshot when the failing set changes", () => {
    mockRows = [heartbeat("a", "down", 10)]
    const { result, rerender } = renderHook(() => useDegradedAdapters())
    act(() => result.current.dismiss())
    expect(result.current.adapters).toEqual([])

    mockRows = [heartbeat("a", "down", 10), heartbeat("b", "down", 11)]
    rerender()

    expect(result.current.adapters).toHaveLength(2)
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull()
  })

  it("lets the notice back once the dismissal TTL expires", () => {
    jest.useFakeTimers()
    try {
      mockRows = [heartbeat("a", "down", 10)]
      const { result } = renderHook(() => useDegradedAdapters())
      act(() => result.current.dismiss())
      expect(result.current.adapters).toEqual([])

      act(() => {
        jest.advanceTimersByTime(DISMISS_TTL_MS + 1)
      })

      expect(result.current.adapters).toHaveLength(1)
      expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("ignores a stored snapshot that does not parse", () => {
    window.localStorage.setItem(DISMISS_KEY, "not json")
    mockRows = [heartbeat("a", "down", 10)]
    expect(renderHook(() => useDegradedAdapters()).result.current.adapters).toHaveLength(1)
  })
})
