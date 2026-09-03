/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { act } from "react"

import { PEEK_CLOSE_DELAY_MS, PEEK_OPEN_DELAY_MS, useSidebarPeek } from "./use-sidebar-peek"

beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

describe("useSidebarPeek", () => {
  it("waits out the hover delay before opening", () => {
    const { result } = renderHook(() => useSidebarPeek({ enabled: true }))

    act(() => result.current.edgeHandlers.onMouseEnter())
    expect(result.current.open).toBe(false)

    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    expect(result.current.open).toBe(true)
  })

  it("a pointer that crosses the strip and leaves never opens it", () => {
    const { result } = renderHook(() => useSidebarPeek({ enabled: true }))
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS - 20)
    })
    act(() => result.current.edgeHandlers.onMouseLeave())
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(result.current.open).toBe(false)
  })

  it("moving from the strip onto the panel cancels the pending close", () => {
    const { result } = renderHook(() => useSidebarPeek({ enabled: true }))
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    act(() => result.current.edgeHandlers.onMouseLeave())
    act(() => {
      jest.advanceTimersByTime(PEEK_CLOSE_DELAY_MS - 40)
    })
    act(() => result.current.panelHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(2000)
    })
    expect(result.current.open).toBe(true)
  })

  it("closes once the grace period elapses", () => {
    const { result } = renderHook(() => useSidebarPeek({ enabled: true }))
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    act(() => result.current.panelHandlers.onMouseLeave())
    act(() => {
      jest.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
    })
    expect(result.current.open).toBe(false)
  })

  it("never arms while disabled, and drops an open peek when it is switched off", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSidebarPeek({ enabled }),
      { initialProps: { enabled: false } }
    )
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(result.current.open).toBe(false)

    rerender({ enabled: true })
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    expect(result.current.open).toBe(true)

    rerender({ enabled: false })
    expect(result.current.open).toBe(false)
  })

  it("Escape dismisses an open peek", () => {
    const { result } = renderHook(() => useSidebarPeek({ enabled: true }))
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(result.current.open).toBe(false)
  })

  it("close() skips the grace period", () => {
    const { result } = renderHook(() => useSidebarPeek({ enabled: true }))
    act(() => result.current.edgeHandlers.onMouseEnter())
    act(() => {
      jest.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    act(() => result.current.close())
    expect(result.current.open).toBe(false)
  })
})
