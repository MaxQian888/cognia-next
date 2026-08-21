import {
  CONVERSATION_ACTIVITY_FILTER_OPTIONS,
  CONVERSATION_FILTER_LIST_KEYS,
  CONVERSATION_FILTER_PRESET_NAME_MAX,
  CONVERSATION_FILTER_TOGGLES,
  CONVERSATION_FILTER_UNASSIGNED,
  CONVERSATION_KIND_FILTER_OPTIONS,
  CONVERSATION_SORT_BY_OPTIONS,
  DEFAULT_CONVERSATION_SORT_BY,
  EMPTY_CONVERSATION_FILTERS,
  addConversationFilterPreset,
  conversationFiltersEqual,
  countActiveConversationFilters,
  findMatchingConversationFilterPreset,
  hasActiveConversationFilters,
  matchesConversationActivity,
  matchesConversationFilters,
  normalizeConversationFilterPresetName,
  removeConversationFilterPreset,
  renameConversationFilterPreset,
  resolveConversationFilterPresets,
  resolveConversationFilters,
  resolveConversationSortBy,
  resolveConversationTimeBasis,
  setConversationActivityFilter,
  setConversationFilterList,
  setConversationKindFilter,
  sortSupportsDateBuckets,
  sortSupportsManualOrder,
  toggleConversationFilter,
  toggleConversationFilterValue,
} from "@/lib/chat/conversation-filters"
import type { ChatSession, ConversationSidebarSettings } from "@cognia/agent-config-types"

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "Session",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ChatSession
}

describe("resolveConversationSortBy", () => {
  it("defaults to recency when nothing is persisted", () => {
    expect(resolveConversationSortBy(undefined)).toBe(DEFAULT_CONVERSATION_SORT_BY)
    expect(resolveConversationSortBy(null)).toBe("recent")
    expect(resolveConversationSortBy({})).toBe("recent")
  })

  it("returns every known mode verbatim", () => {
    for (const option of CONVERSATION_SORT_BY_OPTIONS) {
      expect(resolveConversationSortBy({ sortBy: option })).toBe(option)
    }
  })

  it("falls back for a mode written by a newer build", () => {
    const settings = { sortBy: "byVibes" } as unknown as ConversationSidebarSettings
    expect(resolveConversationSortBy(settings)).toBe("recent")
  })
})

describe("resolveConversationFilters", () => {
  it("treats an absent blob as unfiltered, reusing one identity", () => {
    expect(resolveConversationFilters(undefined)).toBe(EMPTY_CONVERSATION_FILTERS)
    expect(resolveConversationFilters(null)).toBe(EMPTY_CONVERSATION_FILTERS)
  })

  it("fills in every missing facet", () => {
    expect(resolveConversationFilters({ pinned: true })).toEqual({
      ...EMPTY_CONVERSATION_FILTERS,
      pinned: true,
    })
  })

  it("coerces non-boolean values to off rather than on", () => {
    const raw = { unread: 1, pinned: "yes" } as unknown as Parameters<
      typeof resolveConversationFilters
    >[0]
    expect(resolveConversationFilters(raw)).toMatchObject({ unread: false, pinned: false })
  })

  it("degrades an unknown kind to 'all'", () => {
    const raw = { kind: "workflow" } as unknown as Parameters<typeof resolveConversationFilters>[0]
    expect(resolveConversationFilters(raw).kind).toBe("all")
  })

  it("keeps every valid kind", () => {
    for (const kind of CONVERSATION_KIND_FILTER_OPTIONS) {
      expect(resolveConversationFilters({ kind }).kind).toBe(kind)
    }
  })
})

describe("countActiveConversationFilters", () => {
  it("counts nothing when unfiltered", () => {
    expect(countActiveConversationFilters(undefined)).toBe(0)
    expect(hasActiveConversationFilters(undefined)).toBe(false)
  })

  it("counts each boolean facet once", () => {
    expect(countActiveConversationFilters({ unread: true })).toBe(1)
    expect(countActiveConversationFilters({ unread: true, pinned: true, branched: true })).toBe(3)
  })

  it("counts a non-default kind as one filter", () => {
    expect(countActiveConversationFilters({ kind: "team" })).toBe(1)
    expect(countActiveConversationFilters({ kind: "all" })).toBe(0)
    expect(countActiveConversationFilters({ unread: true, kind: "dm" })).toBe(2)
    expect(hasActiveConversationFilters({ kind: "dm" })).toBe(true)
  })
})

describe("toggleConversationFilter / setConversationKindFilter", () => {
  it("flips one facet without disturbing its siblings", () => {
    const base = resolveConversationFilters({ pinned: true, kind: "team" })
    const next = toggleConversationFilter(base, "unread", true)
    expect(next).toEqual({
      ...EMPTY_CONVERSATION_FILTERS,
      unread: true,
      pinned: true,
      kind: "team",
    })
  })

  it("turns a facet back off", () => {
    const next = toggleConversationFilter({ unread: true, pinned: true }, "unread", false)
    expect(next.unread).toBe(false)
    expect(next.pinned).toBe(true)
  })

  it("covers every declared toggle", () => {
    for (const key of CONVERSATION_FILTER_TOGGLES) {
      expect(toggleConversationFilter(undefined, key, true)[key]).toBe(true)
    }
  })

  it("swaps the kind facet and rejects garbage", () => {
    expect(setConversationKindFilter({ unread: true }, "dm")).toEqual({
      ...EMPTY_CONVERSATION_FILTERS,
      unread: true,
      kind: "dm",
    })
    const bogus = "sms" as unknown as Parameters<typeof setConversationKindFilter>[1]
    expect(setConversationKindFilter(undefined, bogus).kind).toBe("all")
  })
})

describe("matchesConversationFilters", () => {
  const unread = new Set(["s-unread"])

  it("admits everything when unfiltered", () => {
    expect(matchesConversationFilters(session(), EMPTY_CONVERSATION_FILTERS, undefined)).toBe(true)
  })

  it("filters by unread against the injected id set", () => {
    const filters = resolveConversationFilters({ unread: true })
    expect(matchesConversationFilters(session({ id: "s-unread" }), filters, unread)).toBe(true)
    expect(matchesConversationFilters(session({ id: "s-read" }), filters, unread)).toBe(false)
    // No set injected at all → nothing is unread, rather than everything.
    expect(matchesConversationFilters(session({ id: "s-unread" }), filters, undefined)).toBe(false)
  })

  it("filters by pinned", () => {
    const filters = resolveConversationFilters({ pinned: true })
    expect(matchesConversationFilters(session({ pinned: true }), filters, undefined)).toBe(true)
    expect(matchesConversationFilters(session(), filters, undefined)).toBe(false)
  })

  it("filters by branch lineage", () => {
    const filters = resolveConversationFilters({ branched: true })
    expect(matchesConversationFilters(session({ parentSessionId: "p" }), filters, undefined)).toBe(
      true
    )
    expect(matchesConversationFilters(session(), filters, undefined)).toBe(false)
  })

  it("filters by conversation kind in both directions", () => {
    const team = session({ kind: "team" })
    const dm = session({ kind: "direct" })
    const teamOnly = resolveConversationFilters({ kind: "team" })
    const dmOnly = resolveConversationFilters({ kind: "dm" })
    expect(matchesConversationFilters(team, teamOnly, undefined)).toBe(true)
    expect(matchesConversationFilters(dm, teamOnly, undefined)).toBe(false)
    expect(matchesConversationFilters(dm, dmOnly, undefined)).toBe(true)
    expect(matchesConversationFilters(team, dmOnly, undefined)).toBe(false)
  })

  it("treats a session with no kind as a direct message", () => {
    const dmOnly = resolveConversationFilters({ kind: "dm" })
    expect(matchesConversationFilters(session({ kind: undefined }), dmOnly, undefined)).toBe(true)
  })

  it("ANDs facets together", () => {
    const filters = resolveConversationFilters({ unread: true, pinned: true })
    expect(
      matchesConversationFilters(session({ id: "s-unread", pinned: true }), filters, unread)
    ).toBe(true)
    // Unread but not pinned — one failing facet is enough to exclude it.
    expect(matchesConversationFilters(session({ id: "s-unread" }), filters, unread)).toBe(false)
  })
})

describe("sortSupportsManualOrder", () => {
  it("honors a drag order only under recency", () => {
    expect(sortSupportsManualOrder("recent")).toBe(true)
    for (const option of CONVERSATION_SORT_BY_OPTIONS.filter((o) => o !== "recent")) {
      expect(sortSupportsManualOrder(option)).toBe(false)
    }
  })
})

describe("list facets", () => {
  it("normalizes persisted lists: dedupes, drops blanks and non-strings, shares one empty identity", () => {
    const raw = {
      workspaceIds: ["w1", "w1", "", 3, "w2"],
      models: "gpt",
    } as unknown as Parameters<typeof resolveConversationFilters>[0]
    const resolved = resolveConversationFilters(raw)
    expect(resolved.workspaceIds).toEqual(["w1", "w2"])
    expect(resolved.models).toBe(EMPTY_CONVERSATION_FILTERS.models)
    expect(resolved.folderIds).toBe(EMPTY_CONVERSATION_FILTERS.folderIds)
  })

  it("counts each non-empty list facet once regardless of how many values it holds", () => {
    expect(countActiveConversationFilters({ workspaceIds: ["a", "b", "c"] })).toBe(1)
    expect(countActiveConversationFilters({ workspaceIds: ["a"], models: ["m"] })).toBe(2)
    for (const key of CONVERSATION_FILTER_LIST_KEYS) {
      expect(countActiveConversationFilters({ [key]: ["x"] })).toBe(1)
    }
  })

  it("setConversationFilterList replaces the facet and an empty list clears it", () => {
    const next = setConversationFilterList({ unread: true }, "agentIds", ["c1", "c2", "c1"])
    expect(next.agentIds).toEqual(["c1", "c2"])
    expect(next.unread).toBe(true)
    expect(setConversationFilterList(next, "agentIds", []).agentIds).toBe(
      EMPTY_CONVERSATION_FILTERS.agentIds
    )
  })

  it("toggleConversationFilterValue adds / removes one value and is a no-op when already there", () => {
    const on = toggleConversationFilterValue(undefined, "teamIds", "t1", true)
    expect(on.teamIds).toEqual(["t1"])
    const same = toggleConversationFilterValue(on, "teamIds", "t1", true)
    expect(same).toEqual(on)
    const both = toggleConversationFilterValue(on, "teamIds", "t2", true)
    expect(both.teamIds).toEqual(["t1", "t2"])
    const off = toggleConversationFilterValue(both, "teamIds", "t1", false)
    expect(off.teamIds).toEqual(["t2"])
    expect(toggleConversationFilterValue(off, "teamIds", "t2", false).teamIds).toHaveLength(0)
  })

  it("matches workspace / folder / agent lists (OR within, unassigned sentinel included)", () => {
    const f = (o: Record<string, unknown>) => resolveConversationFilters(o)
    expect(
      matchesConversationFilters(
        session({ projectId: "w1" }),
        f({ workspaceIds: ["w1", "w2"] }),
        undefined
      )
    ).toBe(true)
    expect(
      matchesConversationFilters(
        session({ projectId: "w3" }),
        f({ workspaceIds: ["w1", "w2"] }),
        undefined
      )
    ).toBe(false)
    expect(
      matchesConversationFilters(
        session({}),
        f({ workspaceIds: [CONVERSATION_FILTER_UNASSIGNED] }),
        undefined
      )
    ).toBe(true)
    expect(
      matchesConversationFilters(
        session({ projectId: "w1" }),
        f({ workspaceIds: [CONVERSATION_FILTER_UNASSIGNED] }),
        undefined
      )
    ).toBe(false)
    expect(
      matchesConversationFilters(session({ folderId: "f1" }), f({ folderIds: ["f1"] }), undefined)
    ).toBe(true)
    expect(
      matchesConversationFilters(
        session({ folderId: undefined }),
        f({ folderIds: [CONVERSATION_FILTER_UNASSIGNED] }),
        undefined
      )
    ).toBe(true)
    expect(
      matchesConversationFilters(session({ characterId: "c1" }), f({ agentIds: ["c2"] }), undefined)
    ).toBe(false)
    expect(
      matchesConversationFilters(session({ characterId: "c1" }), f({ agentIds: ["c1"] }), undefined)
    ).toBe(true)
  })

  it("matches team ids strictly — a session without a team never satisfies a team filter", () => {
    const filters = resolveConversationFilters({ teamIds: ["t1"] })
    expect(
      matchesConversationFilters(session({ kind: "team", teamId: "t1" }), filters, undefined)
    ).toBe(true)
    expect(
      matchesConversationFilters(session({ kind: "team", teamId: "t2" }), filters, undefined)
    ).toBe(false)
    expect(matchesConversationFilters(session({}), filters, undefined)).toBe(false)
  })

  it("matches models / providers via the row value first, then the injected fallback chain", () => {
    const filters = resolveConversationFilters({ models: ["claude"], providers: ["anthropic"] })
    const ctx = { modelOf: () => "claude", providerOf: () => "anthropic" }
    expect(matchesConversationFilters(session({}), filters, undefined, ctx)).toBe(true)
    expect(matchesConversationFilters(session({ model: "gpt" }), filters, undefined, ctx)).toBe(
      false
    )
    expect(
      matchesConversationFilters(session({ providerOverride: "openai" }), filters, undefined, ctx)
    ).toBe(false)
    // Unknown (no row value, no resolver) never matches a model filter.
    expect(matchesConversationFilters(session({}), filters, undefined)).toBe(false)
  })
})

describe("activity window", () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 7, 16, 12)

  it("resolves unknown activity to 'any' and keeps every valid option", () => {
    const raw = { activity: "yesteryear" } as unknown as Parameters<
      typeof resolveConversationFilters
    >[0]
    expect(resolveConversationFilters(raw).activity).toBe("any")
    for (const activity of CONVERSATION_ACTIVITY_FILTER_OPTIONS) {
      expect(setConversationActivityFilter(undefined, activity).activity).toBe(activity)
    }
    expect(countActiveConversationFilters({ activity: "today" })).toBe(1)
    expect(countActiveConversationFilters({ activity: "any" })).toBe(0)
  })

  it("buckets by calendar days like the date grouping", () => {
    expect(matchesConversationActivity("any", now, undefined)).toBe(true)
    expect(matchesConversationActivity("today", now, now - 60_000)).toBe(true)
    expect(matchesConversationActivity("today", now, now - 2 * DAY)).toBe(false)
    expect(matchesConversationActivity("week", now, now - 5 * DAY)).toBe(true)
    expect(matchesConversationActivity("week", now, now - 9 * DAY)).toBe(false)
    expect(matchesConversationActivity("month", now, now - 20 * DAY)).toBe(true)
    expect(matchesConversationActivity("month", now, now - 40 * DAY)).toBe(false)
    expect(matchesConversationActivity("older", now, now - 40 * DAY)).toBe(true)
    expect(matchesConversationActivity("older", now, now - 2 * DAY)).toBe(false)
    // Never-stamped sessions only surface under "older".
    expect(matchesConversationActivity("older", now, undefined)).toBe(true)
    expect(matchesConversationActivity("week", now, undefined)).toBe(false)
  })

  it("uses lastMessageAt, then updatedAt, against the injected clock", () => {
    const filters = resolveConversationFilters({ activity: "today" })
    expect(
      matchesConversationFilters(
        session({ lastMessageAt: now - 1000, updatedAt: now - 40 * DAY }),
        filters,
        undefined,
        { now }
      )
    ).toBe(true)
    expect(
      matchesConversationFilters(session({ updatedAt: now - 1000 }), filters, undefined, { now })
    ).toBe(true)
    expect(
      matchesConversationFilters(session({ updatedAt: now - 3 * DAY }), filters, undefined, { now })
    ).toBe(false)
  })

  it("measures creation time when the sort axis is creation", () => {
    // "Today" has to mean the same thing as the bucket header above the row.
    // Under the created sort that header says "created today", so a chat made a
    // month ago and used this morning must NOT survive the filter.
    const filters = resolveConversationFilters({ activity: "today" })
    const usedTodayMadeLastMonth = session({
      createdAt: now - 40 * DAY,
      lastMessageAt: now - 1000,
    })
    const madeTodayLongIdle = session({ createdAt: now - 1000, lastMessageAt: now - 40 * DAY })
    expect(matchesConversationFilters(usedTodayMadeLastMonth, filters, undefined, { now })).toBe(
      true
    )
    expect(
      matchesConversationFilters(usedTodayMadeLastMonth, filters, undefined, {
        now,
        timeBasis: "created",
      })
    ).toBe(false)
    expect(
      matchesConversationFilters(madeTodayLongIdle, filters, undefined, {
        now,
        timeBasis: "created",
      })
    ).toBe(true)
  })
})

describe("sort axis → time basis", () => {
  it("reads creation time only under the created sort", () => {
    expect(resolveConversationTimeBasis("created")).toBe("created")
    for (const sortBy of CONVERSATION_SORT_BY_OPTIONS.filter((s) => s !== "created")) {
      expect(resolveConversationTimeBasis(sortBy)).toBe("activity")
    }
  })

  it("admits date buckets only for the modes that have a date axis", () => {
    // `title` and `unread` order by something that is not time; bucketing them
    // by date would put headers on a list the headers do not explain.
    expect(CONVERSATION_SORT_BY_OPTIONS.filter(sortSupportsDateBuckets)).toEqual([
      "recent",
      "oldest",
      "created",
    ])
  })
})

describe("conversationFiltersEqual", () => {
  it("ignores list order and treats absent as empty", () => {
    expect(
      conversationFiltersEqual({ workspaceIds: ["a", "b"] }, { workspaceIds: ["b", "a"] })
    ).toBe(true)
    expect(conversationFiltersEqual(undefined, {})).toBe(true)
    expect(conversationFiltersEqual({ unread: true }, { unread: true, kind: "all" })).toBe(true)
  })

  it("detects any facet difference", () => {
    expect(conversationFiltersEqual({ unread: true }, { pinned: true })).toBe(false)
    expect(conversationFiltersEqual({ kind: "dm" }, { kind: "team" })).toBe(false)
    expect(conversationFiltersEqual({ activity: "week" }, {})).toBe(false)
    expect(conversationFiltersEqual({ models: ["a"] }, { models: ["a", "b"] })).toBe(false)
    expect(conversationFiltersEqual({ models: ["a"] }, { models: ["b"] })).toBe(false)
  })
})

describe("presets", () => {
  const preset = (id: string, name: string, filters: object, createdAt = 1) => ({
    id,
    name,
    filters,
    createdAt,
  })

  it("normalizes names: trims, collapses whitespace, clamps, rejects blank", () => {
    expect(normalizeConversationFilterPresetName("  My   filter  ")).toBe("My filter")
    expect(normalizeConversationFilterPresetName("   ")).toBeNull()
    expect(normalizeConversationFilterPresetName("x".repeat(100))).toHaveLength(
      CONVERSATION_FILTER_PRESET_NAME_MAX
    )
  })

  it("resolves persisted presets: drops bad ids, blank names, duplicates, and no-op filters", () => {
    const raw = [
      preset("a", "Unread", { unread: true }),
      preset("a", "Dup", { pinned: true }),
      preset("", "No id", { pinned: true }),
      preset("b", "  ", { pinned: true }),
      preset("c", "Nothing", {}),
      preset("d", "Team week", { kind: "team", activity: "week" }, 5),
      null,
    ] as unknown as Parameters<typeof resolveConversationFilterPresets>[0]
    const resolved = resolveConversationFilterPresets(raw)
    expect(resolved.map((p) => p.id)).toEqual(["a", "d"])
    expect(resolved[1]).toEqual({
      id: "d",
      name: "Team week",
      filters: { ...EMPTY_CONVERSATION_FILTERS, kind: "team", activity: "week" },
      createdAt: 5,
    })
    expect(resolveConversationFilterPresets(undefined)).toEqual([])
  })

  it("adds a preset, refusing blank names, no-op filters and duplicate ids", () => {
    const base = addConversationFilterPreset([], {
      id: "p1",
      name: " Unread team ",
      filters: { unread: true, kind: "team" },
      createdAt: 10,
    })
    expect(base).toEqual([
      {
        id: "p1",
        name: "Unread team",
        filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
        createdAt: 10,
      },
    ])
    expect(
      addConversationFilterPreset(base, {
        id: "p2",
        name: " ",
        filters: { unread: true },
        createdAt: 1,
      })
    ).toEqual(base)
    expect(
      addConversationFilterPreset(base, { id: "p2", name: "Empty", filters: {}, createdAt: 1 })
    ).toEqual(base)
    expect(
      addConversationFilterPreset(base, {
        id: "p1",
        name: "Again",
        filters: { pinned: true },
        createdAt: 1,
      })
    ).toEqual(base)
  })

  it("renames and removes by id", () => {
    const list = [preset("a", "One", { unread: true }), preset("b", "Two", { pinned: true })]
    expect(renameConversationFilterPreset(list, "b", " Deux ").map((p) => p.name)).toEqual([
      "One",
      "Deux",
    ])
    expect(renameConversationFilterPreset(list, "b", "  ").map((p) => p.name)).toEqual([
      "One",
      "Two",
    ])
    expect(renameConversationFilterPreset(list, "zzz", "X").map((p) => p.name)).toEqual([
      "One",
      "Two",
    ])
    expect(removeConversationFilterPreset(list, "a").map((p) => p.id)).toEqual(["b"])
    expect(removeConversationFilterPreset(list, "nope")).toHaveLength(2)
  })

  it("finds the preset matching the active filters, never for an unfiltered list", () => {
    const list = [
      preset("a", "Unread", { unread: true }),
      preset("b", "Team", { kind: "team", workspaceIds: ["w1", "w2"] }),
    ]
    expect(findMatchingConversationFilterPreset(list, { unread: true })?.id).toBe("a")
    expect(
      findMatchingConversationFilterPreset(list, { kind: "team", workspaceIds: ["w2", "w1"] })?.id
    ).toBe("b")
    expect(findMatchingConversationFilterPreset(list, { pinned: true })).toBeUndefined()
    expect(findMatchingConversationFilterPreset(list, undefined)).toBeUndefined()
  })
})
