import type { ConversationSidebarSettings, ConversationView } from "@cognia/agent-config-types"

import { resolveConversationFilters } from "@/lib/chat/conversation-filters"
import { resolveConversationSearchOptions } from "@/lib/chat/conversation-search-scope"
import {
  BUILT_IN_CONVERSATION_VIEWS,
  BUILT_IN_VIEW_IDS,
  applyConversationView,
  captureConversationViewOverlay,
  conversationViewDrift,
  conversationViewIsActive,
  conversationViewOverlayIsEmpty,
  removeConversationView,
  renameConversationView,
  resolveConversationViews,
  setBuiltInViewHidden,
  suggestedConversationViewDimensions,
  toStoredConversationView,
  upsertConversationView,
  type ConversationViewState,
  type ResolvedConversationView,
} from "@/lib/chat/conversation-views"

function state(overrides: Partial<ConversationViewState> = {}): ConversationViewState {
  return {
    filters: resolveConversationFilters(undefined),
    sortBy: "recent",
    groupBy: "workspace",
    search: resolveConversationSearchOptions(undefined),
    ...overrides,
  }
}

function view(overrides: Partial<ResolvedConversationView> = {}): ResolvedConversationView {
  return { id: "v1", name: "V1", builtIn: false, createdAt: 1, overlay: {}, ...overrides }
}

describe("resolveConversationViews", () => {
  it("offers the built-ins when nothing is stored", () => {
    expect(resolveConversationViews(undefined).map((v) => v.id)).toEqual(
      BUILT_IN_CONVERSATION_VIEWS.map((v) => v.id)
    )
  })

  it("reads legacy filterPresets as views that pin only their filters", () => {
    // The whole reason the overlay is partial: no migration, and no stored sort
    // invented on the user's behalf.
    const settings: ConversationSidebarSettings = {
      filterPresets: [{ id: "p1", name: "Pinned only", filters: { pinned: true }, createdAt: 7 }],
    }
    const resolved = resolveConversationViews(settings)
    const preset = resolved.find((v) => v.id === "p1")
    expect(preset).toBeDefined()
    expect(preset!.builtIn).toBe(false)
    expect(preset!.overlay.filters?.pinned).toBe(true)
    expect(preset!.overlay.sortBy).toBeUndefined()
    expect(preset!.overlay.groupBy).toBeUndefined()
  })

  it("drops views that pin nothing", () => {
    const settings: ConversationSidebarSettings = {
      views: [{ id: "v1", name: "Everything", createdAt: 1 }],
    }
    expect(resolveConversationViews(settings).some((v) => v.id === "v1")).toBe(false)
  })

  it("drops views with no id or no usable name", () => {
    const settings = {
      views: [
        { id: "", name: "X", createdAt: 1, sortBy: "title" },
        { id: "v2", name: "   ", createdAt: 1, sortBy: "title" },
      ],
    } as unknown as ConversationSidebarSettings
    expect(resolveConversationViews(settings).filter((v) => !v.builtIn)).toEqual([])
  })

  it("keeps the first of a duplicate id", () => {
    const settings: ConversationSidebarSettings = {
      views: [
        { id: "v1", name: "First", createdAt: 1, sortBy: "title" },
        { id: "v1", name: "Second", createdAt: 2, sortBy: "oldest" },
      ],
    }
    const custom = resolveConversationViews(settings).filter((v) => !v.builtIn)
    expect(custom.map((v) => v.name)).toEqual(["First"])
  })

  it("refuses to let stored data shadow a built-in, which would make it unreachable", () => {
    const settings: ConversationSidebarSettings = {
      views: [{ id: BUILT_IN_VIEW_IDS.unread, name: "Impostor", createdAt: 9, sortBy: "title" }],
    }
    const unread = resolveConversationViews(settings).filter(
      (v) => v.id === BUILT_IN_VIEW_IDS.unread
    )
    expect(unread).toHaveLength(1)
    expect(unread[0]!.builtIn).toBe(true)
  })

  it("hides a built-in the user has hidden, and only that one", () => {
    const settings: ConversationSidebarSettings = {
      hiddenViewIds: [BUILT_IN_VIEW_IDS.globalSearch],
    }
    const ids = resolveConversationViews(settings).map((v) => v.id)
    expect(ids).not.toContain(BUILT_IN_VIEW_IDS.globalSearch)
    expect(ids).toContain(BUILT_IN_VIEW_IDS.unread)
  })

  it("gives built-ins translation keys, not baked-in English", () => {
    for (const builtIn of BUILT_IN_CONVERSATION_VIEWS) {
      expect(builtIn.name).toMatch(/^views\.builtIn\./)
    }
  })

  it("pins both halves of 'recently created', so headers and rows cannot disagree", () => {
    const recent = BUILT_IN_CONVERSATION_VIEWS.find(
      (v) => v.id === BUILT_IN_VIEW_IDS.recentlyCreated
    )!
    expect(recent.overlay.sortBy).toBe("created")
    expect(recent.overlay.groupBy).toBe("date")
  })
})

describe("conversationViewDrift", () => {
  it("reports nothing for a view that pins nothing", () => {
    expect(conversationViewDrift(view(), state())).toEqual([])
  })

  it("never reports a dimension the view does not pin", () => {
    // The view made no claim about grouping, so a different grouping is not a
    // deviation from it.
    const v = view({ overlay: { sortBy: "title" } })
    expect(conversationViewDrift(v, state({ sortBy: "title", groupBy: "agent" }))).toEqual([])
  })

  it("reports each pinned dimension that no longer matches", () => {
    const v = view({
      overlay: {
        filters: resolveConversationFilters({ pinned: true }),
        sortBy: "title",
        groupBy: "date",
        search: { workspace: "all" },
      },
    })
    expect(conversationViewDrift(v, state())).toEqual(["filters", "sortBy", "groupBy", "search"])
  })

  it("treats filter list order as irrelevant", () => {
    const v = view({
      overlay: { filters: resolveConversationFilters({ workspaceIds: ["a", "b"] }) },
    })
    const current = state({ filters: resolveConversationFilters({ workspaceIds: ["b", "a"] }) })
    expect(conversationViewIsActive(v, current)).toBe(true)
  })

  it("compares the search reach axis by axis, through the resolver", () => {
    const v = view({ overlay: { search: { content: true } } })
    expect(
      conversationViewIsActive(
        v,
        state({ search: { workspace: "current", includeArchived: false, content: true } })
      )
    ).toBe(true)
    expect(conversationViewIsActive(v, state())).toBe(false)
  })
})

describe("applyConversationView", () => {
  it("splits the write by where the state lives", () => {
    const v = view({
      overlay: {
        filters: resolveConversationFilters({ unread: true }),
        sortBy: "unread",
        search: { workspace: "all" },
      },
    })
    const applied = applyConversationView(v)
    expect(applied.filters?.unread).toBe(true)
    expect(applied.settings).toEqual({ sortBy: "unread", search: { workspace: "all" } })
  })

  it("leaves filters alone — not cleared — when the view does not pin them", () => {
    const applied = applyConversationView(view({ overlay: { sortBy: "title" } }))
    expect(applied.filters).toBeUndefined()
    expect(applied.settings).toEqual({ sortBy: "title" })
  })
})

describe("captureConversationViewOverlay", () => {
  it("pins only the ticked dimensions", () => {
    const overlay = captureConversationViewOverlay(state({ sortBy: "title", groupBy: "agent" }), [
      "sortBy",
    ])
    expect(overlay).toEqual({ sortBy: "title" })
  })

  it("refuses to pin filters that narrow nothing", () => {
    // Otherwise the view carries a promise it does not make.
    const overlay = captureConversationViewOverlay(state(), ["filters"])
    expect(overlay.filters).toBeUndefined()
  })

  it("pins filters that do narrow", () => {
    const filters = resolveConversationFilters({ branched: true })
    const overlay = captureConversationViewOverlay(state({ filters }), ["filters"])
    expect(overlay.filters).toBe(filters)
  })
})

describe("stored-view mutations", () => {
  const stored = (id: string, name = id): ConversationView => ({
    id,
    name,
    createdAt: 1,
    sortBy: "title",
  })

  it("refuses to store a view that pins nothing or has a blank name", () => {
    expect(
      toStoredConversationView({ id: "v", name: "  ", createdAt: 1, overlay: { sortBy: "title" } })
    ).toBeNull()
    expect(toStoredConversationView({ id: "v", name: "V", createdAt: 1, overlay: {} })).toBeNull()
  })

  it("round-trips an overlay through the persisted shape", () => {
    const overlay = { sortBy: "created" as const, groupBy: "date" as const }
    const next = toStoredConversationView({ id: "v", name: "V", createdAt: 3, overlay })!
    const resolved = resolveConversationViews({ views: [next] }).find((v) => v.id === "v")!
    expect(resolved.overlay).toEqual(overlay)
  })

  it("replaces in place on a repeat id — that is 'update this view'", () => {
    const list = upsertConversationView([stored("a"), stored("b")], {
      ...stored("a", "renamed"),
      groupBy: "agent",
    })
    expect(list.map((v) => v.id)).toEqual(["a", "b"])
    expect(list[0]!.name).toBe("renamed")
    expect(list[0]!.groupBy).toBe("agent")
  })

  it("appends a new id", () => {
    expect(upsertConversationView([stored("a")], stored("c")).map((v) => v.id)).toEqual(["a", "c"])
  })

  it("refuses to store a row under a built-in id", () => {
    const list = upsertConversationView([], {
      ...stored(BUILT_IN_VIEW_IDS.unread),
      name: "Impostor",
    })
    expect(list).toEqual([])
  })

  it("renames and removes by id, ignoring blanks and unknowns", () => {
    expect(renameConversationView([stored("a")], "a", "New")[0]!.name).toBe("New")
    expect(renameConversationView([stored("a")], "a", "  ")[0]!.name).toBe("a")
    expect(renameConversationView([stored("a")], "zzz", "New")[0]!.name).toBe("a")
    expect(removeConversationView([stored("a"), stored("b")], "a").map((v) => v.id)).toEqual(["b"])
  })
})

describe("setBuiltInViewHidden", () => {
  it("hides and restores a built-in", () => {
    const hidden = setBuiltInViewHidden([], BUILT_IN_VIEW_IDS.unread, true)
    expect(hidden).toEqual([BUILT_IN_VIEW_IDS.unread])
    expect(setBuiltInViewHidden(hidden, BUILT_IN_VIEW_IDS.unread, false)).toEqual([])
  })

  it("ignores a custom id — those are deleted, not hidden", () => {
    // Both mechanisms touching one row would leave it gone from the menu but
    // still in the blob.
    expect(setBuiltInViewHidden([], "v1", true)).toEqual([])
  })

  it("is idempotent", () => {
    const once = setBuiltInViewHidden([], BUILT_IN_VIEW_IDS.unread, true)
    expect(setBuiltInViewHidden(once, BUILT_IN_VIEW_IDS.unread, true)).toEqual(once)
  })
})

describe("suggestedConversationViewDimensions", () => {
  const defaults = { sortBy: "recent" as const, groupBy: "workspace" as const }

  it("ticks nothing when the list is sitting at its defaults", () => {
    expect(suggestedConversationViewDimensions(state(), defaults)).toEqual([])
  })

  it("ticks whatever the user has moved — that is presumably why they are saving", () => {
    const current = state({
      filters: resolveConversationFilters({ unread: true }),
      sortBy: "title",
      groupBy: "agent",
      search: resolveConversationSearchOptions({ search: { content: true } }),
    })
    expect(suggestedConversationViewDimensions(current, defaults)).toEqual([
      "filters",
      "sortBy",
      "groupBy",
      "search",
    ])
  })
})

describe("conversationViewOverlayIsEmpty", () => {
  it("treats filters that narrow nothing as empty", () => {
    expect(conversationViewOverlayIsEmpty({})).toBe(true)
    expect(conversationViewOverlayIsEmpty({ filters: resolveConversationFilters(undefined) })).toBe(
      true
    )
    expect(
      conversationViewOverlayIsEmpty({ filters: resolveConversationFilters({ pinned: true }) })
    ).toBe(false)
    expect(conversationViewOverlayIsEmpty({ groupBy: "none" })).toBe(false)
  })
})
