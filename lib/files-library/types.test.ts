import {
  entryKindLabelKey,
  entrySource,
  FILES_LENSES,
  FILES_MODIFIED_WITHIN,
  FILES_SIZE_BANDS,
  FILES_SORT_KEYS,
  FILES_TYPE_GROUPS,
  isVideoEntry,
  type FilesEntry,
} from "./types"

describe("files-library types", () => {
  it("lists the type groups, lenses, sort columns and filter options in display order", () => {
    expect(FILES_TYPE_GROUPS).toEqual(["documents", "artifacts", "images", "videos", "uploads"])
    expect(FILES_LENSES).toEqual(["suggested", "favorites", "mine", "ai", "shared"])
    expect(FILES_SORT_KEYS).toEqual(["name", "source", "activity", "size", "type"])
    expect(FILES_MODIFIED_WITHIN).toEqual(["any", "day", "week", "month", "year"])
    expect(FILES_SIZE_BANDS).toEqual(["any", "small", "medium", "large", "huge"])
  })

  it("builds the write source from an entry, snapshot included", () => {
    const entry: FilesEntry = {
      key: "session-upload:c1",
      kind: "session-upload",
      sourceId: "c1",
      title: "SPEC.md",
      sourceTitle: "SPEC.md",
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
      sharedWithMe: false,
      creator: "user",
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
    // A generated video's record goes into the snapshot, so it outlives its job row.
    // The snapshot keeps the source's own title, never the name Files shows.
    expect(entrySource({ ...entry, title: "Renamed in Files" }).snapshot?.title).toBe("SPEC.md")
    const generated = { jobId: "vjob_1", prompt: "waves", providerId: "google", modelId: "veo" }
    expect(entrySource({ ...entry, generated }).snapshot?.generated).toEqual(generated)
  })

  it("labels an uploaded video as a video, and nothing else", () => {
    expect(isVideoEntry({ kind: "session-upload", mediaType: "video/mp4" })).toBe(true)
    expect(isVideoEntry({ kind: "upload", mediaType: "VIDEO/WEBM" })).toBe(true)
    expect(isVideoEntry({ kind: "upload", mediaType: "application/pdf" })).toBe(false)
    expect(isVideoEntry({ kind: "image", mediaType: "video/mp4" })).toBe(false)
    expect(entryKindLabelKey({ kind: "upload", mediaType: "video/mp4" })).toBe("video")
    expect(entryKindLabelKey({ kind: "session-upload", mediaType: "text/plain" })).toBe(
      "session-upload"
    )
    expect(entryKindLabelKey({ kind: "canvas" })).toBe("canvas")
    expect(entryKindLabelKey({ kind: "image", mediaType: "video/mp4" })).toBe("image")
    expect(isVideoEntry({ kind: "upload" })).toBe(false)
  })
})
