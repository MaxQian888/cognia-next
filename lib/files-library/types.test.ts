import { entrySource, FILES_SORTS, FILES_TABS, FILES_TYPE_FILTERS, type FilesEntry } from "./types"

describe("files-library types", () => {
  it("lists the tabs, type filters and sorts in display order", () => {
    expect(FILES_TABS).toEqual(["recent", "favorites", "folders", "images", "all"])
    expect(FILES_TYPE_FILTERS).toEqual(["all", "artifact", "canvas", "image", "file"])
    expect(FILES_SORTS).toEqual(["recent", "updated", "created", "name", "size"])
  })

  it("builds the write source from an entry, snapshot included", () => {
    const entry: FilesEntry = {
      key: "session-upload:c1",
      kind: "session-upload",
      sourceId: "c1",
      title: "SPEC.md",
      mediaType: "text/markdown",
      byteSize: 10,
      projectIds: ["p1", "p2"],
      sessionIds: ["s1"],
      originSessionId: "s1",
      originAlive: true,
      createdAt: 1,
      updatedAt: 1,
      ownedByFiles: false,
      hidden: false,
      mediaHash: "original:c1",
      contentHash: "c1",
      excerpt: "body",
      searchText: "",
    }
    expect(entrySource(entry)).toEqual({
      kind: "session-upload",
      sourceId: "c1",
      originSessionId: "s1",
      projectId: "p1",
      mediaHash: "original:c1",
      snapshot: {
        title: "SPEC.md",
        mediaType: "text/markdown",
        byteSize: 10,
        contentHash: "c1",
        extractedText: "body",
      },
    })
    expect(
      entrySource({
        ...entry,
        projectIds: [],
        originSessionId: undefined,
        mediaHash: undefined,
        mediaType: undefined,
        byteSize: undefined,
        contentHash: undefined,
        excerpt: undefined,
      })
    ).toEqual({
      kind: "session-upload",
      sourceId: "c1",
      snapshot: { title: "SPEC.md" },
    })
  })
})
