import {
  DEFAULT_FILES_FILTERS,
  filterFilesEntries,
  hasActiveFilters,
  isImageEntry,
  matchesGroup,
  matchesLens,
  matchesModified,
  matchesProject,
  matchesSearch,
  matchesSection,
  matchesSize,
  sortFilesEntries,
  type FilesQuery,
} from "./filter"
import type { FilesEntry, FilesSection } from "./types"

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "key">): FilesEntry {
  return {
    kind: "artifact",
    sourceId: overrides.key,
    title: overrides.key,
    sourceTitle: overrides.key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: overrides.key.toLowerCase(),
    ...overrides,
  }
}

const DAY = 24 * 60 * 60 * 1000
const MB = 1024 * 1024
const NOW = 1_000 * DAY

function query(overrides: Partial<FilesQuery> = {}): FilesQuery {
  return {
    section: { kind: "all" },
    lens: "suggested",
    filters: DEFAULT_FILES_FILTERS,
    search: "",
    activeProjectId: null,
    now: NOW,
    ...overrides,
  }
}

const keys = (list: readonly FilesEntry[]) => list.map((e) => e.key)

describe("hasActiveFilters", () => {
  it("is false for the defaults and a blank search", () => {
    expect(hasActiveFilters(DEFAULT_FILES_FILTERS, "")).toBe(false)
    expect(hasActiveFilters(DEFAULT_FILES_FILTERS, "   ")).toBe(false)
  })

  it("is true for a search, a format, a modified window or a size band", () => {
    expect(hasActiveFilters(DEFAULT_FILES_FILTERS, "spec")).toBe(true)
    expect(hasActiveFilters({ ...DEFAULT_FILES_FILTERS, formats: ["document"] }, "")).toBe(true)
    expect(hasActiveFilters({ ...DEFAULT_FILES_FILTERS, modified: "week" }, "")).toBe(true)
    expect(hasActiveFilters({ ...DEFAULT_FILES_FILTERS, size: "huge" }, "")).toBe(true)
  })

  it("does not count the workspace scope as a filter", () => {
    expect(hasActiveFilters({ ...DEFAULT_FILES_FILTERS, projectScope: "all" }, "")).toBe(false)
  })
})

describe("isImageEntry", () => {
  it("counts chat images and uploads whose bytes are an image", () => {
    expect(isImageEntry({ kind: "image" })).toBe(true)
    expect(isImageEntry({ kind: "upload", mediaType: "image/png" })).toBe(true)
    expect(isImageEntry({ kind: "session-upload", mediaType: "IMAGE/JPEG" })).toBe(true)
  })

  it("leaves other uploads and other kinds out", () => {
    expect(isImageEntry({ kind: "upload", mediaType: "application/pdf" })).toBe(false)
    expect(isImageEntry({ kind: "upload" })).toBe(false)
    expect(isImageEntry({ kind: "artifact", mediaType: "image/svg+xml" })).toBe(false)
    expect(isImageEntry({ kind: "canvas" })).toBe(false)
  })
})

describe("matchesGroup", () => {
  const canvas = entry({ key: "c", kind: "canvas" })
  const artifact = entry({ key: "a", kind: "artifact" })
  const image = entry({ key: "i", kind: "image" })
  const imageUpload = entry({ key: "iu", kind: "upload", mediaType: "image/png" })
  const video = entry({ key: "v", kind: "upload", mediaType: "video/mp4" })
  const sessionVideo = entry({ key: "sv", kind: "session-upload", mediaType: "video/webm" })
  const pdf = entry({ key: "p", kind: "upload", mediaType: "application/pdf" })
  const sessionDoc = entry({ key: "sd", kind: "session-upload", mediaType: "text/plain" })
  const all = [canvas, artifact, image, imageUpload, video, sessionVideo, pdf, sessionDoc]
  const inGroup = (group: Parameters<typeof matchesGroup>[1]) =>
    all.filter((e) => matchesGroup(e, group)).map((e) => e.key)

  it("documents are canvas documents", () => {
    expect(inGroup("documents")).toEqual(["c"])
  })

  it("artifacts are artifacts", () => {
    expect(inGroup("artifacts")).toEqual(["a"])
  })

  it("images include uploads whose bytes are an image", () => {
    expect(inGroup("images")).toEqual(["i", "iu"])
  })

  it("videos are video uploads of either kind", () => {
    expect(inGroup("videos")).toEqual(["v", "sv"])
  })

  it("uploads are the remaining files, without images or videos", () => {
    expect(inGroup("uploads")).toEqual(["p", "sd"])
  })
})

describe("matchesProject", () => {
  const shared = entry({ key: "s" })
  const inP1 = entry({ key: "p1", projectIds: ["p1"] })
  const inP2 = entry({ key: "p2", projectIds: ["p2", "p3"] })

  it("shows everything for the all scope or with no active workspace", () => {
    for (const e of [shared, inP1, inP2]) {
      expect(matchesProject(e, "all", "p1")).toBe(true)
      expect(matchesProject(e, "current", null)).toBe(true)
      expect(matchesProject(e, "current", undefined)).toBe(true)
    }
  })

  it("treats a row without a workspace as shared, and hides foreign ones", () => {
    expect(matchesProject(shared, "current", "p1")).toBe(true)
    expect(matchesProject(inP1, "current", "p1")).toBe(true)
    expect(matchesProject(inP2, "current", "p1")).toBe(false)
    expect(matchesProject(inP2, "current", "p3")).toBe(true)
  })
})

describe("matchesSearch", () => {
  const e = entry({ key: "x", searchText: "quarterly report\ntext/markdown" })

  it("matches every term case-insensitively", () => {
    expect(matchesSearch(e, "")).toBe(true)
    expect(matchesSearch(e, "  ")).toBe(true)
    expect(matchesSearch(e, "REPORT")).toBe(true)
    expect(matchesSearch(e, "quarterly   markdown")).toBe(true)
  })

  it("fails when any term is missing", () => {
    expect(matchesSearch(e, "report budget")).toBe(false)
  })
})

describe("matchesModified", () => {
  it("passes everything for any", () => {
    expect(matchesModified({ updatedAt: 0 }, "any", NOW)).toBe(true)
  })

  it("keeps changes within each window, inclusive of its edge", () => {
    expect(matchesModified({ updatedAt: NOW - DAY }, "day", NOW)).toBe(true)
    expect(matchesModified({ updatedAt: NOW - DAY - 1 }, "day", NOW)).toBe(false)
    expect(matchesModified({ updatedAt: NOW - 7 * DAY }, "week", NOW)).toBe(true)
    expect(matchesModified({ updatedAt: NOW - 7 * DAY - 1 }, "week", NOW)).toBe(false)
    expect(matchesModified({ updatedAt: NOW - 30 * DAY }, "month", NOW)).toBe(true)
    expect(matchesModified({ updatedAt: NOW - 31 * DAY }, "month", NOW)).toBe(false)
    expect(matchesModified({ updatedAt: NOW - 365 * DAY }, "year", NOW)).toBe(true)
    expect(matchesModified({ updatedAt: NOW - 366 * DAY }, "year", NOW)).toBe(false)
  })
})

describe("matchesSize", () => {
  it("passes every entry for any, even one of unknown size", () => {
    expect(matchesSize({ byteSize: undefined }, "any")).toBe(true)
    expect(matchesSize({ byteSize: 500 * MB }, "any")).toBe(true)
  })

  it("matches an unknown size only for any", () => {
    for (const band of ["small", "medium", "large", "huge"] as const) {
      expect(matchesSize({ byteSize: undefined }, band)).toBe(false)
    }
  })

  it("uses [min, max) bands", () => {
    expect(matchesSize({ byteSize: 0 }, "small")).toBe(true)
    expect(matchesSize({ byteSize: MB - 1 }, "small")).toBe(true)
    expect(matchesSize({ byteSize: MB }, "small")).toBe(false)
    expect(matchesSize({ byteSize: MB }, "medium")).toBe(true)
    expect(matchesSize({ byteSize: 10 * MB - 1 }, "medium")).toBe(true)
    expect(matchesSize({ byteSize: 10 * MB }, "medium")).toBe(false)
    expect(matchesSize({ byteSize: 10 * MB }, "large")).toBe(true)
    expect(matchesSize({ byteSize: 100 * MB - 1 }, "large")).toBe(true)
    expect(matchesSize({ byteSize: 100 * MB }, "large")).toBe(false)
    expect(matchesSize({ byteSize: 100 * MB }, "huge")).toBe(true)
    expect(matchesSize({ byteSize: 100 * MB - 1 }, "huge")).toBe(false)
  })
})

describe("matchesLens", () => {
  const mine = entry({ key: "mine", creator: "user" })
  const ai = entry({ key: "ai", creator: "ai" })
  const fav = entry({ key: "fav", creator: "user", favoritedAt: 5 })
  const sharedUser = entry({ key: "shared-user", creator: "user", sharedWithMe: true })
  const sharedAi = entry({ key: "shared-ai", creator: "ai", sharedWithMe: true })
  const all = [mine, ai, fav, sharedUser, sharedAi]
  const through = (lens: Parameters<typeof matchesLens>[1]) =>
    all.filter((e) => matchesLens(e, lens)).map((e) => e.key)

  it("suggested shows everything", () => {
    expect(through("suggested")).toEqual(keys(all))
  })

  it("favorites shows favorited entries", () => {
    expect(through("favorites")).toEqual(["fav"])
  })

  it("mine and ai split the account's own items by creator, without shared ones", () => {
    expect(through("mine")).toEqual(["mine", "fav"])
    expect(through("ai")).toEqual(["ai"])
  })

  it("shared shows what came from someone else's conversation", () => {
    expect(through("shared")).toEqual(["shared-user", "shared-ai"])
  })
})

describe("matchesSection", () => {
  const plain = entry({ key: "plain" })
  const hidden = entry({ key: "hidden", hidden: true })
  const trashed = entry({ key: "trashed", trashedAt: 10, folderId: "lbf_1" })
  const atRoot = entry({ key: "root", folderId: "root" })
  const inFolder = entry({ key: "in-folder", folderId: "lbf_1" })
  const image = entry({ key: "image", kind: "image" })
  const all = [plain, hidden, trashed, atRoot, inFolder, image]
  const inSection = (section: FilesSection) =>
    all.filter((e) => matchesSection(e, section)).map((e) => e.key)

  it("the Trash shows only trashed entries", () => {
    expect(inSection({ kind: "trash" })).toEqual(["trashed"])
  })

  it("every other place leaves trashed and hidden entries out", () => {
    expect(inSection({ kind: "all" })).toEqual(["plain", "root", "in-folder", "image"])
    expect(inSection({ kind: "recent" })).toEqual(["plain", "root", "in-folder", "image"])
    expect(inSection({ kind: "group", group: "images" })).toEqual(["image"])
  })

  it("a folder shows what is filed in it, the root included", () => {
    expect(inSection({ kind: "folder", folderId: "root" })).toEqual(["root"])
    expect(inSection({ kind: "folder", folderId: "lbf_1" })).toEqual(["in-folder"])
    expect(inSection({ kind: "folder", folderId: "lbf_missing" })).toEqual([])
  })
})

describe("filterFilesEntries", () => {
  const entries = [
    entry({ key: "a", kind: "artifact", favoritedAt: 1 }),
    entry({ key: "c", kind: "canvas", subtype: "text", creator: "user" }),
    entry({ key: "i", kind: "image", creator: "ai" }),
    entry({ key: "u", kind: "upload", sourceTitle: "deck.pdf", ownedByFiles: true }),
    entry({ key: "s", kind: "session-upload", hidden: true }),
    entry({ key: "t1", kind: "artifact", trashedAt: 3, creator: "ai" }),
    entry({ key: "t2", kind: "image", trashedAt: 4, sharedWithMe: true }),
  ]

  it("combines a place with a lens", () => {
    expect(keys(filterFilesEntries(entries, query()))).toEqual(["a", "c", "i", "u"])
    expect(keys(filterFilesEntries(entries, query({ lens: "favorites" })))).toEqual(["a"])
    expect(keys(filterFilesEntries(entries, query({ lens: "ai" })))).toEqual(["i"])
    expect(
      keys(filterFilesEntries(entries, query({ section: { kind: "group", group: "images" } })))
    ).toEqual(["i"])
  })

  it("also keeps what the host matched inside a body the entries do not carry", () => {
    const searched = query({ search: "revenue" })
    expect(keys(filterFilesEntries(entries, searched))).toEqual([])
    expect(
      keys(filterFilesEntries(entries, { ...searched, contentMatches: new Set(["c", "t1"]) }))
    ).toEqual(["c"])
  })

  it("ignores the lens in the Trash", () => {
    for (const lens of ["suggested", "favorites", "mine", "ai", "shared"] as const) {
      expect(
        keys(filterFilesEntries(entries, query({ section: { kind: "trash" }, lens })))
      ).toEqual(["t1", "t2"])
    }
  })

  it("filters by format", () => {
    const filters = { ...DEFAULT_FILES_FILTERS, formats: ["image", "document"] as const }
    expect(keys(filterFilesEntries(entries, query({ filters: { ...filters } })))).toEqual([
      "c",
      "i",
      "u",
    ])
    expect(
      keys(
        filterFilesEntries(
          entries,
          query({ filters: { ...DEFAULT_FILES_FILTERS, formats: ["code"] } })
        )
      )
    ).toEqual(["a"])
  })

  it("applies modified, size, workspace and search together", () => {
    const list = [
      entry({
        key: "fresh",
        updatedAt: NOW,
        byteSize: 10,
        projectIds: ["p1"],
        searchText: "fresh plan",
      }),
      entry({ key: "old", updatedAt: NOW - 40 * DAY, byteSize: 10, searchText: "old plan" }),
      entry({ key: "big", updatedAt: NOW, byteSize: 20 * MB, searchText: "big plan" }),
      entry({
        key: "foreign",
        updatedAt: NOW,
        byteSize: 10,
        projectIds: ["p2"],
        searchText: "foreign plan",
      }),
    ]
    const result = filterFilesEntries(
      list,
      query({
        filters: { formats: [], modified: "month", size: "small", projectScope: "current" },
        activeProjectId: "p1",
        search: "plan",
      })
    )
    expect(keys(result)).toEqual(["fresh"])
    expect(
      keys(
        filterFilesEntries(
          list,
          query({
            filters: { formats: [], modified: "any", size: "any", projectScope: "all" },
            activeProjectId: "p1",
            search: "PLAN",
          })
        )
      )
    ).toEqual(["fresh", "old", "big", "foreign"])
  })
})

describe("sortFilesEntries", () => {
  const all: Pick<FilesQuery, "section" | "lens" | "now"> = {
    section: { kind: "all" },
    lens: "mine",
    now: NOW,
  }

  describe("default order", () => {
    it("sorts the Trash by when an item went in, newest first", () => {
      const list = [
        entry({ key: "a", trashedAt: 1, updatedAt: 99 }),
        entry({ key: "b", trashedAt: 3, updatedAt: 1 }),
        entry({ key: "c", trashedAt: 2 }),
      ]
      expect(
        keys(
          sortFilesEntries(list, null, { section: { kind: "trash" }, lens: "suggested", now: NOW })
        )
      ).toEqual(["b", "c", "a"])
    })

    it("sorts Suggested by score, except in Recents which stays by recency", () => {
      const list = [
        // Changed just now, used nowhere.
        entry({ key: "fresh", updatedAt: NOW }),
        // Three days old, but a favorite reused across ten conversations.
        entry({
          key: "reused",
          updatedAt: NOW - 3 * DAY,
          favoritedAt: 1,
          sessionIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
        }),
      ]
      expect(
        keys(
          sortFilesEntries(list, null, { section: { kind: "all" }, lens: "suggested", now: NOW })
        )
      ).toEqual(["reused", "fresh"])
      expect(
        keys(
          sortFilesEntries(list, null, { section: { kind: "recent" }, lens: "suggested", now: NOW })
        )
      ).toEqual(["fresh", "reused"])
    })

    it("sorts Favorites by when an item was favorited", () => {
      const list = [
        entry({ key: "a", favoritedAt: 1, updatedAt: 100 }),
        entry({ key: "b", favoritedAt: 5, updatedAt: 1 }),
      ]
      expect(
        keys(
          sortFilesEntries(list, null, { section: { kind: "all" }, lens: "favorites", now: NOW })
        )
      ).toEqual(["b", "a"])
    })

    it("sorts everything else by last activity, an open counting as activity", () => {
      const list = [
        entry({ key: "a", updatedAt: 10 }),
        entry({ key: "b", updatedAt: 5, lastAccessedAt: 20 }),
        entry({ key: "c", updatedAt: 15 }),
      ]
      expect(keys(sortFilesEntries(list, null, all))).toEqual(["b", "c", "a"])
    })

    it("breaks ties on key", () => {
      const list = [entry({ key: "b" }), entry({ key: "c" }), entry({ key: "a" })]
      expect(keys(sortFilesEntries(list, null, all))).toEqual(["a", "b", "c"])
    })
  })

  describe("column sorts", () => {
    it("sorts by name with numeric collation, untitled entries last and newest first", () => {
      const list = [
        entry({ key: "n10", title: "file 10" }),
        entry({ key: "u-old", title: "", createdAt: 1 }),
        entry({ key: "n2", title: "File 2" }),
        entry({ key: "u-new", title: "", createdAt: 5 }),
      ]
      expect(keys(sortFilesEntries(list, { key: "name", dir: "asc" }, all))).toEqual([
        "n2",
        "n10",
        "u-new",
        "u-old",
      ])
      expect(keys(sortFilesEntries(list, { key: "name", dir: "desc" }, all))).toEqual([
        "u-old",
        "u-new",
        "n10",
        "n2",
      ])
    })

    it("sorts by source conversation, items without one after named sources", () => {
      const list = [
        entry({ key: "none" }),
        entry({ key: "beta", originSessionTitle: "Beta" }),
        entry({ key: "alpha", originSessionTitle: "alpha" }),
      ]
      expect(keys(sortFilesEntries(list, { key: "source", dir: "asc" }, all))).toEqual([
        "alpha",
        "beta",
        "none",
      ])
      expect(keys(sortFilesEntries(list, { key: "source", dir: "desc" }, all))).toEqual([
        "none",
        "beta",
        "alpha",
      ])
    })

    it("sorts by activity", () => {
      const list = [
        entry({ key: "a", updatedAt: 10 }),
        entry({ key: "b", updatedAt: 5, lastAccessedAt: 20 }),
        entry({ key: "c", updatedAt: 15 }),
      ]
      expect(keys(sortFilesEntries(list, { key: "activity", dir: "asc" }, all))).toEqual([
        "a",
        "c",
        "b",
      ])
      expect(keys(sortFilesEntries(list, { key: "activity", dir: "desc" }, all))).toEqual([
        "b",
        "c",
        "a",
      ])
    })

    it("sorts activity in the Trash by when an item went in", () => {
      const trash = { section: { kind: "trash" } as const, lens: "suggested" as const, now: NOW }
      const list = [
        entry({ key: "a", trashedAt: 30, updatedAt: 1 }),
        entry({ key: "b", trashedAt: 10, updatedAt: 99 }),
        entry({ key: "c", trashedAt: 20, updatedAt: 50 }),
      ]
      expect(keys(sortFilesEntries(list, { key: "activity", dir: "asc" }, trash))).toEqual([
        "b",
        "c",
        "a",
      ])
      expect(keys(sortFilesEntries(list, { key: "activity", dir: "desc" }, trash))).toEqual([
        "a",
        "c",
        "b",
      ])
    })

    it("sorts by size, unknown sizes smallest", () => {
      const list = [
        entry({ key: "big", byteSize: 100 }),
        entry({ key: "unknown" }),
        entry({ key: "small", byteSize: 1 }),
        entry({ key: "zero", byteSize: 0 }),
      ]
      expect(keys(sortFilesEntries(list, { key: "size", dir: "asc" }, all))).toEqual([
        "unknown",
        "zero",
        "small",
        "big",
      ])
      expect(keys(sortFilesEntries(list, { key: "size", dir: "desc" }, all))).toEqual([
        "big",
        "small",
        "zero",
        "unknown",
      ])
    })

    it("sorts by type in FILES_FORMATS order", () => {
      const list = [
        entry({ key: "image", kind: "image" }),
        entry({ key: "code", kind: "artifact", subtype: "code" }),
        entry({ key: "doc", kind: "canvas", subtype: "text" }),
      ]
      expect(keys(sortFilesEntries(list, { key: "type", dir: "asc" }, all))).toEqual([
        "doc",
        "code",
        "image",
      ])
      expect(keys(sortFilesEntries(list, { key: "type", dir: "desc" }, all))).toEqual([
        "image",
        "code",
        "doc",
      ])
    })

    it("breaks ties on key in both directions", () => {
      const list = [entry({ key: "b", byteSize: 1 }), entry({ key: "a", byteSize: 1 })]
      expect(keys(sortFilesEntries(list, { key: "size", dir: "asc" }, all))).toEqual(["a", "b"])
      expect(keys(sortFilesEntries(list, { key: "size", dir: "desc" }, all))).toEqual(["a", "b"])
    })

    it("never mutates its input", () => {
      const list = [entry({ key: "b" }), entry({ key: "a" })]
      sortFilesEntries(list, { key: "name", dir: "asc" }, all)
      expect(keys(list)).toEqual(["b", "a"])
    })
  })
})
