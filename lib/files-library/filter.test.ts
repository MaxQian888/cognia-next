import {
  filterFilesEntries,
  matchesProject,
  matchesSearch,
  matchesType,
  sortFilesEntries,
} from "./filter"
import type { FilesEntry } from "./types"

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "key">): FilesEntry {
  return {
    kind: "artifact",
    sourceId: overrides.key,
    title: overrides.key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: overrides.key.toLowerCase(),
    ...overrides,
  }
}

const base = { tab: "all" as const, type: "all" as const, search: "", projectScope: "all" as const }

describe("filterFilesEntries", () => {
  const entries = [
    entry({ key: "a", kind: "artifact", favoritedAt: 1 }),
    entry({ key: "c", kind: "canvas", folderId: "root" }),
    entry({ key: "i", kind: "image", folderId: "lbf_1" }),
    entry({ key: "u", kind: "upload", ownedByFiles: true }),
    entry({ key: "s", kind: "session-upload", hidden: true }),
  ]

  it("applies each tab", () => {
    const keys = (tab: Parameters<typeof filterFilesEntries>[1]["tab"], folderId?: string) =>
      filterFilesEntries(entries, { ...base, tab, folderId }).map((e) => e.key)
    expect(keys("all")).toEqual(["a", "c", "i", "u"])
    expect(keys("recent")).toEqual(["a", "c", "i", "u"])
    expect(keys("images")).toEqual(["i"])
    expect(keys("favorites")).toEqual(["a"])
    expect(keys("folders")).toEqual(["c"])
    expect(keys("folders", "lbf_1")).toEqual(["i"])
  })

  it("filters by type, including both upload kinds under file", () => {
    expect(matchesType(entries[3]!, "file")).toBe(true)
    expect(matchesType(entries[4]!, "file")).toBe(true)
    expect(matchesType(entries[0]!, "file")).toBe(false)
    expect(matchesType(entries[1]!, "canvas")).toBe(true)
    expect(matchesType(entries[2]!, "image")).toBe(true)
    expect(matchesType(entries[0]!, "artifact")).toBe(true)
  })

  it("treats rows without a workspace as shared", () => {
    expect(matchesProject(entry({ key: "x" }), "current", "p1")).toBe(true)
    expect(matchesProject(entry({ key: "x", projectIds: ["p2"] }), "current", "p1")).toBe(false)
    expect(matchesProject(entry({ key: "x", projectIds: ["p2", "p1"] }), "current", "p1")).toBe(
      true
    )
    expect(matchesProject(entry({ key: "x", projectIds: ["p2"] }), "all", "p1")).toBe(true)
    expect(matchesProject(entry({ key: "x", projectIds: ["p2"] }), "current", null)).toBe(true)
  })

  it("requires every search term", () => {
    const e = entry({ key: "x", searchText: "design spec for the parser" })
    expect(matchesSearch(e, "  Spec  parser ")).toBe(true)
    expect(matchesSearch(e, "spec lexer")).toBe(false)
    expect(matchesSearch(e, "")).toBe(true)
  })
})

describe("sortFilesEntries", () => {
  const entries = [
    entry({ key: "b", title: "Beta", updatedAt: 5, createdAt: 1, byteSize: 1 }),
    entry({
      key: "a",
      title: "alpha 10",
      updatedAt: 3,
      createdAt: 9,
      byteSize: 30,
      lastAccessedAt: 20,
    }),
    entry({ key: "c", title: "alpha 2", updatedAt: 4, createdAt: 3, byteSize: 20, favoritedAt: 1 }),
    entry({ key: "i", title: "", updatedAt: 1, createdAt: 2 }),
  ]
  const keys = (list: FilesEntry[]) => list.map((e) => e.key)

  it("orders by each sort", () => {
    expect(keys(sortFilesEntries(entries, "recent", "all"))).toEqual(["a", "b", "c", "i"])
    expect(keys(sortFilesEntries(entries, "updated", "all"))).toEqual(["b", "c", "a", "i"])
    expect(keys(sortFilesEntries(entries, "created", "all"))).toEqual(["a", "c", "i", "b"])
    expect(keys(sortFilesEntries(entries, "name", "all"))).toEqual(["c", "a", "b", "i"])
    expect(keys(sortFilesEntries(entries, "size", "all"))).toEqual(["a", "c", "b", "i"])
  })

  it("pins favorites on the Recent tab and orders Favorites by when they were favorited", () => {
    expect(keys(sortFilesEntries(entries, "recent", "recent"))).toEqual(["c", "a", "b", "i"])
    const favs = [entry({ key: "x", favoritedAt: 1 }), entry({ key: "y", favoritedAt: 5 })]
    expect(keys(sortFilesEntries(favs, "recent", "favorites"))).toEqual(["y", "x"])
    expect(keys(sortFilesEntries(favs, "name", "favorites"))).toEqual(["x", "y"])
  })

  it("puts untitled items after named ones by name", () => {
    const list = [
      entry({ key: "u1", title: "", createdAt: 1 }),
      entry({ key: "u2", title: "", createdAt: 2 }),
      entry({ key: "n", title: "z" }),
    ]
    expect(keys(sortFilesEntries(list, "name", "all"))).toEqual(["n", "u2", "u1"])
  })
})
