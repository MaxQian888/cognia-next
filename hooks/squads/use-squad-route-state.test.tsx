/** @jest-environment jsdom */

// The URL contract `/squads` answers on both surfaces. What matters is that a
// link means the same thing on either, and that a default never gets written
// into the URL as noise.

import { renderHook, act } from "@testing-library/react"

import { resolveSquadTab, useSquadRouteState } from "./use-squad-route-state"

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
   * `undefined`, not a default, so each surface picks its own landing tab
   * through `resolveSquadTab`.
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

  /**
   * The Runs tab's status chips. They were rendered with no setter behind
   * them — clickable, counted, and inert — so this axis is the difference
   * between a control and a decoration.
   */
  it("reads the Runs tab's status bucket, defaulting to all", () => {
    expect(at("status=failed").result.current.runStatus).toBe("failed")
    expect(at("").result.current.runStatus).toBe("all")
    expect(at("status=exploded").result.current.runStatus).toBe("all")
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

  /**
   * Always named: a selected Squad lands on Overview and a wide pane with no
   * selection on Runs, so eliding any one value would mean different things
   * in different contexts.
   */
  it("names every tab it is asked for", () => {
    const { result } = at("id=team_1")
    act(() => result.current.setTab("runs"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1&tab=runs", { scroll: false })
    act(() => result.current.setTab("board"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1&tab=board", { scroll: false })
  })

  /** An open run belongs to the Squad it was opened under. */
  it("drops the open run whenever the Squad changes", () => {
    const { result } = at("id=team_1&tab=runs&run=exec_1&status=failed")
    act(() => result.current.setSelectedId("team_2"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_2&tab=runs&status=failed", {
      scroll: false,
    })
  })

  it("keeps the tab from one Squad to the next", () => {
    const { result } = at("id=team_1&tab=board")
    act(() => result.current.setSelectedId("team_2"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_2&tab=board", { scroll: false })
  })

  /**
   * Arriving from the list opens the Squad's landing tab, and going back to
   * the list leaves no Squad tab behind for the list to misread.
   */
  it("starts from the landing tab when entering or leaving a Squad", () => {
    const entering = at("tab=runs")
    act(() => entering.result.current.setSelectedId("team_1"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1", { scroll: false })

    const leaving = at("id=team_1&tab=board")
    act(() => leaving.result.current.setSelectedId(undefined))
    expect(replace).toHaveBeenLastCalledWith("/squads", { scroll: false })
  })

  it("clears both narrowing axes at once, keeping the selection", () => {
    const { result } = at("id=team_1&q=review&filter=live")
    act(() => result.current.clearFilters())
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1", { scroll: false })
  })

  it("keeps the run status out of the URL when it is the default", () => {
    const { result } = at("id=team_1&run=exec_1")
    act(() => result.current.setRunStatus("failed"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1&run=exec_1&status=failed", {
      scroll: false,
    })
    act(() => result.current.setRunStatus("all"))
    expect(replace).toHaveBeenLastCalledWith("/squads?id=team_1&run=exec_1", { scroll: false })
  })

  it("addresses a run in the Runs tab, keeping the rest of the URL", () => {
    const { result } = at("id=team_1&q=review&tab=overview")
    expect(result.current.runHref("execution:team:r1")).toBe(
      "/squads?id=team_1&q=review&tab=runs&run=execution%3Ateam%3Ar1"
    )
    expect(replace).not.toHaveBeenCalled()
  })

  it("drops the selection to the bare path when nothing else is set", () => {
    const { result } = at("id=team_1")
    act(() => result.current.setSelectedId(undefined))
    expect(replace).toHaveBeenLastCalledWith("/squads", { scroll: false })
  })
})

describe("resolveSquadTab", () => {
  it("lands a selected Squad on its Overview", () => {
    expect(resolveSquadTab(undefined, { selected: true, compact: false })).toBe("overview")
    expect(resolveSquadTab(undefined, { selected: true, compact: true })).toBe("overview")
  })

  it("keeps a selected Squad's own tabs", () => {
    expect(resolveSquadTab("runs", { selected: true, compact: false })).toBe("runs")
    expect(resolveSquadTab("board", { selected: true, compact: true })).toBe("board")
  })

  /** `squads` is the phone's list tab. A selected Squad has no such tab. */
  it("maps the list tab to Overview once a Squad is selected", () => {
    expect(resolveSquadTab("squads", { selected: true, compact: true })).toBe("overview")
  })

  /** The rail is the list on a wide pane, so the only view left is every Squad's runs. */
  it("shows every Squad's runs on a wide pane with nothing selected", () => {
    for (const tab of [undefined, "overview", "squads", "runs", "board"] as const) {
      expect(resolveSquadTab(tab, { selected: false, compact: false })).toBe("runs")
    }
  })

  it("offers the list and every Squad's runs on a phone with nothing selected", () => {
    expect(resolveSquadTab(undefined, { selected: false, compact: true })).toBe("squads")
    expect(resolveSquadTab("runs", { selected: false, compact: true })).toBe("runs")
    expect(resolveSquadTab("board", { selected: false, compact: true })).toBe("squads")
    expect(resolveSquadTab("overview", { selected: false, compact: true })).toBe("squads")
  })
})
