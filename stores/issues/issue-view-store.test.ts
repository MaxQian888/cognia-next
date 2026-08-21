/** @jest-environment jsdom */
/**
 * Tests for the Issue View Store.
 *
 * The behaviour that matters here is the PER-VIEW partial-override model: an
 * override written on one view must not leak to another, and an absent key
 * must stay absent so `resolveIssueViewPreferences` can fall back.
 */

import { act, renderHook } from "@testing-library/react"

import { EMPTY_ISSUE_FILTER } from "@/lib/issues/board-model"
import { DEFAULT_ISSUE_VIEW_ID } from "@/lib/issues/views"
import { useIssueViewStore } from "./issue-view-store"

const PERSIST_NAME = "cognia-issue-view"

function readPersisted() {
  const raw = window.localStorage.getItem(PERSIST_NAME)
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }) : null
}

function store() {
  return renderHook(() => useIssueViewStore()).result
}

describe("useIssueViewStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    const result = store()
    act(() => {
      result.current.reset()
    })
  })

  describe("defaults", () => {
    it("opens on the default view with no overrides and an expanded rail", () => {
      const result = store()
      expect(result.current.viewId).toBe(DEFAULT_ISSUE_VIEW_ID)
      expect(result.current.overrides).toEqual({})
      expect(result.current.railCollapsed).toBe(false)
    })
  })

  describe("view selection", () => {
    it("switches the active view", () => {
      const result = store()
      act(() => result.current.setViewId("assigned"))
      expect(result.current.viewId).toBe("assigned")
    })

    it("switching a view does not touch its overrides", () => {
      const result = store()
      act(() => result.current.setLayout("all", "list"))
      act(() => result.current.setViewId("assigned"))
      expect(result.current.overrides.all).toEqual({ layout: "list" })
    })
  })

  describe("per-view overrides", () => {
    it("writes only the key it was given", () => {
      const result = store()
      act(() => result.current.setSort("all", "title"))
      expect(result.current.overrides.all).toEqual({ sort: "title" })
    })

    it("merges a second key without dropping the first", () => {
      const result = store()
      act(() => result.current.setSort("all", "title"))
      act(() => result.current.setGroupBy("all", "priority"))
      expect(result.current.overrides.all).toEqual({ sort: "title", groupBy: "priority" })
    })

    it("keeps two views' overrides separate", () => {
      const result = store()
      act(() => result.current.setLayout("all", "list"))
      act(() => result.current.setLayout("created", "board"))
      expect(result.current.overrides.all).toEqual({ layout: "list" })
      expect(result.current.overrides.created).toEqual({ layout: "board" })
    })

    it("stores a filter verbatim", () => {
      const result = store()
      const filter = { ...EMPTY_ISSUE_FILTER, query: "auth", priorities: ["urgent" as const] }
      act(() => result.current.setFilter("all", filter))
      expect(result.current.overrides.all?.filter).toEqual(filter)
    })

    it("stores density", () => {
      const result = store()
      act(() => result.current.setDensity("all", "compact"))
      expect(result.current.overrides.all).toEqual({ density: "compact" })
    })
  })

  describe("column collapse", () => {
    it("collapses a full column then expands it again", () => {
      const result = store()
      act(() => result.current.toggleColumnCollapsed("all", "done", 3))
      expect(result.current.overrides.all?.columnCollapse).toEqual({ done: true })
      act(() => result.current.toggleColumnCollapsed("all", "done", 3))
      expect(result.current.overrides.all?.columnCollapse).toEqual({ done: false })
    })

    it("expands an empty column, because empty resolves to collapsed", () => {
      const result = store()
      act(() => result.current.toggleColumnCollapsed("all", "done", 0))
      expect(result.current.overrides.all?.columnCollapse).toEqual({ done: false })
    })

    it("keeps other columns' overrides when flipping one", () => {
      const result = store()
      act(() => result.current.toggleColumnCollapsed("all", "backlog", 2))
      act(() => result.current.toggleColumnCollapsed("all", "done", 5))
      expect(result.current.overrides.all?.columnCollapse).toEqual({
        backlog: true,
        done: true,
      })
    })

    it("collapses per view, not globally", () => {
      const result = store()
      act(() => result.current.toggleColumnCollapsed("all", "done", 3))
      expect(result.current.overrides.assigned?.columnCollapse).toBeUndefined()
    })
  })

  describe("resetView", () => {
    it("drops every override for that view", () => {
      const result = store()
      act(() => result.current.setLayout("all", "list"))
      act(() => result.current.setDensity("all", "compact"))
      act(() => result.current.resetView("all"))
      expect(result.current.overrides.all).toBeUndefined()
    })

    it("leaves other views alone", () => {
      const result = store()
      act(() => result.current.setLayout("all", "list"))
      act(() => result.current.setLayout("created", "board"))
      act(() => result.current.resetView("all"))
      expect(result.current.overrides.created).toEqual({ layout: "board" })
    })

    it("is a no-op for a view that has no overrides", () => {
      const result = store()
      act(() => result.current.setLayout("all", "list"))
      const before = result.current.overrides
      act(() => result.current.resetView("created"))
      expect(result.current.overrides).toBe(before)
    })
  })

  describe("rail", () => {
    it("collapses and expands", () => {
      const result = store()
      act(() => result.current.setRailCollapsed(true))
      expect(result.current.railCollapsed).toBe(true)
      act(() => result.current.setRailCollapsed(false))
      expect(result.current.railCollapsed).toBe(false)
    })
  })

  describe("persistence", () => {
    it("writes viewId, railCollapsed and overrides", () => {
      const result = store()
      act(() => result.current.setViewId("assigned"))
      act(() => result.current.setRailCollapsed(true))
      act(() => result.current.setDensity("assigned", "compact"))
      const persisted = readPersisted()
      expect(persisted?.state).toMatchObject({
        viewId: "assigned",
        railCollapsed: true,
        overrides: { assigned: { density: "compact" } },
      })
    })

    it("does not persist the action functions", () => {
      const result = store()
      act(() => result.current.setViewId("created"))
      expect(readPersisted()?.state).not.toHaveProperty("setViewId")
    })
  })
})
