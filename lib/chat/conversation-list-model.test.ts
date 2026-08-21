import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

import {
  buildConversationSections,
  conversationSectionKey,
  dateBucketFor,
  dedupeSessionsById,
  DATE_BUCKET_ORDER,
  UNGROUPED_ID,
  type BuildSectionsOptions,
} from "./conversation-list-model"

const DAY = 86_400_000
// Fixed "now": 2026-06-25 12:00 local. Tests derive timestamps relative to it.
const NOW = new Date(2026, 5, 25, 12, 0, 0).getTime()

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: id,
    createdAt: NOW - DAY,
    updatedAt: NOW,
    ...overrides,
  }
}

function folder(id: string, overrides: Partial<SessionFolder> = {}): SessionFolder {
  return { id, name: id, order: 0, createdAt: NOW, updatedAt: NOW, ...overrides }
}

function opts(overrides: Partial<BuildSectionsOptions> = {}): BuildSectionsOptions {
  return {
    query: "",
    view: "active",
    now: NOW,
    collapsedFolderIds: new Set<string>(),
    ...overrides,
  }
}

describe("conversationSectionKey", () => {
  it("derives a stable key per section kind", () => {
    expect(conversationSectionKey({ kind: "pinned" })).toBe("pinned")
    expect(conversationSectionKey({ kind: "folder", folder: folder("f1") })).toBe("folder:f1")
    expect(conversationSectionKey({ kind: "date", bucket: "today" })).toBe("date:today")
    expect(conversationSectionKey({ kind: "recent" })).toBe("recent")
    expect(conversationSectionKey({ kind: "search" })).toBe("search")
  })

  it("namespaces group sections by axis so a workspace and an agent can share an id", () => {
    // The key is what scopes `manualOrder` to one section; colliding keys would
    // let an order dragged in a workspace pin the row inside an agent group too.
    const group = { id: "x", name: "X" }
    expect(conversationSectionKey({ kind: "group", axis: "workspace", group })).toBe("workspace:x")
    expect(conversationSectionKey({ kind: "group", axis: "agent", group })).toBe("agent:x")
  })
})

describe("dedupeSessionsById", () => {
  it("returns the input untouched when every id is unique", () => {
    const sessions = [session("a"), session("b")]
    // Same reference, so memoized consumers keep their identity in the common case.
    expect(dedupeSessionsById(sessions)).toBe(sessions)
  })

  it("keeps the first slot but the freshest copy of a repeated id", () => {
    const first = session("a", { title: "stale", updatedAt: NOW - 5 })
    const later = session("a", { title: "fresh", updatedAt: NOW })
    const older = session("a", { title: "older still", updatedAt: NOW - 10 })
    const result = dedupeSessionsById([first, session("b"), later, older])
    expect(result.map((s) => s.id)).toEqual(["a", "b"])
    expect(result[0]).toBe(later)
  })

  it("keeps the first copy on an updatedAt tie or missing timestamps", () => {
    const first = session("a", { updatedAt: undefined as unknown as number })
    const second = session("a", { updatedAt: undefined as unknown as number })
    expect(dedupeSessionsById([first, second])[0]).toBe(first)
  })
})

describe("groupBy: workspace", () => {
  const workspaces = [
    { id: "w1", name: "Alpha" },
    { id: "w2", name: "Beta" },
  ]

  const workspaceOpts = (overrides: Partial<BuildSectionsOptions> = {}) =>
    opts({ groupBy: "workspace", workspaces, activeWorkspaceId: "w1", ...overrides })

  it("sorts the active workspace first and starts the others collapsed", () => {
    const sessions = [
      session("b1", { projectId: "w2" }),
      session("a1", { projectId: "w1" }),
      session("a2", { projectId: "w1", updatedAt: NOW - DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], workspaceOpts())
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["workspace:w1", "workspace:w2"])
    const [alpha, beta] = sections
    expect(alpha.kind === "group" && alpha.collapsed).toBe(false)
    expect(beta.kind === "group" && beta.collapsed).toBe(true)
    expect(alpha.sessions.map((s) => s.id)).toEqual(["a1", "a2"])
  })

  it("keeps collapsed groups out of orderedIds", () => {
    const sessions = [session("a1", { projectId: "w1" }), session("b1", { projectId: "w2" })]
    const { orderedIds } = buildConversationSections(sessions, [], workspaceOpts())
    expect(orderedIds).toEqual(["a1"])
  })

  it("honors an explicit expand of a non-active workspace", () => {
    const sessions = [session("a1", { projectId: "w1" }), session("b1", { projectId: "w2" })]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      workspaceOpts({ groupCollapseOverrides: { "workspace:w2": false } })
    )
    expect(sections[1].kind === "group" && sections[1].collapsed).toBe(false)
    expect(orderedIds).toEqual(["a1", "b1"])
  })

  it("honors an explicit collapse of the active workspace", () => {
    const sessions = [session("a1", { projectId: "w1" })]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      workspaceOpts({ groupCollapseOverrides: { "workspace:w1": true } })
    )
    expect(sections[0].kind === "group" && sections[0].collapsed).toBe(true)
    expect(orderedIds).toEqual([])
  })

  it("keeps the caller's order and expands everything before a workspace is active", () => {
    // The project store hydrates asynchronously, so the sidebar renders at
    // least once with no active workspace; nothing may be hidden then.
    const sessions = [session("b1", { projectId: "w2" }), session("a1", { projectId: "w1" })]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "workspace", workspaces, activeWorkspaceId: null })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["workspace:w1", "workspace:w2"])
    expect(sections.every((s) => s.kind === "group" && !s.collapsed)).toBe(true)
    expect(orderedIds).toEqual(["a1", "b1"])
  })

  it("keeps the caller's order when the active workspace is not in the list", () => {
    const sessions = [session("a1", { projectId: "w1" })]
    const { sections } = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "workspace", workspaces, activeWorkspaceId: "deleted" })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["workspace:w1"])
  })

  it("collects unknown and missing workspaces into one trailing ungrouped section", () => {
    const sessions = [
      // Pre-isolation row (Dexie v86 stamps `projectId` on write).
      session("legacy"),
      // Points at a workspace that has since been deleted.
      session("orphan", { projectId: "gone" }),
      session("a1", { projectId: "w1" }),
    ]
    const { sections } = buildConversationSections(sessions, [], workspaceOpts())
    expect(sections.map((s) => conversationSectionKey(s))).toEqual([
      "workspace:w1",
      `workspace:${UNGROUPED_ID}`,
    ])
    expect(sections[1].sessions.map((s) => s.id)).toEqual(["legacy", "orphan"])
    // The renderer supplies a translated label rather than the model inventing one.
    expect(sections[1].kind === "group" && sections[1].group.name).toBe("")
    // Pre-isolation rows are grandfathered into every workspace, so unlike a
    // non-active workspace this bucket must not fold itself away.
    expect(sections[1].kind === "group" && sections[1].collapsed).toBe(false)
  })

  it("emits a workspace once even when the caller's list repeats its id", () => {
    // The project / character list is caller-supplied; a repeated id would
    // otherwise emit two `workspace:w2` sections holding the same rows — a
    // duplicate React key and a chat listed twice.
    const sessions = [session("a1", { projectId: "w1" }), session("b1", { projectId: "w2" })]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      workspaceOpts({
        workspaces: [...workspaces, { id: "w2", name: "Beta (dup)" }],
        groupCollapseOverrides: { "workspace:w2": false },
      })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["workspace:w1", "workspace:w2"])
    // The first occurrence keeps its slot and its display name.
    expect(sections[1].kind === "group" && sections[1].group.name).toBe("Beta")
    expect(orderedIds).toEqual(["a1", "b1"])
  })

  it("still lets pinned and folders outrank the workspace axis", () => {
    const f = folder("f1")
    const sessions = [
      session("pinned1", { projectId: "w1", pinned: true }),
      session("foldered", { projectId: "w2", folderId: "f1" }),
      session("loose", { projectId: "w1" }),
    ]
    const { sections } = buildConversationSections(sessions, [f], workspaceOpts())
    expect(sections.map((s) => s.kind)).toEqual(["pinned", "folder", "group"])
    expect(sections[2].sessions.map((s) => s.id)).toEqual(["loose"])
  })

  it("scopes manualOrder to the workspace it was dragged in", () => {
    const sessions = [
      session("a-none", { projectId: "w1", updatedAt: NOW }),
      session("a-first", {
        projectId: "w1",
        manualOrder: 0,
        manualOrderSection: "workspace:w1",
        updatedAt: NOW - 10 * DAY,
      }),
      // An order set in another section must not pin this row to the top here.
      session("a-elsewhere", {
        projectId: "w1",
        manualOrder: 0,
        manualOrderSection: "date:today",
        updatedAt: NOW - 20 * DAY,
      }),
    ]
    const { sections } = buildConversationSections(sessions, [], workspaceOpts())
    // `a-none` is newer than the arranged row so it opens the group;
    // `a-elsewhere` carries a rank from another section, so it is ordered by
    // recency and lands below the row it does not outrank.
    expect(sections[0].sessions.map((s) => s.id)).toEqual(["a-none", "a-first", "a-elsewhere"])
  })
})

describe("groupBy: agent", () => {
  it("groups by the bound character and never auto-collapses", () => {
    const sessions = [
      session("s1", { characterId: "c1" }),
      session("s2", { characterId: "c2" }),
      session("s3"),
    ]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({
        groupBy: "agent",
        agents: [
          { id: "c1", name: "Alice" },
          { id: "c2", name: "Bob" },
        ],
        // Only the workspace axis has a non-uniform default.
        activeWorkspaceId: "w1",
      })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual([
      "agent:c1",
      "agent:c2",
      `agent:${UNGROUPED_ID}`,
    ])
    expect(sections.every((s) => s.kind === "group" && !s.collapsed)).toBe(true)
    expect(orderedIds).toEqual(["s1", "s2", "s3"])
  })
})

describe("groupBy: team", () => {
  const teams = [
    { id: "t1", name: "Alpha" },
    { id: "t2", name: "Beta" },
  ]

  it("emits one section per team, in the caller's order", () => {
    const sessions = [
      session("a", { kind: "team", teamId: "t1" }),
      session("b", { kind: "team", teamId: "t2" }),
      session("c", { kind: "team", teamId: "t1" }),
    ]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "team", teams })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["team:t1", "team:t2"])
    expect(orderedIds).toEqual(["a", "c", "b"])
  })

  it("puts direct conversations in the ungrouped bucket rather than dropping them", () => {
    // The mobile list has no guild rail, so team mode used to show it a list
    // that was not grouped at all. Direct chats carry no teamId — they belong
    // in a bucket the renderer labels, not in a team's section.
    const sessions = [session("dm"), session("team", { kind: "team", teamId: "t1" })]
    const { sections } = buildConversationSections(sessions, [], opts({ groupBy: "team", teams }))
    expect(sections.map((s) => conversationSectionKey(s))).toEqual([
      "team:t1",
      `team:${UNGROUPED_ID}`,
    ])
  })

  it("does not collapse anything by default — only the workspace axis does that", () => {
    const sessions = [session("a", { kind: "team", teamId: "t1" })]
    const { sections } = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "team", teams, activeWorkspaceId: "w1" })
    )
    expect(sections.every((s) => s.kind === "group" && !s.collapsed)).toBe(true)
  })

  it("keys team sections separately from a workspace sharing the id", () => {
    const group = { id: "x", name: "X" }
    expect(conversationSectionKey({ kind: "group", axis: "team", group })).toBe("team:x")
  })
})

describe("date buckets follow the sort axis", () => {
  // Created a month ago, used today: the two axes disagree about this row, which
  // is exactly what the old model got wrong.
  const stale = session("stale", { createdAt: NOW - 40 * DAY, updatedAt: NOW })
  // Created today, untouched since: the mirror image.
  const fresh = session("fresh", { createdAt: NOW, updatedAt: NOW - 40 * DAY })

  it("buckets by last activity under the default recency sort", () => {
    const { sections } = buildConversationSections([stale, fresh], [], opts({ groupBy: "date" }))
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["date:today", "date:older"])
    expect(sections[0]!.sessions.map((s) => s.id)).toEqual(["stale"])
  })

  it("buckets by creation time under the created sort", () => {
    const { sections } = buildConversationSections(
      [stale, fresh],
      [],
      opts({ groupBy: "date", sortBy: "created" })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["date:today", "date:older"])
    // "Today" now means created today — the opposite row from the recency case.
    expect(sections[0]!.sessions.map((s) => s.id)).toEqual(["fresh"])
  })

  it("reverses the bucket order under the oldest sort so headers and rows agree", () => {
    const sessions = [session("now"), session("old", { updatedAt: NOW - 40 * DAY })]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "date", sortBy: "oldest" })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["date:older", "date:today"])
    expect(orderedIds).toEqual(["old", "now"])
  })

  it("falls back to creation-less rows' activity time rather than stranding them in older", () => {
    const legacy = { ...session("legacy"), createdAt: undefined } as unknown as ChatSession
    const { sections } = buildConversationSections(
      [legacy],
      [],
      opts({ groupBy: "date", sortBy: "created" })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["date:today"])
  })

  it.each(["title", "unread"] as const)(
    "renders one flat section under %s, which has no date axis",
    (sortBy) => {
      const sessions = [session("b"), session("a", { updatedAt: NOW - 40 * DAY })]
      const { sections } = buildConversationSections(
        sessions,
        [],
        opts({ groupBy: "date", sortBy })
      )
      expect(sections.map((s) => conversationSectionKey(s))).toEqual(["recent"])
    }
  )

  it("still groups by workspace under title sort — only the date axis drops out", () => {
    const sessions = [session("a", { projectId: "w1" })]
    const { sections } = buildConversationSections(
      sessions,
      [],
      opts({
        groupBy: "workspace",
        sortBy: "title",
        workspaces: [{ id: "w1", name: "W1" }],
        activeWorkspaceId: "w1",
      })
    )
    expect(sections.map((s) => conversationSectionKey(s))).toEqual(["workspace:w1"])
  })
})

describe("searchIncludesArchived", () => {
  const active = session("active", { title: "deploy notes" })
  const archived = session("archived", { title: "deploy plan", archivedAt: NOW - DAY })

  it("keeps the archive split closed while browsing, whatever the flag says", () => {
    // Browsing is the view toggle's job; the flag is about what a QUERY may
    // find. Without this the two controls would describe the same thing.
    const { orderedIds } = buildConversationSections(
      [active, archived],
      [],
      opts({ searchIncludesArchived: true })
    )
    expect(orderedIds).toEqual(["active"])
  })

  it("reaches archived rows from the active view while searching", () => {
    const { orderedIds } = buildConversationSections(
      [active, archived],
      [],
      opts({ query: "deploy", searchIncludesArchived: true })
    )
    expect(orderedIds.sort()).toEqual(["active", "archived"])
  })

  it("reaches active rows from the archived view too — the flag lifts the split, not one side", () => {
    const { orderedIds } = buildConversationSections(
      [active, archived],
      [],
      opts({ query: "deploy", view: "archived", searchIncludesArchived: true })
    )
    expect(orderedIds.sort()).toEqual(["active", "archived"])
  })

  it("stays inside the view when the flag is off", () => {
    const { orderedIds } = buildConversationSections(
      [active, archived],
      [],
      opts({ query: "deploy" })
    )
    expect(orderedIds).toEqual(["active"])
  })

  it("leaves `total` describing the view, so an empty view still reads as empty", () => {
    // A hit from the other side of the split is not evidence that THIS view has
    // something in it — `total` is what picks the first-run empty state.
    const model = buildConversationSections(
      [archived],
      [],
      opts({ query: "deploy", searchIncludesArchived: true })
    )
    expect(model.total).toBe(0)
    expect(model.filteredCount).toBe(1)
  })

  it("still applies the quick filters to rows pulled across the split", () => {
    const pinnedArchived = session("pinned", {
      title: "deploy pinned",
      archivedAt: NOW - DAY,
      pinned: true,
    })
    const { orderedIds } = buildConversationSections(
      [active, archived, pinnedArchived],
      [],
      opts({ query: "deploy", searchIncludesArchived: true, filters: { pinned: true } })
    )
    expect(orderedIds).toEqual(["pinned"])
  })
})

describe("visibleCount", () => {
  it("excludes rows inside a collapsed section while filteredCount keeps them", () => {
    // The chip says "showing N of M"; a folded group must move N. It must NOT
    // move `filteredCount`, which is what tells an empty result from a folded
    // one — collapsing everything would otherwise offer to clear filters that
    // were never the problem.
    const sessions = [session("a", { folderId: "f1" }), session("b")]
    const model = buildConversationSections(
      sessions,
      [folder("f1")],
      opts({ collapsedFolderIds: new Set(["f1"]) })
    )
    expect(model.filteredCount).toBe(2)
    expect(model.visibleCount).toBe(1)
    expect(model.orderedIds).toEqual(["b"])
  })

  it("equals filteredCount when nothing is folded", () => {
    const model = buildConversationSections([session("a"), session("b")], [], opts())
    expect(model.visibleCount).toBe(model.filteredCount)
  })

  it("counts every search hit", () => {
    const model = buildConversationSections(
      [session("alpha"), session("beta")],
      [],
      opts({ query: "a" })
    )
    expect(model.visibleCount).toBe(model.filteredCount)
  })
})

describe("scoreTitle injection", () => {
  it("ranks by the injected scorer, highest first", () => {
    const sessions = [session("low"), session("high")]
    const { orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({
        query: "x",
        scoreTitle: (title) => (title === "high" ? 0.9 : 0.1),
      })
    )
    expect(orderedIds).toEqual(["high", "low"])
  })

  it("lets a scorer admit a title the substring rank would reject", () => {
    // The point of sharing the ⌘K ranker: "dply" has to find "deploy".
    const { orderedIds } = buildConversationSections(
      [session("deploy")],
      [],
      opts({ query: "dply", scoreTitle: () => 0.3 })
    )
    expect(orderedIds).toEqual(["deploy"])
  })

  it("keeps every title hit ahead of every content-only hit, whatever the scores", () => {
    // A weak fuzzy title hit still beats a strong message match: the user typed
    // a name, not a sentence.
    const sessions = [session("weak-title"), session("content")]
    const { orderedIds, contentOnlyIds } = buildConversationSections(
      sessions,
      [],
      opts({
        query: "q",
        contentMatchIds: new Set(["content"]),
        scoreTitle: (title) => (title === "weak-title" ? 0.01 : null),
      })
    )
    expect(orderedIds).toEqual(["weak-title", "content"])
    expect([...contentOnlyIds]).toEqual(["content"])
  })

  it("receives the injected clock, never the wall clock", () => {
    const seen: number[] = []
    buildConversationSections(
      [session("a")],
      [],
      opts({
        query: "a",
        scoreTitle: (_title, _needle, _timestamp, now) => {
          seen.push(now)
          return 1
        },
      })
    )
    expect(seen).toEqual([NOW])
  })

  it("falls back to the substring rank when no scorer is injected", () => {
    const sessions = [
      session("anywhere-x-inside", { title: "reindex" }),
      session("prefix", { title: "index" }),
    ]
    const { orderedIds } = buildConversationSections(sessions, [], opts({ query: "index" }))
    expect(orderedIds).toEqual(["prefix", "anywhere-x-inside"])
  })
})

describe("dateBucketFor", () => {
  it("maps relative calendar distance to buckets", () => {
    expect(dateBucketFor(NOW, NOW)).toBe("today")
    expect(dateBucketFor(NOW, NOW - DAY)).toBe("yesterday")
    expect(dateBucketFor(NOW, NOW - 5 * DAY)).toBe("prev7")
    expect(dateBucketFor(NOW, NOW - 7 * DAY)).toBe("prev7")
    expect(dateBucketFor(NOW, NOW - 8 * DAY)).toBe("prev30")
    expect(dateBucketFor(NOW, NOW - 30 * DAY)).toBe("prev30")
    expect(dateBucketFor(NOW, NOW - 31 * DAY)).toBe("older")
  })

  it("clamps future timestamps (clock skew) to today", () => {
    expect(dateBucketFor(NOW, NOW + DAY)).toBe("today")
  })

  it("uses calendar days, not 24h windows", () => {
    // 1am today vs 11pm yesterday is < 24h apart but a different calendar day.
    const earlyToday = new Date(2026, 5, 25, 1, 0, 0).getTime()
    const lateYesterday = new Date(2026, 5, 24, 23, 0, 0).getTime()
    expect(dateBucketFor(earlyToday, lateYesterday)).toBe("yesterday")
  })
})

describe("buildConversationSections", () => {
  it("groups loose sessions into ordered, non-empty date buckets", () => {
    const sessions = [
      session("today1", { updatedAt: NOW }),
      session("yest", { updatedAt: NOW - DAY }),
      session("week", { updatedAt: NOW - 4 * DAY }),
      session("old", { updatedAt: NOW - 40 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    expect(sections.map((s) => s.kind === "date" && s.bucket)).toEqual([
      "today",
      "yesterday",
      "prev7",
      "older",
    ])
    // prev30 is omitted because it has no members.
    expect(sections.some((s) => s.kind === "date" && s.bucket === "prev30")).toBe(false)
  })

  it("excludes hidden subagent sessions from every surface (list + search)", () => {
    const sessions = [
      session("visible", { updatedAt: NOW }),
      session("sub", { updatedAt: NOW, kind: "subagent", title: "hidden inner" }),
    ]
    const grouped = buildConversationSections(sessions, [], opts())
    expect(grouped.total).toBe(1)
    expect(grouped.orderedIds).toEqual(["visible"])
    // …and not matchable by search either.
    const searched = buildConversationSections(sessions, [], opts({ query: "hidden" }))
    expect(searched.filteredCount).toBe(0)
  })

  it("sorts within a bucket newest-first", () => {
    const sessions = [
      session("a", { updatedAt: NOW - 3 * 3_600_000 }),
      session("b", { updatedAt: NOW - 1 * 3_600_000 }),
      session("c", { updatedAt: NOW - 2 * 3_600_000 }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const today = sections.find((s) => s.kind === "date")
    expect(today && today.sessions.map((s) => s.id)).toEqual(["b", "c", "a"])
  })

  it("uses message activity instead of metadata-write time for bucketing and recency", () => {
    const sessions = [
      session("metadata-new", { updatedAt: NOW, lastMessageAt: NOW - 40 * DAY }),
      session("active", { updatedAt: NOW - DAY, lastMessageAt: NOW - DAY }),
    ]

    const { sections } = buildConversationSections(sessions, [], opts())

    expect(sections.map((section) => conversationSectionKey(section))).toEqual([
      "date:yesterday",
      "date:older",
    ])
    expect(sections[0].sessions.map((candidate) => candidate.id)).toEqual(["active"])
  })

  it("keeps an equal-recency bucket ordered across live-query refreshes", () => {
    const a = session("a", { createdAt: NOW - 2_000, updatedAt: NOW })
    const b = session("b", { createdAt: NOW - 1_000, updatedAt: NOW })
    const orderFor = (sessions: ChatSession[]) => {
      const section = buildConversationSections(sessions, [], opts()).sections.find(
        (candidate) => candidate.kind === "date" && candidate.bucket === "today"
      )
      return section?.sessions.map((candidate) => candidate.id)
    }

    // Dexie may re-emit equivalent rows in a different order after the active
    // conversation changes. Equal `updatedAt` values must not make the sidebar
    // visually swap those rows back and forth.
    expect(orderFor([a, b])).toEqual(["b", "a"])
    expect(orderFor([b, a])).toEqual(["b", "a"])
  })

  it("floats pinned to a dedicated top section, not duplicated in buckets", () => {
    const sessions = [
      session("pin", { pinned: true, updatedAt: NOW - 40 * DAY }),
      session("loose", { updatedAt: NOW }),
    ]
    const { sections, orderedIds } = buildConversationSections(sessions, [], opts())
    expect(sections[0]).toMatchObject({ kind: "pinned" })
    expect(sections[0].sessions.map((s) => s.id)).toEqual(["pin"])
    // "pin" appears once, at the top.
    expect(orderedIds).toEqual(["pin", "loose"])
  })

  it("shows pinned-and-foldered sessions in the pinned section (pinned > folder)", () => {
    const f = folder("f1")
    const sessions = [
      session("pinFoldered", { pinned: true, folderId: "f1", updatedAt: NOW }),
      session("plainFoldered", { folderId: "f1", updatedAt: NOW }),
    ]
    const { sections } = buildConversationSections(sessions, [f], opts())
    const pinnedSec = sections.find((s) => s.kind === "pinned")
    const folderSec = sections.find((s) => s.kind === "folder")
    expect(pinnedSec?.sessions.map((s) => s.id)).toEqual(["pinFoldered"])
    expect(folderSec?.sessions.map((s) => s.id)).toEqual(["plainFoldered"])
  })

  it("emits folder sections in order (even when empty) with collapse state", () => {
    const folders = [folder("b", { order: 2 }), folder("a", { order: 1 })]
    const sessions = [session("inA", { folderId: "a" })]
    const { sections } = buildConversationSections(
      sessions,
      folders,
      opts({ collapsedFolderIds: new Set(["a"]) })
    )
    const folderSecs = sections.filter((s) => s.kind === "folder")
    expect(folderSecs.map((s) => s.kind === "folder" && s.folder.id)).toEqual(["a", "b"])
    const a = folderSecs[0]
    expect(a.kind === "folder" && a.collapsed).toBe(true)
    expect(a.sessions.map((s) => s.id)).toEqual(["inA"])
    // Empty folder "b" is still emitted, with no members.
    const b = folderSecs[1]
    expect(b.sessions).toEqual([])
  })

  it("treats a session pointing at a deleted folder as loose", () => {
    const sessions = [session("orphan", { folderId: "ghost", updatedAt: NOW })]
    const { sections } = buildConversationSections(sessions, [], opts())
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ kind: "date", bucket: "today" })
  })

  it("flattens to a single search section on a non-empty query", () => {
    const sessions = [
      session("alpha", { title: "Trip planning", updatedAt: NOW - 40 * DAY }),
      session("beta", { title: "Trip budget", updatedAt: NOW }),
      session("gamma", { title: "Unrelated", updatedAt: NOW }),
    ]
    const { sections, filteredCount, total } = buildConversationSections(
      sessions,
      [],
      opts({ query: "  TRIP  " })
    )
    expect(sections).toHaveLength(1)
    expect(sections[0].kind).toBe("search")
    // Title substring, case-insensitive, newest-first.
    expect(sections[0].sessions.map((s) => s.id)).toEqual(["beta", "alpha"])
    expect(filteredCount).toBe(2)
    expect(total).toBe(3)
  })

  it("returns no sections when a search matches nothing", () => {
    const sessions = [session("a", { title: "hello" })]
    const { sections, filteredCount, total } = buildConversationSections(
      sessions,
      [],
      opts({ query: "zzz" })
    )
    expect(sections).toEqual([])
    expect(filteredCount).toBe(0)
    expect(total).toBe(1)
  })

  it("filters by archive view", () => {
    const sessions = [
      session("active1", { updatedAt: NOW }),
      session("archived1", { archivedAt: NOW - 1000, updatedAt: NOW }),
    ]
    const active = buildConversationSections(sessions, [], opts({ view: "active" }))
    expect(active.orderedIds).toEqual(["active1"])
    expect(active.total).toBe(1)

    const archived = buildConversationSections(sessions, [], opts({ view: "archived" }))
    expect(archived.orderedIds).toEqual(["archived1"])
    expect(archived.total).toBe(1)
  })

  it("flattens orderedIds in render order across all section kinds", () => {
    const f = folder("f1", { order: 1 })
    const sessions = [
      session("pinned1", { pinned: true, updatedAt: NOW }),
      session("foldered1", { folderId: "f1", updatedAt: NOW }),
      session("today1", { updatedAt: NOW }),
      session("old1", { updatedAt: NOW - 40 * DAY }),
    ]
    const { orderedIds } = buildConversationSections(sessions, [f], opts())
    expect(orderedIds).toEqual(["pinned1", "foldered1", "today1", "old1"])
  })

  it("lists a conversation once when the live query hands it over twice", () => {
    // Optimistic re-emits during a reorder / rename / insert transaction (and
    // overlapping subscriptions across a workspace switch) can repeat a row.
    // Every id becomes a React key and a section count downstream, so the model
    // owns the invariant: one row per id, freshest copy, first slot.
    const stale = session("dup", { title: "dup old", updatedAt: NOW - 1000, pinned: true })
    const fresh = session("dup", { title: "dup new", updatedAt: NOW, pinned: true })
    const sessions = [stale, session("other", { updatedAt: NOW - 1 }), fresh]
    const { sections, total, filteredCount, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts()
    )
    expect(orderedIds).toEqual(["dup", "other"])
    expect(total).toBe(2)
    expect(filteredCount).toBe(2)
    expect(sections[0].kind).toBe("pinned")
    expect(sections[0].sessions).toEqual([fresh])
    // Search mode flows through the same gate.
    const searched = buildConversationSections(sessions, [], opts({ query: "dup" }))
    expect(searched.orderedIds).toEqual(["dup"])
    expect(searched.sections[0].sessions.map((s) => s.title)).toEqual(["dup new"])
  })

  it("handles an empty session list", () => {
    const { sections, total, filteredCount, orderedIds } = buildConversationSections([], [], opts())
    expect(sections).toEqual([])
    expect(total).toBe(0)
    expect(filteredCount).toBe(0)
    expect(orderedIds).toEqual([])
  })

  it("treats a missing title as an empty string for search", () => {
    const sessions = [session("a", { title: undefined as unknown as string })]
    const { sections } = buildConversationSections(sessions, [], opts({ query: "x" }))
    expect(sections).toEqual([])
  })

  it("exposes a stable bucket order constant", () => {
    expect(DATE_BUCKET_ORDER).toEqual(["today", "yesterday", "prev7", "prev30", "older"])
  })

  it("collapses date buckets into a single recent section when grouping is off", () => {
    const sessions = [
      session("today1", { updatedAt: NOW }),
      session("old", { updatedAt: NOW - 40 * DAY }),
      session("pin", { pinned: true, updatedAt: NOW - 5 * DAY }),
    ]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "none" })
    )
    // Pinned still floats; loose sessions merge into one flat "recent" list.
    expect(sections.map((s) => s.kind)).toEqual(["pinned", "recent"])
    const recent = sections.find((s) => s.kind === "recent")
    expect(recent?.sessions.map((s) => s.id)).toEqual(["today1", "old"])
    expect(orderedIds).toEqual(["pin", "today1", "old"])
  })

  it("matches sessions by message content via contentMatchIds in search mode", () => {
    const sessions = [
      session("titleHit", { title: "Trip planning", updatedAt: NOW }),
      session("contentHit", { title: "Unrelated", updatedAt: NOW - DAY }),
      session("noHit", { title: "Nothing", updatedAt: NOW }),
    ]
    const { sections, filteredCount } = buildConversationSections(
      sessions,
      [],
      opts({ query: "trip", contentMatchIds: new Set(["contentHit"]) })
    )
    expect(sections[0].kind).toBe("search")
    // Title hit + content hit, newest-first; noHit excluded.
    expect(sections[0].sessions.map((s) => s.id)).toEqual(["titleHit", "contentHit"])
    expect(filteredCount).toBe(2)
  })

  it("orders the pinned section by manualOrder, slotting un-ordered pins in by recency", () => {
    // Both un-ordered pins are more recent than every arranged pin, so they
    // open the section rather than being appended after the arrangement — a
    // conversation the user just pinned must not land at the bottom.
    const sessions = [
      session("p-none-new", { pinned: true, updatedAt: NOW }),
      session("p2", { pinned: true, manualOrder: 2, updatedAt: NOW - 10 * DAY }),
      session("p0", { pinned: true, manualOrder: 0, updatedAt: NOW - 40 * DAY }),
      session("p-none-old", { pinned: true, updatedAt: NOW - 20 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const pinnedSec = sections.find((s) => s.kind === "pinned")
    expect(pinnedSec?.sessions.map((s) => s.id)).toEqual(["p-none-new", "p-none-old", "p0", "p2"])
  })

  it("slots an un-ordered pin after the arranged pins it does not outrank", () => {
    const sessions = [
      session("p0", { pinned: true, manualOrder: 0, updatedAt: NOW }),
      session("p1", { pinned: true, manualOrder: 1, updatedAt: NOW - 10 * DAY }),
      session("p-none", { pinned: true, updatedAt: NOW - 5 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const pinnedSec = sections.find((s) => s.kind === "pinned")
    expect(pinnedSec?.sessions.map((s) => s.id)).toEqual(["p0", "p-none", "p1"])
  })

  it("orders a date bucket by manualOrder, slotting un-ordered rows in by recency", () => {
    // All three land in "today"; manual order curates the bucket while the
    // un-dragged row takes the recency slot it deserves — here, the top.
    const sessions = [
      session("t-none", { updatedAt: NOW }),
      session("t1", { manualOrder: 1, updatedAt: NOW - 60_000 }),
      session("t0", { manualOrder: 0, updatedAt: NOW - 120_000 }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const today = sections.find((s) => s.kind === "date" && s.bucket === "today")
    expect(today?.sessions.map((s) => s.id)).toEqual(["t-none", "t0", "t1"])
  })

  it("puts a brand-new conversation at the top of a bucket that was drag-ordered", () => {
    // The regression this rule exists for: `setSessionOrder` renumbers the
    // whole section, so a chat created afterwards is the only row without a
    // rank — and used to be appended below every arranged row.
    const sessions = [
      session("dragged-a", {
        manualOrder: 0,
        manualOrderSection: "date:today",
        updatedAt: NOW - 60_000,
      }),
      session("dragged-b", {
        manualOrder: 1,
        manualOrderSection: "date:today",
        updatedAt: NOW - 120_000,
      }),
      session("just-created", { createdAt: NOW, updatedAt: NOW }),
    ]
    const { sections, orderedIds } = buildConversationSections(sessions, [], opts())
    const today = sections.find((s) => s.kind === "date" && s.bucket === "today")
    expect(today?.sessions.map((s) => s.id)).toEqual(["just-created", "dragged-a", "dragged-b"])
    expect(orderedIds[0]).toBe("just-created")
  })

  it("slots rows a filter hid during the drag back in by recency", () => {
    // A drag under an active quick filter renumbers only the rows that were on
    // screen. The rest keep no rank for this section, so they must land where
    // recency says — not behind the arranged pair, which is where the whole
    // unfiltered remainder used to end up.
    const sessions = [
      session("hidden-new", { updatedAt: NOW - 30_000 }),
      session("dragged-a", {
        manualOrder: 0,
        manualOrderSection: "date:today",
        updatedAt: NOW - 60_000,
      }),
      session("hidden-old", { updatedAt: NOW - 90_000 }),
      session("dragged-b", {
        manualOrder: 1,
        manualOrderSection: "date:today",
        updatedAt: NOW - 120_000,
      }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const today = sections.find((s) => s.kind === "date" && s.bucket === "today")
    expect(today?.sessions.map((s) => s.id)).toEqual([
      "hidden-new",
      "dragged-a",
      "hidden-old",
      "dragged-b",
    ])
  })

  it("keeps the arrangement intact and loses nothing, whatever the mix", () => {
    // The merge walks two sorted lists with one shared pointer; the invariants
    // it must never break are "every row appears exactly once" and "the
    // arranged rows keep their relative order". Deterministic pseudo-random
    // input (no `Math.random`) so a failure is reproducible.
    let seed = 20260820
    const nextInt = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % bound
    }
    for (let round = 0; round < 40; round++) {
      const size = 1 + nextInt(9)
      // Ranks are a 0..k-1 run, the way `setSessionOrder` writes them.
      let rank = 0
      const sessions = Array.from({ length: size }, (_, i) =>
        session(`s${i}`, {
          updatedAt: NOW - nextInt(size * 1000),
          ...(nextInt(2) === 0
            ? { manualOrder: rank++, manualOrderSection: "date:today" }
            : undefined),
        })
      )
      const { sections } = buildConversationSections(sessions, [], opts())
      const rendered = sections.flatMap((sec) => sec.sessions.map((s) => s.id))
      expect([...rendered].sort()).toEqual(sessions.map((s) => s.id).sort())
      const arranged = sessions
        .filter((s) => s.manualOrder != null)
        .sort((a, b) => a.manualOrder! - b.manualOrder!)
        .map((s) => s.id)
      expect(rendered.filter((id) => arranged.includes(id))).toEqual(arranged)
    }
  })

  it("ignores a manualOrder tagged with a different section (no cross-bucket leak)", () => {
    // "leaked" was dragged to rank 0 while it sat in "today"; now it lives in
    // "yesterday" where that rank must NOT apply — recency wins again.
    const sessions = [
      session("leaked", {
        manualOrder: 0,
        manualOrderSection: "date:today",
        updatedAt: NOW - 1 * DAY - 60_000,
      }),
      session("y-newer", { updatedAt: NOW - 1 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const yesterday = sections.find((s) => s.kind === "date" && s.bucket === "yesterday")
    expect(yesterday?.sessions.map((s) => s.id)).toEqual(["y-newer", "leaked"])
  })

  it("honors a manualOrder tagged with the section it renders in", () => {
    const sessions = [
      session("t-none", { updatedAt: NOW }),
      session("t0", {
        manualOrder: 0,
        manualOrderSection: "date:today",
        updatedAt: NOW - 120_000,
      }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const today = sections.find((s) => s.kind === "date" && s.bucket === "today")
    expect(today?.sessions.map((s) => s.id)).toEqual(["t-none", "t0"])
  })

  it("orders the flat recent list by manualOrder when date grouping is off", () => {
    const sessions = [
      session("r-none", { updatedAt: NOW }),
      session("r0", { manualOrder: 0, updatedAt: NOW - 40 * DAY }),
      session("r1", { manualOrder: 1, updatedAt: NOW - 10 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts({ groupBy: "none" }))
    const recent = sections.find((s) => s.kind === "recent")
    expect(recent?.sessions.map((s) => s.id)).toEqual(["r-none", "r0", "r1"])
  })

  it("excludes collapsed-folder sessions from orderedIds", () => {
    const f = folder("f1", { order: 1 })
    const sessions = [
      session("foldered", { folderId: "f1", updatedAt: NOW }),
      session("loose", { updatedAt: NOW }),
    ]
    const expanded = buildConversationSections(sessions, [f], opts())
    expect(expanded.orderedIds).toEqual(["foldered", "loose"])
    const collapsed = buildConversationSections(
      sessions,
      [f],
      opts({ collapsedFolderIds: new Set(["f1"]) })
    )
    // "foldered" is hidden under the collapsed folder → not navigable.
    expect(collapsed.orderedIds).toEqual(["loose"])
  })
})

describe("folder workspace scoping", () => {
  it("keeps a session in a folder of its own workspace", () => {
    const f = folder("f1", { projectId: "w1" })
    const sessions = [session("s1", { projectId: "w1", folderId: "f1" })]
    const { sections } = buildConversationSections(sessions, [f], opts())
    const folderSection = sections.find((s) => s.kind === "folder")
    expect(folderSection?.sessions.map((s) => s.id)).toEqual(["s1"])
  })

  it("drops a session filed into another workspace's folder back to the primary grouping", () => {
    // The list may span every workspace (`groupBy: "workspace"`) while the
    // folders it carries belong to the active one only. A row that ended up
    // pointing at a foreign folder must not render under it — that membership
    // disappears the moment the user switches workspaces.
    const f = folder("f1", { projectId: "w1" })
    const sessions = [session("foreign", { projectId: "w2", folderId: "f1" })]
    const { sections } = buildConversationSections(sessions, [f], opts())
    const folderSection = sections.find((s) => s.kind === "folder")
    expect(folderSection?.sessions).toEqual([])
    expect(sections.find((s) => s.kind === "date")?.sessions.map((s) => s.id)).toEqual(["foreign"])
  })

  it("grandfathers folders and sessions that predate workspace isolation", () => {
    // Either side missing = unknown, not a mismatch.
    const legacyFolder = folder("f1")
    const legacySession = session("s1", { folderId: "f1" })
    const { sections } = buildConversationSections([legacySession], [legacyFolder], opts())
    expect(sections.find((s) => s.kind === "folder")?.sessions.map((s) => s.id)).toEqual(["s1"])

    const scopedFolder = folder("f2", { projectId: "w1" })
    const looseSession = session("s2", { folderId: "f2" })
    const mixed = buildConversationSections([looseSession], [scopedFolder], opts())
    expect(mixed.sections.find((s) => s.kind === "folder")?.sessions.map((s) => s.id)).toEqual([
      "s2",
    ])
  })
})

describe("sortBy", () => {
  // Distinct activity, creation, and title orderings so each mode is provably
  // reading the field it claims to.
  const sessions = [
    session("beta", { title: "Beta", updatedAt: NOW - 2 * DAY, createdAt: NOW - 9 * DAY }),
    session("alpha", { title: "Alpha", updatedAt: NOW - 3 * DAY, createdAt: NOW - 1 * DAY }),
    session("gamma", { title: "Gamma", updatedAt: NOW - 1 * DAY, createdAt: NOW - 5 * DAY }),
  ]
  const flat = (
    sortBy: BuildSectionsOptions["sortBy"],
    extra: Partial<BuildSectionsOptions> = {}
  ) =>
    buildConversationSections(sessions, [], opts({ groupBy: "none", sortBy, ...extra })).orderedIds

  it("defaults to newest activity first", () => {
    expect(flat(undefined)).toEqual(["gamma", "beta", "alpha"])
    expect(flat("recent")).toEqual(["gamma", "beta", "alpha"])
  })

  it("reverses to oldest activity first", () => {
    expect(flat("oldest")).toEqual(["alpha", "beta", "gamma"])
  })

  it("sorts by creation time, which can disagree with activity", () => {
    expect(flat("created")).toEqual(["alpha", "gamma", "beta"])
  })

  it("sorts titles A→Z", () => {
    expect(flat("title")).toEqual(["alpha", "beta", "gamma"])
  })

  it("orders titles naturally, not lexicographically", () => {
    const numbered = [session("s10", { title: "Draft 10" }), session("s2", { title: "Draft 2" })]
    const model = buildConversationSections(
      numbered,
      [],
      opts({ groupBy: "none", sortBy: "title" })
    )
    expect(model.orderedIds).toEqual(["s2", "s10"])
  })

  it("floats unread conversations without losing recency underneath", () => {
    expect(flat("unread", { unreadIds: new Set(["alpha"]) })).toEqual(["alpha", "gamma", "beta"])
  })

  it("degrades to recency when the unread sort has no unread set", () => {
    expect(flat("unread")).toEqual(["gamma", "beta", "alpha"])
  })

  it("applies inside every section, not just the flat list", () => {
    const model = buildConversationSections(
      [
        session("p-b", { title: "B", pinned: true, updatedAt: NOW }),
        session("p-a", { title: "A", pinned: true, updatedAt: NOW - DAY }),
        session("loose", { title: "C", updatedAt: NOW }),
      ],
      [],
      opts({ groupBy: "none", sortBy: "title" })
    )
    const pinned = model.sections.find((s) => s.kind === "pinned")
    expect(pinned?.sessions.map((s) => s.id)).toEqual(["p-a", "p-b"])
  })

  it("keeps a total order when the primary key ties", () => {
    // Equal titles must not let a live-query refresh visibly swap two rows.
    const tied = [
      session("z", { title: "Same", updatedAt: NOW, createdAt: NOW }),
      session("a", { title: "Same", updatedAt: NOW, createdAt: NOW }),
    ]
    const forward = buildConversationSections(tied, [], opts({ groupBy: "none", sortBy: "title" }))
    const reversed = buildConversationSections(
      [...tied].reverse(),
      [],
      opts({ groupBy: "none", sortBy: "title" })
    )
    expect(forward.orderedIds).toEqual(["a", "z"])
    expect(reversed.orderedIds).toEqual(forward.orderedIds)
  })

  it("honors a manual drag order only under recency", () => {
    const dragged = [
      session("first", {
        title: "Zulu",
        updatedAt: NOW,
        manualOrder: 0,
        manualOrderSection: "recent",
      }),
      session("second", { title: "Alpha", updatedAt: NOW - DAY }),
    ]
    // Recency: the hand-placed row wins.
    expect(
      buildConversationSections(dragged, [], opts({ groupBy: "none", sortBy: "recent" })).orderedIds
    ).toEqual(["first", "second"])
    // Title: the axis the user just chose wins instead — otherwise the list
    // would silently ignore "A→Z" for an arbitrary subset of rows.
    expect(
      buildConversationSections(dragged, [], opts({ groupBy: "none", sortBy: "title" })).orderedIds
    ).toEqual(["second", "first"])
  })
})

describe("quick filters", () => {
  const sessions = [
    session("unread-dm", { updatedAt: NOW }),
    session("pinned-dm", { pinned: true, updatedAt: NOW - DAY }),
    session("branch-dm", { parentSessionId: "unread-dm", updatedAt: NOW - 2 * DAY }),
    session("team-chat", { kind: "team", teamId: "t1", updatedAt: NOW - 3 * DAY }),
  ]
  const unreadIds = new Set(["unread-dm", "team-chat"])
  const run = (filters: BuildSectionsOptions["filters"]) =>
    buildConversationSections(sessions, [], opts({ groupBy: "none", filters, unreadIds }))

  it("passes everything through when unfiltered", () => {
    const model = run(undefined)
    expect(model.filteredCount).toBe(4)
    expect(model.activeFilterCount).toBe(0)
  })

  it("keeps `total` describing the view so an over-filtered list is distinguishable", () => {
    // `total` is the archive-view count, deliberately BEFORE filters: it is what
    // separates "this view is empty" from "your filters matched nothing".
    const model = run({ unread: true, pinned: true })
    expect(model.total).toBe(4)
    expect(model.filteredCount).toBe(0)
    expect(model.sections).toEqual([])
  })

  it("narrows to unread", () => {
    const model = run({ unread: true })
    expect(model.orderedIds).toEqual(["unread-dm", "team-chat"])
    expect(model.activeFilterCount).toBe(1)
  })

  it("narrows to pinned, which still floats into the pinned section", () => {
    const model = run({ pinned: true })
    expect(model.orderedIds).toEqual(["pinned-dm"])
    expect(model.sections[0]?.kind).toBe("pinned")
  })

  it("narrows to branched conversations", () => {
    expect(run({ branched: true }).orderedIds).toEqual(["branch-dm"])
  })

  it("narrows by conversation kind", () => {
    expect(run({ kind: "team" }).orderedIds).toEqual(["team-chat"])
    // `pinned-dm` leads because pinned still floats above the flat list.
    expect(run({ kind: "dm" }).orderedIds).toEqual(["pinned-dm", "unread-dm", "branch-dm"])
  })

  it("ANDs facets and reports the count", () => {
    const model = run({ unread: true, kind: "dm" })
    expect(model.orderedIds).toEqual(["unread-dm"])
    expect(model.activeFilterCount).toBe(2)
  })

  it("narrows date buckets too, so a bucket count matches what is rendered", () => {
    const model = buildConversationSections(
      sessions,
      [],
      opts({ groupBy: "date", filters: { kind: "dm" }, unreadIds })
    )
    const bucketed = model.sections.flatMap((s) => (s.kind === "date" ? s.sessions : []))
    expect(bucketed.every((s) => s.kind !== "team")).toBe(true)
  })

  it("applies before search, so a filtered-out session cannot be found by title", () => {
    const model = buildConversationSections(
      sessions,
      [],
      opts({ query: "team", filters: { kind: "dm" }, unreadIds })
    )
    expect(model.filteredCount).toBe(0)
  })
})

describe("search ranking", () => {
  const sessions = [
    session("anywhere", { title: "Reindex the corpus", updatedAt: NOW }),
    session("word-start", { title: "The index rebuild", updatedAt: NOW - DAY }),
    session("prefix", { title: "Index maintenance", updatedAt: NOW - 2 * DAY }),
    session("content", { title: "Unrelated title", updatedAt: NOW - 3 * DAY }),
  ]

  it("ranks prefix over word-start over anywhere, despite recency", () => {
    // All three titles match "index"; the one the user almost certainly meant
    // is the one that starts with it, even though it is the least recent.
    const model = buildConversationSections(sessions, [], opts({ query: "index" }))
    expect(model.orderedIds).toEqual(["prefix", "word-start", "anywhere"])
  })

  it("sorts content-only hits below every title hit", () => {
    const model = buildConversationSections(
      sessions,
      [],
      opts({ query: "index", contentMatchIds: new Set(["content"]) })
    )
    expect(model.orderedIds).toEqual(["prefix", "word-start", "anywhere", "content"])
  })

  it("reports which hits matched only on content", () => {
    const model = buildConversationSections(
      sessions,
      [],
      opts({ query: "index", contentMatchIds: new Set(["content", "prefix"]) })
    )
    // `prefix` matched its title too, so it is not a content-only hit.
    expect([...model.contentOnlyIds]).toEqual(["content"])
  })

  it("exposes no content-only ids outside search mode", () => {
    expect(buildConversationSections(sessions, [], opts()).contentOnlyIds.size).toBe(0)
  })

  it("breaks rank ties with the active sort", () => {
    const tied = [
      session("b", { title: "Index B", updatedAt: NOW - DAY }),
      session("a", { title: "Index A", updatedAt: NOW }),
    ]
    expect(buildConversationSections(tied, [], opts({ query: "index" })).orderedIds).toEqual([
      "a",
      "b",
    ])
    expect(
      buildConversationSections(tied, [], opts({ query: "index", sortBy: "title" })).orderedIds
    ).toEqual(["a", "b"])
    expect(
      buildConversationSections(tied, [], opts({ query: "index", sortBy: "oldest" })).orderedIds
    ).toEqual(["b", "a"])
  })

  it("treats punctuation and symbols as word boundaries", () => {
    const punctuated = [
      session("mid", { title: "reindexer", updatedAt: NOW }),
      session("dashed", { title: "re-index run", updatedAt: NOW - DAY }),
    ]
    const model = buildConversationSections(punctuated, [], opts({ query: "index" }))
    expect(model.orderedIds).toEqual(["dashed", "mid"])
  })
})
