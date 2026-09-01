/** @jest-environment jsdom */

// The URL contract `/squads` answers on both surfaces. What matters is that a
// link means the same thing on either, and that a default never gets written
// into the URL as noise.

import { renderHook, act } from "@testing-library/react"

import { useSquadRouteState } from "./use-squad-route-state"

const replace = jest.fn()
let params = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => replace(...(a as [])) }),
  usePathname: () => "/squads",
  useSearchParams: () => params,
}))

function at(search: string) {
  params = new URLSearchParams(search)
  return renderHook(() => useSquadRouteState())
}

beforeEach(() => {
  replace.mockClear()
  params = new URLSearchParams()
})

describe("reading", () => {
  it("reads every axis a deep link can carry", () => {
    const { result } = at("id=team_1&tab=board&q=review&filter=waiting")
    expect(result.current).toMatchObject({
      selectedId: "team_1",
      tab: "board",
      query: "review",
      filter: "waiting",
      narrowed: true,
    })
  })

  /**
   * `undefined`, not a default, so each surface picks its own landing tab: a
   * phone opens on the Squads, a wide pane on the runs console.
   */
  it("leaves the tab unnamed when the URL names none", () => {
    expect(at("").result.current.tab).toBeUndefined()
  })

  it("refuses a value outside the union rather than passing it through", () => {
    const { result } = at("tab=graph&filter=purple")
    expect(result.current.tab).toBeUndefined()
    expect(result.current.filter).toBe("all")
  })

  it("is not narrowed by whitespace alone", () => {
    expect(at("q=%20%20").result.current.narrowed).toBe(false)
  })
})

describe("writing", () => {
  /**
   * `replace`, not `push`. Typing in the search box would otherwise put one
   * history entry per keystroke between the user and the page they came from.
   */
  it("replaces rather than pushing, and never scrolls", () => {
    const { result } = at("")
    act(() => result.current.setQuery("review"))
    expect(replace).toHaveBeenCalledWith("/squads?q=review", { scroll: false })
  })

  it("drops a key rather than writing a default into the URL", () => {
    const { result } = at("q=review&filter=live&tab=board")
    act(() => result.current.setFilter("all"))
    expect(replace).toHaveBeenLastCalledWith("/squads?q=review&tab=board", { scroll: false })
  })

  /** `runs` is the wide-pane default, so naming it would be noise. */
  it("omits the default tab and keeps every other one", () => {
    const { result } = at("id=team_1")
    act(() => result.current.setTab("runs"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1", { scroll: false })
    act(() => result.current.setTab("board"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1&tab=board", { scroll: false })
  })

  it("clears both narrowing axes at once, keeping the selection", () => {
    const { result } = at("id=team_1&q=review&filter=live")
    act(() => result.current.clearFilters())
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1", { scroll: false })
  })

  it("drops the selection to the bare path when nothing else is set", () => {
    const { result } = at("id=team_1")
    act(() => result.current.setSelectedId(undefined))
    expect(replace).toHaveBeenLastCalledWith("/squads", { scroll: false })
  })
})
