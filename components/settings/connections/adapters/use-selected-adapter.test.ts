/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

// Override the global next/navigation mock from jest.setup.ts so we can
// drive router.replace + searchParams per test.
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => "/",
}))

import { usePendingPlatform, useSelectedAdapter } from "./use-selected-adapter"

function mockUrl(params: string) {
  mockSearchParams = new URLSearchParams(params)
}

beforeEach(() => {
  mockReplace.mockReset()
  mockSearchParams = new URLSearchParams()
})

describe("useSelectedAdapter", () => {
  it("returns null when no adapter is selected", () => {
    const { result } = renderHook(() => useSelectedAdapter())
    expect(result.current.selectedAdapterId).toBeNull()
    expect(result.current.activeTab).toBe("config")
  })

  it("reads the active adapter from the ?adapter= query param", () => {
    mockUrl("adapter=lark-1")
    const { result } = renderHook(() => useSelectedAdapter())
    expect(result.current.selectedAdapterId).toBe("lark-1")
  })

  it("reads the inner tab from ?adapterTab=", () => {
    mockUrl("adapter=lark-1&adapterTab=health")
    const { result } = renderHook(() => useSelectedAdapter())
    expect(result.current.activeTab).toBe("health")
  })

  it("falls back to 'config' for unknown tab values", () => {
    mockUrl("adapter=lark-1&adapterTab=nonsense")
    const { result } = renderHook(() => useSelectedAdapter())
    expect(result.current.activeTab).toBe("config")
  })

  it("setSelectedAdapterId updates the URL with replace()", () => {
    const { result } = renderHook(() => useSelectedAdapter())
    act(() => {
      result.current.setSelectedAdapterId("lark-2")
    })
    expect(mockReplace).toHaveBeenCalledWith("?adapter=lark-2", { scroll: false })
  })

  it("setSelectedAdapterId(null) clears the param", () => {
    mockUrl("adapter=lark-1&adapterTab=health")
    const { result } = renderHook(() => useSelectedAdapter())
    act(() => {
      result.current.setSelectedAdapterId(null)
    })
    // Both `adapter` and `adapterTab` should be removed.
    expect(mockReplace).toHaveBeenCalledWith("?", { scroll: false })
  })

  it("setSelectedAdapterId preserves the inner tab when switching adapters (all adapters share the same five tabs)", () => {
    mockUrl("adapter=lark-1&adapterTab=health")
    const { result } = renderHook(() => useSelectedAdapter())
    act(() => {
      result.current.setSelectedAdapterId("telegram-1")
    })
    expect(mockReplace).toHaveBeenCalledWith("?adapter=telegram-1&adapterTab=health", {
      scroll: false,
    })
  })

  it("setActiveTab updates the URL", () => {
    mockUrl("adapter=lark-1")
    const { result } = renderHook(() => useSelectedAdapter())
    act(() => {
      result.current.setActiveTab("health")
    })
    expect(mockReplace).toHaveBeenCalledWith("?adapter=lark-1&adapterTab=health", {
      scroll: false,
    })
  })
})

describe("usePendingPlatform", () => {
  it("is null when the URL asks for no platform", () => {
    const { result } = renderHook(() => usePendingPlatform())
    expect(result.current.pendingPlatform).toBeNull()
  })

  it("reads the platform the URL asked to land on", () => {
    mockUrl("connectionsTab=adapters&platform=telegram")
    const { result } = renderHook(() => usePendingPlatform())
    expect(result.current.pendingPlatform).toBe("telegram")
  })

  it("consumes the param without disturbing the rest of the URL", () => {
    // One-shot instruction, not a selection: leaving it set would reopen the
    // add dialog on every re-render and on a browser back.
    mockUrl("section=connections&connectionsTab=adapters&platform=telegram")
    const { result } = renderHook(() => usePendingPlatform())
    act(() => result.current.clearPendingPlatform())
    expect(mockReplace).toHaveBeenCalledTimes(1)
    const next = new URLSearchParams(mockReplace.mock.calls[0][0].slice(1))
    expect(next.get("platform")).toBeNull()
    expect(next.get("connectionsTab")).toBe("adapters")
    expect(next.get("section")).toBe("connections")
  })

  it("does not touch the URL when there is nothing to clear", () => {
    mockUrl("connectionsTab=adapters")
    const { result } = renderHook(() => usePendingPlatform())
    act(() => result.current.clearPendingPlatform())
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
