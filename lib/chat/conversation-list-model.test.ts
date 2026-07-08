import type { ChatSession, SessionFolder } from "@/lib/claude/types"

import {
  buildConversationSections,
  conversationSectionKey,
  dateBucketFor,
  DATE_BUCKET_ORDER,
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

  it("collapses date buckets into a single recent section when groupByDate is off", () => {
    const sessions = [
      session("today1", { updatedAt: NOW }),
      session("old", { updatedAt: NOW - 40 * DAY }),
      session("pin", { pinned: true, updatedAt: NOW - 5 * DAY }),
    ]
    const { sections, orderedIds } = buildConversationSections(
      sessions,
      [],
      opts({ groupByDate: false })
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

  it("orders the pinned section by manualOrder, un-ordered pins fall to the end by recency", () => {
    const sessions = [
      session("p-none-new", { pinned: true, updatedAt: NOW }),
      session("p2", { pinned: true, manualOrder: 2, updatedAt: NOW - 10 * DAY }),
      session("p0", { pinned: true, manualOrder: 0, updatedAt: NOW - 40 * DAY }),
      session("p-none-old", { pinned: true, updatedAt: NOW - 20 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const pinnedSec = sections.find((s) => s.kind === "pinned")
    expect(pinnedSec?.sessions.map((s) => s.id)).toEqual(["p0", "p2", "p-none-new", "p-none-old"])
  })

  it("orders a date bucket by manualOrder, un-ordered rows fall to the end by recency", () => {
    // All three land in "today"; manual order curates the bucket while the
    // un-dragged row keeps its recency slot at the end.
    const sessions = [
      session("t-none", { updatedAt: NOW }),
      session("t1", { manualOrder: 1, updatedAt: NOW - 60_000 }),
      session("t0", { manualOrder: 0, updatedAt: NOW - 120_000 }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts())
    const today = sections.find((s) => s.kind === "date" && s.bucket === "today")
    expect(today?.sessions.map((s) => s.id)).toEqual(["t0", "t1", "t-none"])
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
    expect(today?.sessions.map((s) => s.id)).toEqual(["t0", "t-none"])
  })

  it("orders the flat recent list by manualOrder when date grouping is off", () => {
    const sessions = [
      session("r-none", { updatedAt: NOW }),
      session("r0", { manualOrder: 0, updatedAt: NOW - 40 * DAY }),
      session("r1", { manualOrder: 1, updatedAt: NOW - 10 * DAY }),
    ]
    const { sections } = buildConversationSections(sessions, [], opts({ groupByDate: false }))
    const recent = sections.find((s) => s.kind === "recent")
    expect(recent?.sessions.map((s) => s.id)).toEqual(["r0", "r1", "r-none"])
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
