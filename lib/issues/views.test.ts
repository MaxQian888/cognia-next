import { statusCategoryOf } from "@/types/issues"
import type { IssueActor, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, makeUnifiedIssueId } from "@/types/issues/unified"
import {
  applyIssueSort,
  applyViewScope,
  BUILTIN_ISSUE_VIEWS,
  DEFAULT_ISSUE_VIEW_ID,
  DEFAULT_ISSUE_LIST_DENSITY,
  findIssueView,
  matchesViewScope,
  resolveIssueViewPreferences,
  resolveColumnCollapsed,
  toggleColumnCollapse,
  type IssueViewerContext,
} from "./views"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const sourceId = over.sourceId ?? `s${seq}`
  return {
    unifiedId: makeUnifiedIssueId("local", sourceId),
    kind: "local",
    sourceId,
    identifier: `KEY-${seq}`,
    title: `Issue ${seq}`,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

const HUMAN: IssueActor = { kind: "human" }
const MY_AGENT: IssueActor = { kind: "agent", id: "a1" }
const MY_TEAM: IssueActor = { kind: "team", id: "t1" }
const OTHER_AGENT: IssueActor = { kind: "agent", id: "zzz" }

const VIEWER: IssueViewerContext = {
  selfKey: "human:self",
  agentKeys: ["agent:a1", "team:t1"],
}

beforeEach(() => {
  seq = 0
})

describe("BUILTIN_ISSUE_VIEWS", () => {
  it("ships the four tabs in display order", () => {
    expect(BUILTIN_ISSUE_VIEWS.map((v) => v.id)).toEqual([
      "all",
      "assigned",
      "created",
      "my-agents",
    ])
  })

  it("marks every built-in as such so the UI can forbid editing them", () => {
    expect(BUILTIN_ISSUE_VIEWS.every((v) => v.builtin)).toBe(true)
  })

  it("carries the full saved-view shape, so a user view needs no new fields", () => {
    for (const view of BUILTIN_ISSUE_VIEWS) {
      expect(Object.keys(view).sort()).toEqual(
        ["builtin", "filter", "groupBy", "id", "labelKey", "layout", "scope", "sort"].sort()
      )
    }
  })

  it("is frozen, so a consumer cannot mutate another consumer's copy", () => {
    expect(Object.isFrozen(BUILTIN_ISSUE_VIEWS)).toBe(true)
    expect(Object.isFrozen(BUILTIN_ISSUE_VIEWS[0])).toBe(true)
  })

  it("resolves the default view", () => {
    expect(findIssueView(DEFAULT_ISSUE_VIEW_ID)).toBeDefined()
    expect(findIssueView("nope")).toBeUndefined()
  })
})

describe("matchesViewScope", () => {
  it("`all` keeps everything", () => {
    expect(matchesViewScope(item(), "all", VIEWER)).toBe(true)
    expect(matchesViewScope(item({ assignee: OTHER_AGENT }), "all", VIEWER)).toBe(true)
  })

  it("`assigned-to-me` matches only the viewer's own assignments", () => {
    expect(matchesViewScope(item({ assignee: HUMAN }), "assigned-to-me", VIEWER)).toBe(true)
    expect(matchesViewScope(item({ assignee: MY_AGENT }), "assigned-to-me", VIEWER)).toBe(false)
    expect(matchesViewScope(item(), "assigned-to-me", VIEWER)).toBe(false)
  })

  it("`created-by-me` reads createdBy, not the assignee", () => {
    expect(
      matchesViewScope(item({ createdBy: HUMAN, assignee: OTHER_AGENT }), "created-by-me", VIEWER)
    ).toBe(true)
    expect(matchesViewScope(item({ createdBy: OTHER_AGENT }), "created-by-me", VIEWER)).toBe(false)
  })

  it("`created-by-me` excludes rows whose source has no author", () => {
    expect(matchesViewScope(item(), "created-by-me", VIEWER)).toBe(false)
  })

  it("`my-agents` covers both agents and teams, and excludes the human", () => {
    expect(matchesViewScope(item({ assignee: MY_AGENT }), "my-agents", VIEWER)).toBe(true)
    expect(matchesViewScope(item({ assignee: MY_TEAM }), "my-agents", VIEWER)).toBe(true)
    expect(matchesViewScope(item({ assignee: HUMAN }), "my-agents", VIEWER)).toBe(false)
    expect(matchesViewScope(item({ assignee: OTHER_AGENT }), "my-agents", VIEWER)).toBe(false)
  })
})

describe("applyViewScope", () => {
  it("returns a copy for `all` rather than the original array", () => {
    const items = [item()]
    const result = applyViewScope(items, "all", VIEWER)
    expect(result).toEqual(items)
    expect(result).not.toBe(items)
  })

  it("filters for a dynamic scope", () => {
    const items = [item({ assignee: MY_AGENT }), item({ assignee: HUMAN })]
    expect(applyViewScope(items, "my-agents", VIEWER)).toHaveLength(1)
  })
})

describe("applyIssueSort", () => {
  it("leaves manual order untouched (columns own it)", () => {
    const items = [item({ sourceId: "b" }), item({ sourceId: "a" })]
    expect(applyIssueSort(items, "manual").map((i) => i.sourceId)).toEqual(["b", "a"])
  })

  it("sorts by urgency, breaking ties on recency", () => {
    const items = [
      item({ sourceId: "low", priority: "low", updatedAt: 9 }),
      item({ sourceId: "urgent", priority: "urgent", updatedAt: 1 }),
      item({ sourceId: "urgent2", priority: "urgent", updatedAt: 5 }),
    ]
    expect(applyIssueSort(items, "priority").map((i) => i.sourceId)).toEqual([
      "urgent2",
      "urgent",
      "low",
    ])
  })

  it("sorts `none` priority last", () => {
    const items = [
      item({ sourceId: "none", priority: "none" }),
      item({ sourceId: "low", priority: "low" }),
    ]
    expect(applyIssueSort(items, "priority").map((i) => i.sourceId)).toEqual(["low", "none"])
  })

  it("sorts newest-first by updated and created", () => {
    const items = [
      item({ sourceId: "old", createdAt: 1, updatedAt: 1 }),
      item({ sourceId: "new", createdAt: 9, updatedAt: 9 }),
    ]
    expect(applyIssueSort(items, "updated").map((i) => i.sourceId)).toEqual(["new", "old"])
    expect(applyIssueSort(items, "created").map((i) => i.sourceId)).toEqual(["new", "old"])
  })

  it("sorts by title", () => {
    const items = [item({ title: "beta" }), item({ title: "alpha" })]
    expect(applyIssueSort(items, "title").map((i) => i.title)).toEqual(["alpha", "beta"])
  })

  it("does not mutate its input", () => {
    const items = [item({ title: "b" }), item({ title: "a" })]
    const snapshot = [...items]
    applyIssueSort(items, "title")
    expect(items).toEqual(snapshot)
  })
})

describe("resolveIssueViewPreferences", () => {
  const view = BUILTIN_ISSUE_VIEWS.find((candidate) => candidate.id === "created")!

  it("falls back to the view's declared defaults when there are no overrides", () => {
    const resolved = resolveIssueViewPreferences(view)
    expect(resolved.layout).toBe("list")
    expect(resolved.sort).toBe("created")
    expect(resolved.groupBy).toBe("status")
    expect(resolved.filter).toBe(view.filter)
  })

  it("defaults the two display-only fields the definition has no opinion about", () => {
    const resolved = resolveIssueViewPreferences(view)
    expect(resolved.columnCollapse).toEqual({})
    expect(resolved.density).toBe(DEFAULT_ISSUE_LIST_DENSITY)
  })

  it("applies each override independently, leaving siblings on their defaults", () => {
    const resolved = resolveIssueViewPreferences(view, { layout: "board" })
    expect(resolved.layout).toBe("board")
    // The other four still come from the definition.
    expect(resolved.sort).toBe("created")
    expect(resolved.groupBy).toBe("status")
  })

  it("keeps the built-ins' differing defaults apart", () => {
    const all = BUILTIN_ISSUE_VIEWS.find((candidate) => candidate.id === "all")!
    const agents = BUILTIN_ISSUE_VIEWS.find((candidate) => candidate.id === "my-agents")!
    expect(resolveIssueViewPreferences(all).groupBy).toBe("status")
    expect(resolveIssueViewPreferences(agents).groupBy).toBe("assignee")
  })

  it("treats an empty override object as no opinion at all", () => {
    expect(resolveIssueViewPreferences(view, {})).toEqual(resolveIssueViewPreferences(view))
  })
})

describe("resolveColumnCollapsed", () => {
  it("collapses an empty column by default", () => {
    expect(resolveColumnCollapsed("backlog", 0, {})).toBe(true)
  })

  it("expands a non-empty column by default", () => {
    expect(resolveColumnCollapsed("backlog", 3, {})).toBe(false)
  })

  it("lets an explicit expand win over the empty default", () => {
    expect(resolveColumnCollapsed("backlog", 0, { backlog: false })).toBe(false)
  })

  it("lets an explicit collapse win over a full column", () => {
    expect(resolveColumnCollapsed("backlog", 9, { backlog: true })).toBe(true)
  })

  it("scopes the override to its own column", () => {
    expect(resolveColumnCollapsed("done", 4, { backlog: true })).toBe(false)
  })
})

describe("toggleColumnCollapse", () => {
  it("writes an explicit override for a column that had none", () => {
    expect(toggleColumnCollapse({}, "done", false)).toEqual({ done: true })
  })

  it("flips relative to the resolved state, not the absent key", () => {
    // An empty column resolves to collapsed; toggling it must EXPAND it.
    const collapsed = resolveColumnCollapsed("done", 0, {})
    expect(toggleColumnCollapse({}, "done", collapsed)).toEqual({ done: false })
  })

  it("keeps other columns' overrides", () => {
    expect(toggleColumnCollapse({ backlog: true }, "done", false)).toEqual({
      backlog: true,
      done: true,
    })
  })

  it("does not mutate its input", () => {
    const input = { backlog: true }
    toggleColumnCollapse(input, "done", false)
    expect(input).toEqual({ backlog: true })
  })
})
