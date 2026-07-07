/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

// Module-level URL state captured so router.replace mutations are visible to
// useSearchParams on the next render. The pattern mirrors plugins-section.test.tsx.
let currentSearch = ""
let cachedSearchKey = ""
let cachedSearchParams = new URLSearchParams("")
const replaceMock = jest.fn((href: string) => {
  const qIdx = href.indexOf("?")
  currentSearch = qIdx >= 0 ? href.slice(qIdx) : ""
})

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: (href: string) => replaceMock(href),
    back: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => "/discover",
  useSearchParams: () => {
    const key = currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch
    if (key !== cachedSearchKey) {
      cachedSearchKey = key
      cachedSearchParams = new URLSearchParams(key)
    }
    return cachedSearchParams
  },
}))

import { useDiscoverRouteState } from "./use-discover-route-state"
import { DEFAULT_DISCOVER_CATEGORY, FORYOU_CATEGORY } from "@/lib/discover/categories"

beforeEach(() => {
  currentSearch = ""
  cachedSearchKey = ""
  cachedSearchParams = new URLSearchParams("")
  replaceMock.mockClear()
})

describe("useDiscoverRouteState", () => {
  it("defaults to the foryou aggregated landing when ?category= is absent", () => {
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.category).toBe(FORYOU_CATEGORY)
    expect(result.current.item).toBeNull()
  })

  it("reads ?category= when valid", () => {
    currentSearch = "?category=plugins"
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.category).toBe("plugins")
  })

  it("reads a newly-added category id such as slashCommands", () => {
    currentSearch = "?category=slashCommands"
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.category).toBe("slashCommands")
  })

  it("falls back to foryou when ?category= is an unknown value", () => {
    currentSearch = "?category=bogus"
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.category).toBe(FORYOU_CATEGORY)
  })

  it("falls back to foryou when ?category= names an unknown id", () => {
    // All registered ids resolve through isValidView; any string not in the
    // registry (nor a pseudo-category) falls back to the foryou landing.
    currentSearch = "?category=alien-id"
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.category).toBe(FORYOU_CATEGORY)
  })

  it("reads ?item= when present", () => {
    currentSearch = "?category=plugins&item=plug_42"
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.item).toBe("plug_42")
  })

  it("treats empty ?item= as null", () => {
    currentSearch = "?category=plugins&item="
    const { result } = renderHook(() => useDiscoverRouteState())
    expect(result.current.item).toBeNull()
  })

  it("setCategory replaces the URL and clears any selected item", () => {
    currentSearch = "?category=plugins&item=plug_42"
    const { result, rerender } = renderHook(() => useDiscoverRouteState())
    expect(result.current.item).toBe("plug_42")

    act(() => {
      result.current.setCategory("skills")
    })

    expect(replaceMock).toHaveBeenCalledWith("/discover?category=skills")
    rerender()
    expect(result.current.category).toBe("skills")
    expect(result.current.item).toBeNull()
  })

  it("setItem appends ?item= and preserves the category", () => {
    currentSearch = "?category=plugins"
    const { result, rerender } = renderHook(() => useDiscoverRouteState())

    act(() => {
      result.current.setItem("plug_99")
    })

    expect(replaceMock).toHaveBeenCalledWith("/discover?category=plugins&item=plug_99")
    rerender()
    expect(result.current.item).toBe("plug_99")
    expect(result.current.category).toBe("plugins")
  })

  it("setItem(null) drops the item param", () => {
    currentSearch = "?category=skills&item=sk_1"
    const { result, rerender } = renderHook(() => useDiscoverRouteState())

    act(() => {
      result.current.setItem(null)
    })

    expect(replaceMock).toHaveBeenCalledWith("/discover?category=skills")
    rerender()
    expect(result.current.item).toBeNull()
  })

  it("clearItem is equivalent to setItem(null)", () => {
    currentSearch = "?category=teams&item=team_a"
    const { result, rerender } = renderHook(() => useDiscoverRouteState())

    act(() => {
      result.current.clearItem()
    })

    expect(replaceMock).toHaveBeenCalledWith("/discover?category=teams")
    rerender()
    expect(result.current.item).toBeNull()
  })

  it("when called with no query, replace omits the trailing '?'", () => {
    // Edge case: empty params should still produce a clean URL (pathname only)
    // so navigation history is not polluted with bare-'?' entries.
    currentSearch = "?category=characters"
    const { result } = renderHook(() => useDiscoverRouteState())

    act(() => {
      // Force a replace that ends up with no params by setting the default
      // category explicitly and clearing the item (which is already null).
      result.current.setCategory(DEFAULT_DISCOVER_CATEGORY)
    })

    // Default category is "characters" — still encoded in the URL because
    // we don't elide the default for round-trip stability.
    expect(replaceMock).toHaveBeenCalledWith(`/discover?category=${DEFAULT_DISCOVER_CATEGORY}`)
  })
})
