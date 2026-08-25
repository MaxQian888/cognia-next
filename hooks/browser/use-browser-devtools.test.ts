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
    const { result } = renderHook(() => useBrowserDevtools({ paneId: "mine" }))
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

  // Two panes can be mounted at once but only one owns the native webview.
  // A non-owner mirroring the owner's feeds would describe a page it is not
  // showing, so it must not subscribe at all.
  it("does not subscribe when this pane does not own the webview", async () => {
    const { result, unmount } = renderHook(() => useBrowserDevtools({ enabled: false }))
    await act(flush)
    expect(handlers.has("browser://console")).toBe(false)
    expect(handlers.has("browser://network")).toBe(false)
    expect(result.current.console).toEqual([])
    expect(result.current.network).toEqual([])
    unmount()
  })

  it("subscribes once ownership arrives", async () => {
    const { rerender, unmount } = renderHook(({ enabled }) => useBrowserDevtools({ enabled }), {
      initialProps: { enabled: false },
    })
    await act(flush)
    expect(handlers.has("browser://console")).toBe(false)
    rerender({ enabled: true })
    await act(flush)
    expect(handlers.has("browser://console")).toBe(true)
    unmount()
  })

  // A remote Chromium session has no push channel into this renderer, but the
  // engine implements the same drains — so the readouts fill by polling
  // instead of being absent, which is what they were before.
  it("fills the same rings by polling when a remote engine supplies the drains", async () => {
    jest.useFakeTimers()
    try {
      const readConsole = jest
        .fn()
        .mockResolvedValueOnce([{ level: "error", text: "remote boom", ts: 1 }])
        .mockResolvedValue([])
      const readNetwork = jest
        .fn()
        .mockResolvedValueOnce([
          { url: "https://x/a", method: "GET", status: 500, ok: false, durationMs: 4 },
        ])
        .mockResolvedValue([])
      const { result, unmount } = renderHook(() =>
        useBrowserDevtools({ poll: { readConsole, readNetwork, intervalMs: 100 } })
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.console).toHaveLength(1)
      expect(result.current.problemCount).toBe(1)
      expect(result.current.failedRequests).toBe(1)

      // It keeps ticking, and stops on unmount.
      await act(async () => {
        jest.advanceTimersByTime(250)
        await Promise.resolve()
      })
      const callsWhileMounted = readConsole.mock.calls.length
      expect(callsWhileMounted).toBeGreaterThan(1)
      unmount()
      jest.advanceTimersByTime(500)
      expect(readConsole).toHaveBeenCalledTimes(callsWhileMounted)
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not poll a pane that does not own the session", async () => {
    const readConsole = jest.fn().mockResolvedValue([])
    const readNetwork = jest.fn().mockResolvedValue([])
    const { unmount } = renderHook(() =>
      useBrowserDevtools({ enabled: false, poll: { readConsole, readNetwork } })
    )
    await act(flush)
    expect(readConsole).not.toHaveBeenCalled()
    unmount()
  })
})
