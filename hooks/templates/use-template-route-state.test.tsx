/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

let params = new URLSearchParams()
const replace = jest.fn((href: string) => {
  params = new URLSearchParams(href.split("?")[1] ?? "")
})

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/templates",
  useSearchParams: () => params,
}))

import { useTemplateRouteState } from "./use-template-route-state"

function state() {
  return renderHook(() => useTemplateRouteState()).result.current
}

describe("useTemplateRouteState", () => {
  beforeEach(() => {
    params = new URLSearchParams()
    replace.mockClear()
  })

  it("defaults to the whole library with nothing selected", () => {
    const s = state()
    expect(s.definitionId).toBeUndefined()
    expect(s.tab).toBe("library")
    expect(s.domain).toBe("all")
    expect(s.activeFilterCount).toBe(0)
  })

  it("reads the selection and facets a link carries", () => {
    params = new URLSearchParams("definition=a&tab=instances&domain=skill&scope=builtin&q=notes")
    const s = state()
    expect(s.definitionId).toBe("a")
    expect(s.tab).toBe("instances")
    expect(s.domain).toBe("skill")
    expect(s.scope).toBe("builtin")
    expect(s.query).toBe("notes")
    expect(s.activeFilterCount).toBe(2)
  })

  /**
   * A hand-edited or stale link must not put the page in a state no control can
   * represent, which would leave a facet showing a value it cannot clear.
   */
  it("ignores a value that is not one of the options", () => {
    params = new URLSearchParams("tab=nonsense&domain=nonsense&trust=nonsense&scope=nonsense")
    const s = state()
    expect(s.tab).toBe("library")
    expect(s.domain).toBe("all")
    expect(s.trust).toBe("all")
    expect(s.scope).toBe("all")
  })

  it("writes a selection into the URL", () => {
    state().setDefinitionId("user.skill.notes")
    expect(params.get("definition")).toBe("user.skill.notes")
  })

  /** The default is what an absent param already means, so writing it is noise. */
  it("keeps a default out of the URL", () => {
    state().setDomain("all")
    expect(params.has("domain")).toBe(false)
    state().setTab("library")
    expect(params.has("tab")).toBe(false)
  })

  /**
   * Typing in the search box must not put one history entry per keystroke
   * between the user and wherever they came from.
   */
  it("replaces rather than pushes, and does not jump the list", () => {
    state().setQuery("notes")
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("q=notes"), { scroll: false })
  })

  it("clears every facet at once while leaving the selection alone", () => {
    params = new URLSearchParams("definition=a&domain=skill&trust=unsigned&scope=mine")
    state().clearFilters()
    expect(params.get("definition")).toBe("a")
    expect(params.has("domain")).toBe(false)
    expect(params.has("trust")).toBe(false)
    expect(params.has("scope")).toBe(false)
  })
})
