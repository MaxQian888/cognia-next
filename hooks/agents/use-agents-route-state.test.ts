/**
 * @jest-environment jsdom
 */

const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockPathname = "/agents"
let mockParams: URLSearchParams | null = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname,
  useSearchParams: () => mockParams,
}))

import { renderHook } from "@testing-library/react"
import { AGENT_SORTS, AGENT_SOURCE_FILTERS, useAgentsRouteState } from "./use-agents-route-state"

function render(search = "") {
  mockParams = new URLSearchParams(search)
  return renderHook(() => useAgentsRouteState()).result.current
}

beforeEach(() => {
  mockRouter.push.mockReset()
  mockRouter.replace.mockReset()
  mockPathname = "/agents"
  mockParams = new URLSearchParams()
})

describe("constants", () => {
  it("lists the source tabs and sorts the table offers", () => {
    expect(AGENT_SOURCE_FILTERS).toEqual(["all", "user", "builtin", "plugin"])
    expect(AGENT_SORTS).toEqual(["recent", "name", "updated"])
  })
})

describe("reading the view", () => {
  it("is the list with default rail params when the query is empty", () => {
    const state = render()
    expect(state.view).toEqual({ kind: "list" })
    expect(state.query).toBe("")
    expect(state.source).toBe("all")
    expect(state.sort).toBe("recent")
  })

  it("reads an agent's detail, overview by default", () => {
    expect(render("id=char_1").view).toEqual({ kind: "detail", id: "char_1", mode: "overview" })
  })

  it("reads the edit and tasks modes", () => {
    expect(render("id=char_1&mode=edit").view).toEqual({
      kind: "detail",
      id: "char_1",
      mode: "edit",
    })
    expect(render("id=char_1&mode=tasks").view).toEqual({
      kind: "detail",
      id: "char_1",
      mode: "tasks",
    })
  })

  it("falls back to overview for an unknown mode", () => {
    expect(render("id=char_1&mode=delete").view).toEqual({
      kind: "detail",
      id: "char_1",
      mode: "overview",
    })
  })

  it("reads each create mode", () => {
    for (const mode of ["1", "blank", "ai"] as const) {
      expect(render(`new=${mode}`).view).toEqual({ kind: "create", mode })
    }
  })

  it("ignores an unknown create mode", () => {
    expect(render("new=wizard").view).toEqual({ kind: "list" })
    expect(render("new=wizard&id=char_1").view).toEqual({
      kind: "detail",
      id: "char_1",
      mode: "overview",
    })
  })

  it("reads a builder conversation", () => {
    expect(render("builder=sess-1").view).toEqual({ kind: "builder", sessionId: "sess-1" })
  })

  it("prefers builder over create over detail when several are present", () => {
    expect(render("builder=b&new=ai&id=x").view).toEqual({ kind: "builder", sessionId: "b" })
    expect(render("new=blank&id=x").view).toEqual({ kind: "create", mode: "blank" })
  })

  it("treats an empty id as no detail", () => {
    expect(render("id=").view).toEqual({ kind: "list" })
  })

  it("reads the rail params", () => {
    const state = render("q=review&source=plugin&sort=name")
    expect(state.query).toBe("review")
    expect(state.source).toBe("plugin")
    expect(state.sort).toBe("name")
  })

  it("falls back to the defaults for unknown rail values", () => {
    const state = render("source=everything&sort=random")
    expect(state.source).toBe("all")
    expect(state.sort).toBe("recent")
  })
})

describe("navigating between views (push)", () => {
  it("opens an agent on its overview, clearing the other view keys and keeping the rail", () => {
    render("new=ai&builder=b&mode=edit&q=rev&sort=name").openAgent("char_1")
    expect(mockRouter.push).toHaveBeenCalledWith("/agents?q=rev&sort=name&id=char_1", {
      scroll: false,
    })
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })

  it("opens an agent in a named mode, but never spells overview", () => {
    const state = render()
    state.openAgent("char_1", "tasks")
    state.openAgent("char_1", "overview")
    expect(mockRouter.push).toHaveBeenNthCalledWith(1, "/agents?id=char_1&mode=tasks", {
      scroll: false,
    })
    expect(mockRouter.push).toHaveBeenNthCalledWith(2, "/agents?id=char_1", { scroll: false })
  })

  it("encodes the agent id", () => {
    render().openAgent("a b&c")
    expect(mockRouter.push).toHaveBeenCalledWith("/agents?id=a+b%26c", { scroll: false })
  })

  it("sets the mode on the current agent, removing the param for overview", () => {
    const state = render("id=char_1&mode=edit&q=x")
    state.setMode("tasks")
    state.setMode("overview")
    expect(mockRouter.push).toHaveBeenNthCalledWith(1, "/agents?id=char_1&mode=tasks&q=x", {
      scroll: false,
    })
    expect(mockRouter.push).toHaveBeenNthCalledWith(2, "/agents?id=char_1&q=x", { scroll: false })
  })

  it("opens the create flow, clearing the detail", () => {
    render("id=char_1&mode=edit&source=user").openCreate("blank")
    expect(mockRouter.push).toHaveBeenCalledWith("/agents?source=user&new=blank", { scroll: false })
  })

  it("opens a builder conversation, clearing the create flow", () => {
    render("new=ai").openBuilder("sess-9")
    expect(mockRouter.push).toHaveBeenCalledWith("/agents?builder=sess-9", { scroll: false })
  })

  it("returns to the list, keeping the rail params", () => {
    render("id=char_1&mode=tasks&q=hi&source=builtin").openList()
    expect(mockRouter.push).toHaveBeenCalledWith("/agents?q=hi&source=builtin", { scroll: false })
  })

  it("returns to the bare pathname when nothing is left", () => {
    render("builder=b").openList()
    expect(mockRouter.push).toHaveBeenCalledWith("/agents", { scroll: false })
  })

  it("builds on the current pathname", () => {
    mockPathname = "/m/agents"
    render().openCreate("1")
    expect(mockRouter.push).toHaveBeenCalledWith("/m/agents?new=1", { scroll: false })
  })
})

describe("editing the rail (replace)", () => {
  it("sets and clears the search query without a history entry", () => {
    const state = render("id=char_1&q=old")
    state.setQuery("new text")
    state.setQuery("")
    expect(mockRouter.replace).toHaveBeenNthCalledWith(1, "/agents?id=char_1&q=new+text", {
      scroll: false,
    })
    expect(mockRouter.replace).toHaveBeenNthCalledWith(2, "/agents?id=char_1", { scroll: false })
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  it("drops the source param for the all tab", () => {
    const state = render("source=user")
    state.setSource("plugin")
    state.setSource("all")
    expect(mockRouter.replace).toHaveBeenNthCalledWith(1, "/agents?source=plugin", {
      scroll: false,
    })
    expect(mockRouter.replace).toHaveBeenNthCalledWith(2, "/agents", { scroll: false })
  })

  it("drops the sort param for the default sort", () => {
    const state = render("q=a")
    state.setSort("updated")
    state.setSort("recent")
    expect(mockRouter.replace).toHaveBeenNthCalledWith(1, "/agents?q=a&sort=updated", {
      scroll: false,
    })
    expect(mockRouter.replace).toHaveBeenNthCalledWith(2, "/agents?q=a", { scroll: false })
  })
})

describe("memoization and absent params", () => {
  it("keeps the same state object across renders with the same URL", () => {
    mockParams = new URLSearchParams("id=char_1")
    const { result, rerender } = renderHook(() => useAgentsRouteState())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("reads the list and writes from scratch when there are no search params", () => {
    mockParams = null
    const { result } = renderHook(() => useAgentsRouteState())
    expect(result.current.view).toEqual({ kind: "list" })
    expect(result.current.source).toBe("all")
    result.current.openAgent("char_1")
    expect(mockRouter.push).toHaveBeenCalledWith("/agents?id=char_1", { scroll: false })
  })
})
