import { buildTextDocumentStructure } from "@cognia/document/document-structure"
import type { KnowledgeBaseSource, KnowledgeBaseDocumentSnapshot } from "@/types/knowledge-base"
import { createKnowledgeReader, registerKnowledgeSummaryProvider } from "./progressive-reading"

const text = "# Guide\nIntroduction\n## Recovery\n```yaml\nretry_limit: 17\n```\n## Finish\nDone"
const identity = { knowledgeBaseId: "kb", sourceId: "source" }
function fixture(options: Record<string, unknown> = {}) {
  let source: KnowledgeBaseSource | undefined = {
    id: "source",
    knowledgeBaseId: "kb",
    title: "Guide",
    kind: "document",
    format: "markdown",
    content: text,
    bytes: text.length,
    fingerprint: "hash",
    status: "ready",
    chunkCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const structure = buildTextDocumentStructure(text)
  const snapshot: KnowledgeBaseDocumentSnapshot = {
    generationId: "gen",
    contentHash: structure.contentHash,
    originalText: text,
    structure,
    title: "Guide",
    format: "markdown",
    createdAt: 1,
  }
  const deps = {
    listSources: jest.fn(async () => (source ? [source] : [])),
    getSources: jest.fn(async () => (source ? [source] : [])),
    getSnapshot: jest.fn(async (input: { generationId?: string }) =>
      !input.generationId || input.generationId === "gen" ? snapshot : undefined
    ),
    getChunk: jest.fn(
      async () =>
        ({ ...identity, id: "chunk", generationId: "gen", charStart: 0, charEnd: 7 }) as never
    ),
  }
  return {
    reader: createKnowledgeReader({
      knowledgeBaseIds: ["kb"],
      settings: { enabled: true },
      deps,
      ...options,
    }),
    deps,
    snapshot,
    setSource: (value: KnowledgeBaseSource | undefined) => {
      source = value
    },
    source: source!,
  }
}
it("navigates sections and returns exact original code with bounded continuations", async () => {
  const { reader } = fixture()
  const tree = await reader.readOutline(identity)
  const section = tree.nodes.find((node) => node.title === "Recovery")!
  const first = await reader.readRange({ ...identity, sectionId: section.id, maxChars: 10 })
  const next = await reader.readRange({
    ...identity,
    generationId: first.generationId,
    sectionId: section.id,
    charStart: first.nextCharStart!,
    maxChars: 100,
  })
  expect(first.text + next.text).toContain("retry_limit: 17")
  expect(first.charStart).toBe(section.charStart)
  expect(next.nextCharStart).toBeNull()
  expect(tree.contentPolicy).toContain("navigation only")
})
it("validates ranges, page absence, section ids and document version", async () => {
  const { reader } = fixture()
  await expect(reader.readRange({ ...identity, charStart: -1 })).rejects.toMatchObject({
    code: "invalid_arguments",
  })
  await expect(reader.readRange({ ...identity, pageStart: 2 })).rejects.toMatchObject({
    code: "page_unavailable",
  })
  await expect(reader.readRange({ ...identity, sectionId: "unknown" })).rejects.toMatchObject({
    code: "section_unavailable",
  })
  await expect(reader.locate({ ...identity, documentVersion: "old" })).rejects.toMatchObject({
    code: "revision_unavailable",
  })
})
it("uses page provenance and inclusive page selections", async () => {
  const { reader, snapshot } = fixture()
  snapshot.structure!.pages = [
    { pageNumber: 1, charStart: 0, charEnd: 21, lineStart: 1, lineEnd: 2, provenance: "ocr" },
    {
      pageNumber: 2,
      charStart: 21,
      charEnd: text.length,
      lineStart: 3,
      lineEnd: 8,
      provenance: "text-layer",
    },
  ]
  expect(await reader.readRange({ ...identity, pageStart: 2 })).toMatchObject({
    charStart: 21,
    text: text.slice(21),
    pages: [expect.objectContaining({ provenance: "text-layer" })],
  })
  expect(await reader.locate({ ...identity, pageStart: 1 })).toMatchObject({ pageNumber: 1 })
})
it("fails closed across scopes, HTTP ACLs, deletion and revision pinning", async () => {
  const local = fixture()
  await expect(
    local.reader.readRange({ ...identity, knowledgeBaseId: "other" })
  ).rejects.toMatchObject({ code: "source_unavailable" })
  const publicReader = fixture({ entrypoint: "http" })
  expect((await publicReader.reader.listDocuments()).documents).toEqual([])
  await expect(publicReader.reader.readRange(identity)).rejects.toMatchObject({
    code: "source_unavailable",
  })
  const frozen = fixture({ revisionBindings: { kb: ["gen"] } })
  await expect(
    frozen.reader.readRange({ ...identity, generationId: "other" })
  ).rejects.toMatchObject({ code: "revision_out_of_scope" })
  await expect(
    local.reader.readRange({ ...identity, generationId: "missing" })
  ).rejects.toMatchObject({ code: "revision_unavailable" })
  local.setSource(undefined)
  await expect(local.reader.locate(identity)).rejects.toMatchObject({ code: "source_unavailable" })
})
it("rechecks ACL when asynchronous snapshot loading overlaps revocation", async () => {
  const value = fixture({ entrypoint: "http" })
  value.setSource({ ...value.source, acl: { visibility: "public" } })
  value.deps.getSnapshot.mockImplementation(async () => {
    value.setSource({ ...value.source, acl: { visibility: "private" } })
    return value.snapshot
  })
  await expect(value.reader.readRange(identity)).rejects.toMatchObject({
    code: "source_unavailable",
  })
})
it("shares call and original-text budgets across concurrent reads", async () => {
  const { reader } = fixture({ settings: { enabled: true, totalReadChars: 12, maxCalls: 2 } })
  const results = await Promise.allSettled([
    reader.readRange({ ...identity, maxChars: 10 }),
    reader.readRange({ ...identity, maxChars: 10 }),
  ])
  expect(
    results
      .map((result) => (result.status === "fulfilled" ? result.value.text.length : 0))
      .reduce((a, b) => a + b, 0)
  ).toBe(12)
  await expect(reader.locate(identity)).rejects.toMatchObject({ code: "call_budget_exhausted" })
  await expect(
    fixture({ settings: { enabled: true, totalReadChars: 0 } }).reader.readRange(identity)
  ).rejects.toMatchObject({ code: "read_budget_exhausted" })
})
it("resolves legacy chunk refs only after source/revision ownership checks", async () => {
  const { reader, deps } = fixture()
  expect(await reader.locate({ ...identity, chunkId: "chunk" })).toMatchObject({
    charStart: 0,
    charEnd: 7,
    generationId: "gen",
  })
  deps.getChunk.mockResolvedValue({
    ...identity,
    sourceId: "other",
    generationId: "gen",
    charStart: 0,
    charEnd: 7,
  } as never)
  await expect(reader.locate({ ...identity, chunkId: "chunk" })).rejects.toMatchObject({
    code: "chunk_unavailable",
  })
})

it("refuses generationless legacy offsets from an unverified or replaced original", async () => {
  const { reader, deps } = fixture()
  deps.getChunk.mockResolvedValue({
    ...identity,
    id: "old-chunk",
    charStart: 0,
    charEnd: 7,
    content: "# Other",
    contentHash: "old-version",
  } as never)
  await expect(reader.locate({ ...identity, chunkId: "old-chunk" })).rejects.toMatchObject({
    code: "revision_unavailable",
  })
  deps.getChunk.mockResolvedValue(undefined as never)
  expect(
    await reader.locate({
      ...identity,
      chunkId: "purged",
      generationId: "gen",
      charStart: 0,
      charEnd: 7,
    })
  ).toMatchObject({ charStart: 0, generationId: "gen" })
})

it("uses canonical text version independently from binary source fingerprints", async () => {
  const { reader, snapshot } = fixture()
  snapshot.contentHash = "binary-source-fingerprint"
  const documentVersion = snapshot.structure!.contentHash
  expect(await reader.locate({ ...identity, documentVersion })).toMatchObject({
    documentVersion,
    contentHash: "binary-source-fingerprint",
  })
  await expect(
    reader.readRange({ ...identity, documentVersion: snapshot.contentHash })
  ).rejects.toMatchObject({ code: "revision_unavailable" })
})
it("supports heading directory search and injected existing retrieval candidates", async () => {
  const { reader, deps } = fixture()
  expect((await reader.listDocuments({ query: "Recovery" })).documents).toHaveLength(1)
  const retrieveCandidates = jest.fn(async () => [{ ...identity, score: 0.8 }])
  const candidate = fixture({
    settings: { enabled: true, retrievalStrategy: "hybrid" },
    deps: { ...deps, retrieveCandidates },
  })
  expect(
    (await candidate.reader.listDocuments({ query: "retry_limit" })).documents[0]
  ).toMatchObject({ score: 0.8 })
  expect(retrieveCandidates).toHaveBeenCalledWith("retry_limit", "hybrid")
})
it("calls replaceable summary providers only for navigation, with bounded text and errors", async () => {
  const summarize = jest.fn(
    async (_input: { providerId: string; title: string; text: string; maxChars: number }) =>
      "A navigation summary long enough to truncate"
  )
  const dispose = registerKnowledgeSummaryProvider("test-summary", summarize)
  try {
    const { reader } = fixture({
      settings: {
        enabled: true,
        summaryProviderId: "test-summary",
        summaryMaxChars: 10,
        maxReadChars: 12,
        maxOutlineNodes: 1,
      },
    })
    const outline = await reader.readOutline(identity)
    expect(outline.nodes[0].summary).toHaveLength(10)
    expect(outline.summaryStatus).toBe("generated")
    expect(summarize.mock.calls[0][0]).toMatchObject({ providerId: "test-summary", maxChars: 10 })
    expect(reader.budget().readChars).toBe(12)
  } finally {
    dispose()
  }
  expect(
    (
      await fixture({
        settings: { enabled: true, summaryProviderId: "missing" },
      }).reader.readOutline(identity)
    ).summaryStatus
  ).toBe("unavailable")
})
