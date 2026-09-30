import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { putLibraryAsset, putSessionAsset } from "@/lib/db/session-assets"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { ChatSession } from "@cognia/agent-config-types"
import { downloadPayloadFor } from "./download"
import type { FilesEntry } from "./types"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "kind" | "sourceId">): FilesEntry {
  return {
    key: `${overrides.kind}:${overrides.sourceId}`,
    title: "",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

describe("downloadPayloadFor", () => {
  it("serializes artifacts and canvas documents with a language extension", async () => {
    useArtifactStore.setState({
      artifacts: {
        a: {
          id: "a",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "Parser",
          content: "x",
          language: "typescript",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as never,
      canvasDocuments: {
        c: {
          id: "c",
          sessionId: "standalone",
          title: "Notes.md",
          content: "# n",
          language: "markdown",
          type: "text",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as never,
    })
    const artifact = await downloadPayloadFor(entry({ kind: "artifact", sourceId: "a" }))
    expect(artifact?.filename).toBe("Parser.ts")
    await expect(artifact!.blob.text()).resolves.toBe("x")
    expect((await downloadPayloadFor(entry({ kind: "canvas", sourceId: "c" })))?.filename).toBe(
      "Notes.md"
    )
    expect(await downloadPayloadFor(entry({ kind: "artifact", sourceId: "gone" }))).toBeNull()
    expect(await downloadPayloadFor(entry({ kind: "canvas", sourceId: "gone" }))).toBeNull()
  })

  it("returns an image's original upload when one was kept", async () => {
    await getDb().messageMedia.put({
      hash: "abcdef123456",
      mediaType: "image/webp",
      width: 1,
      height: 1,
      blob: new Blob(["canon"]),
      byteSize: 5,
      originalBlob: new Blob(["original"]),
      originalMediaType: "image/jpeg",
      createdAt: 1,
      lastUsedAt: 1,
    })
    const payload = await downloadPayloadFor(entry({ kind: "image", sourceId: "abcdef123456" }))
    expect(payload?.filename).toBe("image-abcdef12.jpg")
    await expect(payload!.blob.text()).resolves.toBe("original")
    expect(await downloadPayloadFor(entry({ kind: "image", sourceId: "gone" }))).toBeNull()
  })

  it("returns upload originals, Files-owned or from a conversation", async () => {
    await getDb().sessions.put({ id: "s1", title: "s1", createdAt: 1, updatedAt: 1 } as ChatSession)
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["mine"]),
      filename: "mine.md",
      mediaType: "text/markdown",
    })
    const stored = await putSessionAsset({
      sessionId: "s1",
      assetId: "a1",
      blob: new Blob(["theirs"]),
      filename: "t.txt",
      mediaType: "text/plain",
    })
    expect((await downloadPayloadFor(entry({ kind: "upload", sourceId: "u1" })))?.filename).toBe(
      "mine.md"
    )
    const session = await downloadPayloadFor(
      entry({ kind: "session-upload", sourceId: stored.contentHash, title: "t.txt" })
    )
    await expect(session!.blob.text()).resolves.toBe("theirs")
    expect(await downloadPayloadFor(entry({ kind: "upload", sourceId: "gone" }))).toBeNull()
    expect(await downloadPayloadFor(entry({ kind: "session-upload", sourceId: "gone" }))).toBeNull()
  })
})
