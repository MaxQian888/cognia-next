/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { useInboxLayoutStore } from "@/stores/inbox/inbox-layout-store"
import { useInboxUrlState } from "./use-inbox-url-state"

const mockReplace = jest.fn()
let mockQuery = ""
let mockPathname = "/inbox/all"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockQuery),
}))

beforeEach(() => {
  mockReplace.mockReset()
  mockQuery = ""
  mockPathname = "/inbox/all"
  window.localStorage.clear()
  act(() => useInboxLayoutStore.getState().reset())
})

describe("useInboxUrlState", () => {
  it("defaults to status grouping with no preview or filters", () => {
    const { result } = renderHook(() => useInboxUrlState())
    expect(result.current.grouping).toBe("status")
    expect(result.current.previewSessionId).toBeNull()
    expect(result.current.filters).toEqual([])
  })

  it("reads the URL, including the legacy view param", () => {
    mockQuery = "view=by-platform&preview=s1&f=unread"
    const { result } = renderHook(() => useInboxUrlState())
    expect(result.current.grouping).toBe("platform")
    expect(result.current.previewSessionId).toBe("s1")
    expect(result.current.filters).toEqual(["unread"])
  })

  it("falls back to the stored grouping when the URL names none", () => {
    act(() => useInboxLayoutStore.getState().setGrouping("adapter"))
    const { result } = renderHook(() => useInboxUrlState())
    expect(result.current.grouping).toBe("adapter")
  })

  it("lets the URL win over the stored grouping", () => {
    act(() => useInboxLayoutStore.getState().setGrouping("adapter"))
    mockQuery = "group=platform"
    const { result } = renderHook(() => useInboxUrlState())
    expect(result.current.grouping).toBe("platform")
  })

  it("selects a preview with replace, keeping the route's scope params", () => {
    mockPathname = "/inbox/adapter"
    mockQuery = "adapterId=a1"
    const { result } = renderHook(() => useInboxUrlState())
    act(() => result.current.setPreview("s 2"))
    expect(mockReplace).toHaveBeenCalledWith("/inbox/adapter?adapterId=a1&preview=s+2", {
      scroll: false,
    })
  })

  it("clears the preview without leaving a dangling question mark", () => {
    mockQuery = "preview=s1"
    const { result } = renderHook(() => useInboxUrlState())
    act(() => result.current.setPreview(null))
    expect(mockReplace).toHaveBeenCalledWith("/inbox/all", { scroll: false })
  })

  it("skips the navigation when nothing changes", () => {
    mockQuery = "preview=s1"
    const { result } = renderHook(() => useInboxUrlState())
    act(() => result.current.setPreview("s1"))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("writes the grouping to both the URL and the store", () => {
    mockQuery = "view=by-adapter"
    const { result } = renderHook(() => useInboxUrlState())
    act(() => result.current.setGrouping("platform"))
    expect(mockReplace).toHaveBeenCalledWith("/inbox/all?group=platform", { scroll: false })
    expect(useInboxLayoutStore.getState().grouping).toBe("platform")
  })

  it("toggles, sets and clears filters", () => {
    mockQuery = "f=unread"
    const { result } = renderHook(() => useInboxUrlState())
    act(() => result.current.toggleFilter("pinned"))
    expect(mockReplace).toHaveBeenLastCalledWith("/inbox/all?f=unread%2Cpinned", {
      scroll: false,
    })
    act(() => result.current.toggleFilter("unread"))
    expect(mockReplace).toHaveBeenLastCalledWith("/inbox/all", { scroll: false })
    act(() => result.current.setFilters(["snoozed"]))
    expect(mockReplace).toHaveBeenLastCalledWith("/inbox/all?f=snoozed", { scroll: false })
    act(() => result.current.clearFilters())
    expect(mockReplace).toHaveBeenLastCalledWith("/inbox/all", { scroll: false })
  })

  it("applies a combined patch in one navigation", () => {
    mockQuery = "f=unread"
    const { result } = renderHook(() => useInboxUrlState())
    act(() => result.current.update({ preview: "s9", filters: [] }))
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith("/inbox/all?preview=s9", { scroll: false })
  })
})
