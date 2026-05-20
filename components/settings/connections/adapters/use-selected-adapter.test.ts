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

import { useSelectedAdapter } from "./use-selected-adapter"

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

  it("setSelectedAdapterId also drops the inner tab so the new adapter doesn't inherit a non-existent tab", () => {
    mockUrl("adapter=lark-1&adapterTab=debug")
    const { result } = renderHook(() => useSelectedAdapter())
    act(() => {
      result.current.setSelectedAdapterId("telegram-1")
    })
    expect(mockReplace).toHaveBeenCalledWith("?adapter=telegram-1", { scroll: false })
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
