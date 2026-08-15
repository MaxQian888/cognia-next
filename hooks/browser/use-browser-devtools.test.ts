/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const handlers = new Map<string, (payload: unknown) => void>()
const unlistenMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(async (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler)
    return unlistenMock
  }),
}))

import { DEVTOOLS_RING, appendRing, useBrowserDevtools } from "./use-browser-devtools"

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("useBrowserDevtools (ADR-0127)", () => {
  beforeEach(() => {
    handlers.clear()
    unlistenMock.mockClear()
  })

  it("appends pushed console / network batches and counts problems", async () => {
    const { result, unmount } = renderHook(() => useBrowserDevtools())
    await act(flush)
    expect(handlers.has("browser://console")).toBe(true)
    expect(handlers.has("browser://network")).toBe(true)
    act(() => {
      handlers.get("browser://console")!({
        paneId: "p1",
        entries: [
          { level: "log", text: "a", ts: 1 },
          { level: "warn", text: "b", ts: 2 },
          { level: "error", text: "c", ts: 3 },
        ],
      })
      handlers.get("browser://network")!({
        paneId: "p1",
        entries: [
          { url: "https://x/1", method: "GET", status: 200, ok: true, durationMs: 3 },
          { url: "https://x/2", method: "POST", status: 500, ok: false, durationMs: 9 },
        ],
      })
    })
    expect(result.current.console).toHaveLength(3)
    expect(result.current.problemCount).toBe(2)
    expect(result.current.network).toHaveLength(2)
    expect(result.current.failedRequests).toBe(1)
    act(() => result.current.clearConsole())
    expect(result.current.console).toHaveLength(0)
    expect(result.current.network).toHaveLength(2)
    act(() => result.current.clearNetwork())
    expect(result.current.network).toHaveLength(0)
    unmount()
    expect(unlistenMock).toHaveBeenCalledTimes(2)
  })

  it("filters by paneId when one is given and ignores malformed payloads", async () => {
    const { result } = renderHook(() => useBrowserDevtools("mine"))
    await act(flush)
    act(() => {
      handlers.get("browser://console")!({
        paneId: "other",
        entries: [{ level: "log", text: "x", ts: 1 }],
      })
      handlers.get("browser://console")!({ paneId: "mine", entries: "nope" })
      handlers.get("browser://console")!(null)
      handlers.get("browser://console")!({
        paneId: "mine",
        entries: [{ level: "info", text: "y", ts: 2 }],
      })
    })
    expect(result.current.console.map((e) => e.text)).toEqual(["y"])
  })

  it("appendRing keeps the newest DEVTOOLS_RING entries", () => {
    const ring = Array.from({ length: DEVTOOLS_RING }, (_, i) => i)
    const next = appendRing(ring, [DEVTOOLS_RING, DEVTOOLS_RING + 1])
    expect(next).toHaveLength(DEVTOOLS_RING)
    expect(next[0]).toBe(2)
    expect(next.at(-1)).toBe(DEVTOOLS_RING + 1)
    expect(appendRing(ring, [])).toBe(ring)
  })
})
