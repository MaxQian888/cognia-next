import {
  entryKindLabelKey,
  entrySource,
  FILES_SORTS,
  FILES_TABS,
  FILES_TYPE_FILTERS,
  isVideoEntry,
  type FilesEntry,
} from "./types"

describe("files-library types", () => {
  it("lists the tabs, type filters and sorts in display order", () => {
    expect(FILES_TABS).toEqual(["recent", "favorites", "folders", "images", "all"])
    expect(FILES_TYPE_FILTERS).toEqual(["all", "artifact", "canvas", "image", "video", "file"])
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
    // A generated video's record goes into the snapshot, so it outlives its job row.
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
  })
})
