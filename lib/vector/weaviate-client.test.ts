/**
 * Tests for Weaviate Vector Database Client
 */

import {
  listWeaviateClasses,
  getWeaviateClassInfo,
  createWeaviateClass,
  deleteWeaviateClass,
  upsertWeaviateDocuments,
  deleteWeaviateDocuments,
  getWeaviateDocuments,
  queryWeaviate,
  countWeaviateDocuments,
  scrollWeaviateDocuments,
  type WeaviateConfig,
  type WeaviateDocument,
} from "./weaviate-client"

jest.mock("./embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2],
    model: "text-embedding-3-small",
    provider: "openai",
  }),
  generateEmbeddings: jest.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2]],
    model: "text-embedding-3-small",
    provider: "openai",
  }),
}))

import * as embeddingModule from "./embedding"

const mockGenerateEmbedding = jest.mocked(embeddingModule.generateEmbedding)
const mockGenerateEmbeddings = jest.mocked(embeddingModule.generateEmbeddings)

const mockConfig: WeaviateConfig = {
  url: "http://localhost:8080",
  apiKey: "test-api-key",
  className: "TestClass",
  embeddingConfig: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 2,
  },
  embeddingApiKey: "embedding-key",
}

const createResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as Response

describe("weaviate-client", () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as typeof globalThis).fetch = fetchMock as unknown as typeof fetch
    jest.clearAllMocks()
  })

  describe("listWeaviateClasses", () => {
    it("lists classes from schema", async () => {
      fetchMock.mockResolvedValueOnce(
        createResponse({ classes: [{ class: "TestClass", description: "desc" }] })
      )

      const classes = await listWeaviateClasses({ url: mockConfig.url, apiKey: mockConfig.apiKey })

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/v1/schema",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer test-api-key" }),
        })
      )
      expect(classes).toEqual([{ name: "TestClass", description: "desc" }])
    })
  })

  describe("getWeaviateClassInfo", () => {
    it("returns class info", async () => {
      fetchMock.mockResolvedValueOnce(createResponse({ class: "TestClass", description: "desc" }))

      const info = await getWeaviateClassInfo(mockConfig)

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/v1/schema/TestClass",
        expect.any(Object)
      )
      expect(info).toEqual({ name: "TestClass", description: "desc", documentCount: 0 })
    })
  })

  describe("createWeaviateClass", () => {
    it("creates class with schema definition", async () => {
      fetchMock.mockResolvedValueOnce(createResponse({}))

      await createWeaviateClass(mockConfig, { description: "desc" })

      const [, init] = fetchMock.mock.calls[0]
      const payload = JSON.parse(init.body as string) as { class: string; description?: string }

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/v1/schema",
        expect.objectContaining({ method: "POST" })
      )
      expect(payload).toEqual(expect.objectContaining({ class: "TestClass", description: "desc" }))
    })
  })

  describe("deleteWeaviateClass", () => {
    it("deletes class by name", async () => {
      fetchMock.mockResolvedValueOnce(createResponse({}))

      await deleteWeaviateClass(mockConfig)

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/v1/schema/TestClass",
        expect.objectContaining({ method: "DELETE" })
      )
    })
  })

  describe("upsertWeaviateDocuments", () => {
    it("embeds and upserts documents", async () => {
      fetchMock.mockResolvedValueOnce(createResponse({}))
      const documents: WeaviateDocument[] = [{ id: "doc-1", content: "Hello" }]

      await upsertWeaviateDocuments(mockConfig, documents)

      expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
        ["Hello"],
        mockConfig.embeddingConfig,
        mockConfig.embeddingApiKey
      )
      const [, init] = fetchMock.mock.calls[0]
      const payload = JSON.parse(init.body as string) as {
        objects: Array<{ id: string; vector: number[] }>
      }
      expect(payload.objects[0]).toEqual(
        expect.objectContaining({ id: "doc-1", vector: [0.1, 0.2] })
      )
    })

    it("uses provided embeddings when available", async () => {
      fetchMock.mockResolvedValueOnce(createResponse({}))
      const documents: WeaviateDocument[] = [
        { id: "doc-2", content: "Hello", embedding: [0.9, 0.8] },
      ]

      await upsertWeaviateDocuments(mockConfig, documents)

      expect(mockGenerateEmbeddings).not.toHaveBeenCalled()
      const [, init] = fetchMock.mock.calls[0]
      const payload = JSON.parse(init.body as string) as {
        objects: Array<{ id: string; vector: number[] }>
      }
      expect(payload.objects[0]).toEqual(
        expect.objectContaining({ id: "doc-2", vector: [0.9, 0.8] })
      )
    })
  })

  describe("deleteWeaviateDocuments", () => {
    it("deletes documents by id", async () => {
      fetchMock.mockResolvedValue(createResponse({}))

      await deleteWeaviateDocuments(mockConfig, ["doc-1", "doc-2"])

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/v1/objects/TestClass/doc-1",
        expect.objectContaining({ method: "DELETE" })
      )
    })
  })

  describe("getWeaviateDocuments", () => {
    it("retrieves documents by id", async () => {
      fetchMock
        .mockResolvedValueOnce(
          createResponse({
            id: "doc-1",
            properties: { content: "content 1", metadata: '{"source":"test"}' },
            vector: [0.1],
          })
        )
        .mockResolvedValueOnce(
          createResponse({
            id: "doc-2",
            properties: { content: "content 2", metadata: '{"source":"test-2"}' },
            vector: [0.2],
          })
        )

      const docs = await getWeaviateDocuments(mockConfig, ["doc-1", "doc-2"])

      expect(docs).toEqual([
        {
          id: "doc-1",
          content: "content 1",
          metadata: { source: "test" },
          embedding: [0.1],
        },
        {
          id: "doc-2",
          content: "content 2",
          metadata: { source: "test-2" },
          embedding: [0.2],
        },
      ])
    })
  })

  describe("queryWeaviate", () => {
    it("queries via GraphQL with embeddings", async () => {
      fetchMock.mockResolvedValueOnce(
        createResponse({
          data: {
            Get: {
              TestClass: [
                {
                  _additional: { id: "doc-1", certainty: 0.9 },
                  content: "content 1",
                  metadata: '{"tag":"a"}',
                },
              ],
            },
          },
        })
      )

      const results = await queryWeaviate(mockConfig, "hello", { topK: 3 })

      expect(mockGenerateEmbedding).toHaveBeenCalledWith(
        "hello",
        mockConfig.embeddingConfig,
        mockConfig.embeddingApiKey
      )
      expect(results).toEqual([
        {
          id: "doc-1",
          content: "content 1",
          metadata: { tag: "a" },
          score: 0.9,
        },
      ])
    })

    it("falls back to distance score when certainty is missing", async () => {
      fetchMock.mockResolvedValueOnce(
        createResponse({
          data: {
            Get: {
              TestClass: [
                {
                  _additional: { id: "doc-2", distance: 0.2 },
                  content: "content 2",
                  metadata: '{"tag":"b"}',
                },
              ],
            },
          },
        })
      )

      const results = await queryWeaviate(mockConfig, "hello", { topK: 3 })
      expect(results[0].score).toBeCloseTo(0.8)
    })
  })

  describe("countWeaviateDocuments", () => {
    it("returns aggregate count", async () => {
      fetchMock.mockResolvedValueOnce(
        createResponse({
          data: {
            Aggregate: {
              TestClass: [{ meta: { count: 7 } }],
            },
          },
        })
      )

      const count = await countWeaviateDocuments(mockConfig)
      expect(count).toBe(7)
    })
  })

  describe("scrollWeaviateDocuments", () => {
    it("returns paged documents", async () => {
      fetchMock.mockResolvedValueOnce(
        createResponse({
          objects: [
            {
              id: "doc-1",
              properties: { content: "content 1", metadata: '{"source":"test"}' },
              vector: [0.1, 0.2],
            },
          ],
        })
      )

      const docs = await scrollWeaviateDocuments(mockConfig, { offset: 0, limit: 1 })
      expect(docs).toEqual([
        {
          id: "doc-1",
          content: "content 1",
          metadata: { source: "test" },
          embedding: [0.1, 0.2],
        },
      ])
    })
  })
})
