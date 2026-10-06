jest.mock("./persist", () => ({
  persistProjectChunks: jest.fn(async () => ({ rows: [], vectorDocIds: [] })),
  projectVectorCollectionName: (id: string) => `cognia_project_${id}`,
}))
jest.mock("@/lib/twin/ingest/embed", () => ({
  embedRedactedChunks: jest.fn(async (texts: string[]) => ({
    embeddings: texts.map(() => [0.1, 0.2]),
    tokensUsed: 0,
  })),
}))
jest.mock("@/lib/db/project-chunks", () => ({
  getIndexedContentHash: jest.fn(async () => undefined),
}))

import type { KnowledgeFile } from "@/types"
import { hashContent, ingestKnowledgeFile } from "./ingest-file"
import { persistProjectChunks } from "./persist"
import { embedRedactedChunks } from "@/lib/twin/ingest/embed"
import { getIndexedContentHash } from "@/lib/db/project-chunks"

const persistMock = persistProjectChunks as jest.Mock
const embedMock = embedRedactedChunks as jest.Mock
const indexedHashMock = getIndexedContentHash as jest.Mock

function file(overrides: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    id: "file-1",
    name: "notes.md",
    type: "markdown",
    content: "Contact me at alice@example.com about the roadmap.",
    size: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const nativeDeps = {
  store: {} as never,
  embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "k" } as never,
  vectorBackend: "native" as const,
}
const cloudDeps = { ...nativeDeps, vectorBackend: "qdrant" as const }

beforeEach(() => {
  persistMock.mockClear()
  embedMock.mockClear()
  indexedHashMock.mockReset().mockResolvedValue(undefined)
})

describe("hashContent", () => {
  it("is deterministic and changes with content", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"))
    expect(hashContent("abc")).not.toBe(hashContent("abd"))
    expect(hashContent("")).toBe(hashContent(""))
  })
})

describe("ingestKnowledgeFile", () => {
  it("skips when the content hash matches the indexed one", async () => {
    const f = file()
    indexedHashMock.mockResolvedValue(hashContent(f.content))
    const result = await ingestKnowledgeFile({ projectId: "p", file: f, deps: nativeDeps })
    expect(result).toEqual({ chunkCount: 0, skipped: true })
    expect(persistMock).not.toHaveBeenCalled()
  })

  it("skipUnchanged:false forces re-ingest even when the hash matches", async () => {
    const f = file()
    indexedHashMock.mockResolvedValue(hashContent(f.content))
    const result = await ingestKnowledgeFile({
      projectId: "p",
      file: f,
      deps: nativeDeps,
      skipUnchanged: false,
    })
    expect(result.skipped).toBe(false)
    expect(persistMock).toHaveBeenCalledWith(expect.objectContaining({ expectedSource: f }))
  })

  it("activates an empty generation so stale chunks are removed", async () => {
    const result = await ingestKnowledgeFile({
      projectId: "p",
      file: file({ content: "   " }),
      deps: nativeDeps,
    })
    expect(result).toEqual({ chunkCount: 0, skipped: false })
    expect(persistMock).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: [], embeddings: [] })
    )
  })

  it("treats missing content as an empty generation", async () => {
    const result = await ingestKnowledgeFile({
      projectId: "p",
      file: file({ content: undefined as unknown as string }),
      deps: nativeDeps,
    })
    expect(result).toEqual({ chunkCount: 0, skipped: false })
    expect(persistMock).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: [], embeddings: [] })
    )
  })

  it("native backend embeds the ORIGINAL text (no redaction)", async () => {
    await ingestKnowledgeFile({ projectId: "p", file: file(), deps: nativeDeps })
    expect(persistMock).toHaveBeenCalledTimes(1)
    const arg = persistMock.mock.calls[0][0]
    const joined = arg.chunks.map((c: { contentRedacted: string }) => c.contentRedacted).join(" ")
    expect(joined).toContain("alice@example.com")
  })

  it("cloud backend redacts before embed and reconstructs the displayable original", async () => {
    await ingestKnowledgeFile({ projectId: "p", file: file(), deps: cloudDeps })
    expect(persistMock).toHaveBeenCalledTimes(1)
    const arg = persistMock.mock.calls[0][0]
    const redacted = arg.chunks.map((c: { contentRedacted: string }) => c.contentRedacted).join(" ")
    const original = arg.chunks.map((c: { content: string }) => c.content).join(" ")
    // Cloud never sees the raw email…
    expect(redacted).not.toContain("alice@example.com")
    expect(redacted).toMatch(/<EMAIL_\d+>/)
    // …but the local displayable content is un-redacted.
    expect(original).toContain("alice@example.com")
    // The embedder was fed the redacted text.
    const embedArg = (embedMock.mock.calls[0][0] as string[]).join(" ")
    expect(embedArg).not.toContain("alice@example.com")
  })

  it("passes the content hash + backend through to persist", async () => {
    const f = file()
    await ingestKnowledgeFile({ projectId: "proj-x", file: f, deps: cloudDeps })
    const arg = persistMock.mock.calls[0][0]
    expect(arg.projectId).toBe("proj-x")
    expect(arg.fileId).toBe("file-1")
    expect(arg.vectorBackend).toBe("qdrant")
    expect(arg.contentHash).toBe(hashContent(f.content))
  })
})

it("retains original markdown headings and records PDF page locations", async () => {
  const content = "# Original heading\nCanonical answer on page two."
  const structure = {
    version: 1 as const,
    contentHash: hashContent(content),
    textLength: content.length,
    nodes: [],
    pages: [
      {
        pageNumber: 2,
        charStart: 0,
        charEnd: content.length,
        lineStart: 1,
        lineEnd: 2,
        provenance: "text-layer" as const,
      },
    ],
  }
  await ingestKnowledgeFile({
    projectId: "p",
    file: file({ content, embeddableContent: "Canonical answer", structure }),
    deps: nativeDeps,
  })
  const chunks = persistMock.mock.calls[0][0].chunks
  expect(chunks[0].content).toContain("# Original heading")
  expect(chunks[0].metadata.pageNumber).toBe(2)
})

it("invalidates a generation on structure-only changes while retaining legacy hashes", async () => {
  const { hashKnowledgeFile } = await import("./ingest-file")
  const original = file({ content: "source" })
  expect(hashKnowledgeFile(original)).toBe(hashContent("source"))
  const structured = {
    ...original,
    structure: {
      version: 1 as const,
      contentHash: hashContent("source"),
      textLength: 6,
      nodes: [],
      pages: [],
    },
  }
  expect(hashKnowledgeFile(structured)).not.toBe(hashKnowledgeFile(original))
  expect(hashKnowledgeFile({ ...structured, embeddableContent: "projection" })).not.toBe(
    hashKnowledgeFile(structured)
  )
})

it("rejects stale page ranges after editing the canonical source", async () => {
  await ingestKnowledgeFile({
    projectId: "p",
    file: file({
      structure: {
        version: 1,
        contentHash: "stale",
        textLength: 1,
        nodes: [],
        pages: [
          {
            pageNumber: 99,
            charStart: 0,
            charEnd: 100,
            lineStart: 1,
            lineEnd: 1,
            provenance: "ocr",
          },
        ],
      },
    }),
    deps: nativeDeps,
  })
  expect(persistMock.mock.calls[0][0].chunks[0].metadata.pageNumber).toBeUndefined()
})

it("exports the existing source format mapping for plugin readers", async () => {
  const { PROJECT_KNOWLEDGE_SOURCE_FORMATS } = await import("./ingest-file")
  expect(PROJECT_KNOWLEDGE_SOURCE_FORMATS).toMatchObject({
    pdf: "pdf",
    markdown: "markdown",
    code: "code",
    word: "docx",
    presentation: "pptx",
    epub: "epub",
  })
  expect(Object.keys(PROJECT_KNOWLEDGE_SOURCE_FORMATS)).toHaveLength(12)
})
