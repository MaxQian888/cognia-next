import type { ChatSession } from "@cognia/agent-config-types"
import type { Artifact, CanvasDocument } from "@/types/artifact/artifact"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { putLibraryAsset, putSessionAsset } from "@/lib/db/session-assets"
import { referenceCandidateFor } from "../referenceable"
import { makeProviderInput, makeTestContext } from "../testing"
import {
  createFilesArtifactsProvider,
  createFilesCanvasProvider,
  createFilesItemsProvider,
  loadFileSearchRows,
  type FileSearchRow,
} from "./files"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const artifacts: Record<string, Artifact> = {
  a1: {
    id: "a1",
    sessionId: "s1",
    projectId: "p1",
    messageId: "m",
    type: "code",
    title: "Pratt parser",
    content: "",
    language: "typescript",
    version: 1,
    createdAt: new Date(1),
    updatedAt: new Date(5),
  },
  a2: {
    id: "a2",
    sessionId: "s2",
    projectId: "p2",
    messageId: "m",
    type: "document",
    title: "Parser notes",
    content: "",
    version: 1,
    createdAt: new Date(1),
    updatedAt: new Date(6),
  },
}
const canvas: Record<string, CanvasDocument> = {
  c1: {
    id: "c1",
    sessionId: "standalone",
    title: "Parser design",
    content: "",
    language: "markdown",
    type: "text",
    createdAt: new Date(1),
    updatedAt: new Date(2),
  },
}

describe("Files ⌘K providers", () => {
  it("finds artifacts in the workspace, opens their preview, and is referenceable", async () => {
    const provider = createFilesArtifactsProvider({ artifacts: async () => artifacts })
    const out = await provider.search(makeProviderInput("parser"))
    expect(out.items.map((item) => item.id)).toEqual(["artifact:a1"])
    expect(out.items[0]).toMatchObject({
      kind: "artifact",
      subtitle: "code · typescript",
      action: { type: "navigate", href: "/files?tab=all&item=artifact%3Aa1" },
    })
    expect(referenceCandidateFor(out.items[0]!)).toMatchObject({ entityKind: "artifact", id: "a1" })
  })

  it("finds canvas documents and references them as @canvas", async () => {
    const provider = createFilesCanvasProvider({ canvasDocuments: async () => canvas })
    const out = await provider.search(makeProviderInput("design"))
    expect(out.items[0]).toMatchObject({
      id: "canvas:c1",
      kind: "canvas-document",
      subtitle: "markdown",
    })
    expect(referenceCandidateFor(out.items[0]!)).toMatchObject({ entityKind: "canvas", id: "c1" })
  })

  it("finds files, and offers nothing on the phone shell", async () => {
    const rows: FileSearchRow[] = [
      { key: "upload:u1", title: "SPEC.md", mediaType: "text/markdown", timestamp: 3 },
    ]
    const provider = createFilesItemsProvider({ loadItems: async () => rows })
    const out = await provider.search(makeProviderInput("spec"))
    expect(out.items[0]).toMatchObject({
      id: "library-file:upload:u1",
      kind: "library-file",
      action: { type: "navigate", href: "/files?tab=all&item=upload%3Au1" },
    })
    expect(referenceCandidateFor(out.items[0]!)).toBeNull()
    const phone = makeTestContext({ platform: "mobile" })
    for (const p of [
      createFilesItemsProvider({ loadItems: async () => rows }),
      createFilesArtifactsProvider({ artifacts: async () => artifacts }),
      createFilesCanvasProvider({ canvasDocuments: async () => canvas }),
    ]) {
      expect((await p.search(makeProviderInput("s", { ctx: phone }))).items).toEqual([])
    }
  })
})

describe("loadFileSearchRows", () => {
  it("lists uploads once per file with their conversation's workspace, plus named images", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "s1", createdAt: 1, updatedAt: 1 } as ChatSession,
      { id: "s2", title: "s2", createdAt: 1, updatedAt: 1 } as ChatSession,
    ])
    await putSessionAsset({
      sessionId: "s1",
      assetId: "a1",
      blob: new Blob(["same"]),
      filename: "old.md",
      mediaType: "text/markdown",
      now: 1,
    })
    await putSessionAsset({
      sessionId: "s2",
      assetId: "a2",
      blob: new Blob(["same"]),
      filename: "new.md",
      mediaType: "text/markdown",
      now: 9,
    })
    await putSessionAsset({
      sessionId: "s1",
      assetId: "img",
      blob: new Blob(["png"]),
      filename: "shot.png",
      mediaType: "image/png",
    })
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["mine"]),
      filename: "mine.txt",
      mediaType: "text/plain",
      projectId: "p9",
    })
    await db.libraryItems.bulkPut([
      {
        key: "image:h1",
        kind: "image",
        sourceId: "h1",
        ownedByFiles: true,
        snapshot: { title: "logo.png", mediaType: "image/png" },
        projectId: "p1",
        createdAt: 1,
        updatedAt: 4,
      },
      {
        key: "image:h2",
        kind: "image",
        sourceId: "h2",
        lastOpenedAt: 3,
        snapshot: { title: "seen.png" },
        createdAt: 1,
        updatedAt: 4,
      },
    ])

    const rows = await loadFileSearchRows([{ id: "s2", projectId: "p2" }])
    const byTitle = Object.fromEntries(rows.map((row) => [row.title, row]))
    expect(Object.keys(byTitle).sort()).toEqual(["logo.png", "mine.txt", "new.md"])
    expect(byTitle["new.md"]).toMatchObject({ projectId: "p2", timestamp: 9 })
    expect(byTitle["mine.txt"]).toMatchObject({ key: "upload:u1", projectId: "p9" })
    expect(byTitle["logo.png"]).toMatchObject({
      key: "image:h1",
      projectId: "p1",
      mediaType: "image/png",
    })
  })
})
