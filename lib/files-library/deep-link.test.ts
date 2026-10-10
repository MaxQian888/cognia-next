import {
  DEFAULT_FILES_LENS,
  DEFAULT_FILES_SECTION,
  filesLocationHref,
  isFilesLens,
  parseFilesLocation,
  parseFilesSection,
  sameFilesSection,
  serializeFilesSection,
} from "./deep-link"
import { FILES_LENSES, FILES_TYPE_GROUPS, type FilesSection } from "./types"

function params(query: string) {
  return new URLSearchParams(query)
}

describe("serializeFilesSection / parseFilesSection", () => {
  const sections: FilesSection[] = [
    { kind: "all" },
    { kind: "recent" },
    { kind: "trash" },
    ...FILES_TYPE_GROUPS.map((group) => ({ kind: "group" as const, group })),
    { kind: "folder", folderId: "root" },
    { kind: "folder", folderId: "lbf_123" },
  ]

  it("serializes each place", () => {
    expect(serializeFilesSection({ kind: "all" })).toBe("all")
    expect(serializeFilesSection({ kind: "recent" })).toBe("recent")
    expect(serializeFilesSection({ kind: "trash" })).toBe("trash")
    expect(serializeFilesSection({ kind: "group", group: "videos" })).toBe("group:videos")
    expect(serializeFilesSection({ kind: "folder", folderId: "lbf_1" })).toBe("folder:lbf_1")
  })

  it("round-trips every place", () => {
    for (const section of sections) {
      expect(parseFilesSection(serializeFilesSection(section))).toEqual(section)
    }
  })

  it("rejects empty and invalid values", () => {
    expect(parseFilesSection(null)).toBeUndefined()
    expect(parseFilesSection(undefined)).toBeUndefined()
    expect(parseFilesSection("")).toBeUndefined()
    expect(parseFilesSection("favorites")).toBeUndefined()
    expect(parseFilesSection("group:")).toBeUndefined()
    expect(parseFilesSection("group:spreadsheets")).toBeUndefined()
    expect(parseFilesSection("folder:")).toBeUndefined()
    expect(parseFilesSection("ALL")).toBeUndefined()
  })
})

describe("isFilesLens", () => {
  it("accepts every lens and nothing else", () => {
    for (const lens of FILES_LENSES) expect(isFilesLens(lens)).toBe(true)
    expect(isFilesLens("recent")).toBe(false)
    expect(isFilesLens("")).toBe(false)
    expect(isFilesLens(null)).toBe(false)
    expect(isFilesLens(undefined)).toBe(false)
  })
})

describe("parseFilesLocation", () => {
  it("reads section, lens and item", () => {
    expect(parseFilesLocation(params("section=group:images&tab=ai&item=image:h1"))).toEqual({
      location: { section: { kind: "group", group: "images" }, lens: "ai", item: "image:h1" },
      legacy: false,
    })
  })

  it("returns an empty location for a bare URL", () => {
    expect(parseFilesLocation(params(""))).toEqual({ location: {}, legacy: false })
  })

  it("drops invalid values", () => {
    expect(parseFilesLocation(params("section=bogus&tab=bogus&item="))).toEqual({
      location: {},
      legacy: false,
    })
  })

  it.each([
    ["recent", { kind: "recent" }],
    ["folders", { kind: "folder", folderId: "root" }],
    ["images", { kind: "group", group: "images" }],
    ["all", { kind: "all" }],
  ] as const)("maps the ADR-0200 tab %s to a place and flags it legacy", (tab, section) => {
    expect(parseFilesLocation(params(`tab=${tab}`))).toEqual({
      location: { section },
      legacy: true,
    })
  })

  it("keeps an explicit section over a legacy tab", () => {
    expect(parseFilesLocation(params("section=trash&tab=images"))).toEqual({
      location: { section: { kind: "trash" } },
      legacy: true,
    })
  })

  it("keeps favorites a lens, not a legacy place", () => {
    expect(parseFilesLocation(params("tab=favorites&item=artifact:a1"))).toEqual({
      location: { lens: "favorites", item: "artifact:a1" },
      legacy: false,
    })
  })
})

describe("filesLocationHref", () => {
  it("leaves defaults out", () => {
    expect(filesLocationHref({})).toBe("/files")
    expect(filesLocationHref({ section: DEFAULT_FILES_SECTION, lens: DEFAULT_FILES_LENS })).toBe(
      "/files"
    )
  })

  it("writes non-default section and lens", () => {
    expect(filesLocationHref({ section: { kind: "trash" }, lens: "shared" })).toBe(
      "/files?section=trash&tab=shared"
    )
  })

  it("encodes the item key and folder ids", () => {
    const href = filesLocationHref({
      section: { kind: "folder", folderId: "lbf 1" },
      item: "session-upload:a&b=c",
    })
    expect(href).toBe("/files?section=folder%3Albf+1&item=session-upload%3Aa%26b%3Dc")
    expect(parseFilesLocation(new URLSearchParams(href.split("?")[1]))).toEqual({
      location: { section: { kind: "folder", folderId: "lbf 1" }, item: "session-upload:a&b=c" },
      legacy: false,
    })
  })

  it("rewrites a legacy URL to its canonical form", () => {
    const { location } = parseFilesLocation(params("tab=folders"))
    expect(filesLocationHref(location)).toBe("/files?section=folder%3Aroot")
  })
})

describe("sameFilesSection", () => {
  it("compares sections by value", () => {
    expect(sameFilesSection({ kind: "all" }, { kind: "all" })).toBe(true)
    expect(
      sameFilesSection({ kind: "folder", folderId: "a" }, { kind: "folder", folderId: "a" })
    ).toBe(true)
    expect(
      sameFilesSection({ kind: "folder", folderId: "a" }, { kind: "folder", folderId: "b" })
    ).toBe(false)
    expect(
      sameFilesSection({ kind: "group", group: "images" }, { kind: "group", group: "videos" })
    ).toBe(false)
    expect(sameFilesSection({ kind: "recent" }, { kind: "trash" })).toBe(false)
  })
})
