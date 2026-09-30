import type { ChatSession } from "@cognia/agent-config-types"
import type { Artifact, CanvasDocument } from "@/types/artifact/artifact"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { putLibraryAsset, putSessionAsset } from "@/lib/db/session-assets"
import { setLibraryItemFavorite } from "@/lib/db/files-library-items"
import { LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import type { MessageMediaRow } from "@/lib/db/message-media"
import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"
import {
  loadFilesSources,
  loadImages,
  rawArtifacts,
  rawCanvases,
  rawGeneratedVideos,
} from "./sources"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().sessions.bulkPut([
    { id: "s1", title: "s1", createdAt: 1, updatedAt: 1, projectId: "p1" } as ChatSession,
    { id: "s2", title: "s2", createdAt: 1, updatedAt: 1 } as ChatSession,
  ])
})
afterAll(fixture.dispose)

function media(hash: string, createdAt: number, mediaType = "image/png"): MessageMediaRow {
  return {
    hash,
    mediaType,
    width: 1,
    height: 1,
    blob: new Blob([hash]),
    byteSize: hash.length,
    createdAt,
    lastUsedAt: createdAt,
  }
}

describe("store snapshots", () => {
  it("normalizes artifact and canvas dates, including serialized ones", () => {
    const [artifact] = rawArtifacts({
      a: {
        id: "a",
        sessionId: "s1",
        messageId: "m",
        type: "document",
        title: "Doc",
        content: "x",
        version: 1,
        createdAt: new Date(1_000),
        updatedAt: "1970-01-01T00:00:02.000Z" as unknown as Date,
        metadata: { lastAccessedAt: new Date(3_000) },
      } as Artifact,
    })
    expect(artifact).toMatchObject({ createdAt: 1_000, updatedAt: 2_000, lastAccessedAt: 3_000 })
    const [canvas] = rawCanvases({
      c: {
        id: "c",
        sessionId: "standalone",
        title: "C",
        content: "",
        language: "markdown",
        type: "text",
        createdAt: new Date(5),
        updatedAt: "bogus" as unknown as Date,
      } as CanvasDocument,
    })
    expect(canvas).toMatchObject({ createdAt: 5, updatedAt: 0, language: "markdown" })
  })
})

describe("loadImages", () => {
  it("pages the newest canonical images, skips originals, and adds kept older ones", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut([
      media("new", 30),
      media("mid", 20),
      media("old", 10),
      media("original:x", 40),
      media("doc", 50, "application/pdf"),
    ])
    await db.messageMediaRefs.bulkPut([
      { messageId: "m1", sessionId: "s1", hash: "new" },
      { messageId: "m2", sessionId: "s2", hash: "new" },
      { messageId: "library:image:old", sessionId: LIBRARY_REF_SESSION_ID, hash: "old" },
    ])
    const { images, truncated } = await loadImages(1, ["old", "missing"])
    expect(truncated).toBe(true)
    expect(images.map((image) => image.hash)).toEqual(["new", "old"])
    expect(images[0]!.sessionIds.sort()).toEqual(["s1", "s2"])
    expect(images[1]!.sessionIds).toEqual([])
  })
})

function job(
  id: string,
  status: MediaGenerationJobRow["status"],
  result?: MediaGenerationJobRow["result"]
): MediaGenerationJobRow {
  return {
    id,
    kind: "video",
    origin: { surface: "plugin", pluginId: "p" },
    request: { prompt: `prompt of ${id}` },
    provider: { providerId: "google", modelId: "veo", credentialAffinity: "a" },
    operation: {},
    status,
    pollCount: 0,
    nextPollAt: 0,
    deadlineAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...(result ? { result } : {}),
  }
}

describe("rawGeneratedVideos", () => {
  it("keeps succeeded jobs stored in a conversation or in Files, with their record", () => {
    const videos = rawGeneratedVideos([
      job("chat", "succeeded", {
        content: { kind: "session-asset", sessionId: "s1", assetId: "video-chat" },
        mediaType: "video/mp4",
        byteSize: 1,
        durationSec: 5,
        width: 1280,
        height: 720,
      }),
      job("plugin", "succeeded", {
        content: { kind: "library", assetId: "video-plugin" },
        mediaType: "video/mp4",
        byteSize: 1,
      }),
      job("flow", "succeeded", {
        content: { kind: "file", relativePath: "generated-videos/flow.mp4", path: "/x" },
        mediaType: "video/mp4",
        byteSize: 1,
      }),
      job("failed", "failed"),
    ])
    expect(videos).toEqual([
      {
        jobId: "chat",
        prompt: "prompt of chat",
        providerId: "google",
        modelId: "veo",
        durationSec: 5,
        width: 1280,
        height: 720,
        home: { kind: "session-asset", sessionId: "s1", assetId: "video-chat" },
      },
      {
        jobId: "plugin",
        prompt: "prompt of plugin",
        providerId: "google",
        modelId: "veo",
        home: { kind: "library", assetId: "video-plugin" },
      },
    ])
  })
})

describe("loadFilesSources", () => {
  it("collects every source with its live sessions and held kept originals", async () => {
    const db = getDb()
    await db.messageMedia.put(media("img", 5))
    await db.messageMediaRefs.put({ messageId: "m1", sessionId: "s1", hash: "img" })
    await putSessionAsset({
      sessionId: "s2",
      assetId: "a1",
      blob: new Blob(["report"]),
      filename: "report.txt",
      mediaType: "text/plain",
    })
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["mine"]),
      filename: "mine.md",
      mediaType: "text/markdown",
    })
    await db.mediaGenerationJobs.bulkPut([
      job("vjob_ok", "succeeded", {
        content: { kind: "session-asset", sessionId: "s2", assetId: "video-vjob_ok" },
        mediaType: "video/mp4",
        byteSize: 1,
      }),
      job("vjob_running", "generating"),
    ])
    const [asset] = await db.messageMediaRefs
      .where("messageId")
      .startsWith("session-asset:")
      .toArray()
    await setLibraryItemFavorite(
      {
        kind: "session-upload",
        sourceId: asset!.sessionAsset!.contentHash,
        mediaHash: asset!.hash,
      },
      true
    )

    const { input, imagesTruncated } = await loadFilesSources({
      artifacts: {
        a: {
          id: "a",
          sessionId: "gone",
          messageId: "m",
          type: "code",
          title: "A",
          content: "",
          version: 1,
          createdAt: new Date(1),
          updatedAt: new Date(1),
        } as Artifact,
      },
      canvasDocuments: {
        c: {
          id: "c",
          sessionId: "standalone",
          title: "C",
          content: "",
          language: "markdown",
          type: "text",
          createdAt: new Date(1),
          updatedAt: new Date(1),
        } as CanvasDocument,
      },
    })
    expect(imagesTruncated).toBe(false)
    expect(input.images.map((image) => image.hash)).toEqual(["img"])
    expect(input.sessionUploads.map((upload) => upload.assetId)).toEqual(["a1"])
    expect(input.libraryUploads.map((upload) => upload.assetId)).toEqual(["u1"])
    expect(input.generatedVideos.map((video) => video.jobId)).toEqual(["vjob_ok"])
    expect(input.items.map((item) => item.key).sort()).toEqual(
      [`session-upload:${asset!.sessionAsset!.contentHash}`, "upload:u1"].sort()
    )
    expect([...input.sessions.entries()].sort()).toEqual([
      ["s1", { projectId: "p1" }],
      ["s2", {}],
    ])
    expect([...input.heldOriginals]).toEqual([asset!.hash])
  })
})
