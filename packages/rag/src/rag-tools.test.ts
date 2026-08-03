/**
 * Tests for rag-tools.ts
 *
 * Tests the RAG tools for AI SDK integration
 */

import {
  createRAGTools,
  createSimpleRetrievalTool,
  createKnowledgeBaseManagementTools,
  type RAGToolsConfig,
} from "./rag-tools"
import type { RAGPipeline, RAGPipelineContext } from "./rag-pipeline"

// Mock RAG Pipeline
const createMockPipeline = (): jest.Mocked<RAGPipeline> => {
  return {
    retrieve: jest.fn(),
    indexDocument: jest.fn(),
    getCollectionStats: jest.fn(),
    clearCollection: jest.fn(),
    indexDocuments: jest.fn(),
    search: jest.fn(),
    // Cast through `unknown` rather than `any` so the linter is satisfied;
    // tests only reach for the methods stubbed above.
  } as unknown as jest.Mocked<RAGPipeline>
}

// Mock context returned by retrieve
const createMockContext = (
  documents: Array<{
    id: string
    content: string
    rerankScore: number
    metadata?: Record<string, unknown>
  }>
): RAGPipelineContext => ({
  documents: documents.map((doc) => ({
    id: doc.id,
    content: doc.content,
    rerankScore: doc.rerankScore,
    metadata: doc.metadata || {},
    chunkIndex: 0,
    totalChunks: 1,
  })),
  query: "test query",
  formattedContext: documents.map((d) => d.content).join("\n"),
  totalTokensEstimate: 100,
  searchMetadata: {
    hybridSearchUsed: true,
    queryExpansionUsed: false,
    rerankingUsed: true,
    originalResultCount: documents.length,
    finalResultCount: documents.length,
  },
})

describe("rag-tools", () => {
  describe("createRAGTools", () => {
    let mockPipeline: jest.Mocked<RAGPipeline>
    let config: RAGToolsConfig

    beforeEach(() => {
      mockPipeline = createMockPipeline()
      config = {
        pipeline: mockPipeline,
        collectionName: "test-collection",
        topK: 5,
        similarityThreshold: 0.5,
      }
    })

    it("should create getInformation tool by default", () => {
      const tools = createRAGTools(config)

      expect(tools.getInformation).toBeDefined()
    })

    it("should create addResource tool by default", () => {
      const tools = createRAGTools(config)

      expect(tools.addResource).toBeDefined()
    })

    it("should not create searchWithFilters tool by default", () => {
      const tools = createRAGTools(config)

      expect(tools.searchWithFilters).toBeUndefined()
    })

    it("should create searchWithFilters when enabled", () => {
      const tools = createRAGTools({
        ...config,
        enableFilteredSearch: true,
      })

      expect(tools.searchWithFilters).toBeDefined()
    })

    it("should not create addResource when disabled", () => {
      const tools = createRAGTools({
        ...config,
        enableAddResource: false,
      })

      expect(tools.addResource).toBeUndefined()
    })

    describe("getInformation tool", () => {
      it("should retrieve relevant documents", async () => {
        const mockContext = createMockContext([
          {
            id: "1",
            content: "Machine learning content",
            rerankScore: 0.9,
            metadata: { source: "wiki" },
          },
          { id: "2", content: "Deep learning content", rerankScore: 0.8 },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools(config)
        const result = await tools.getInformation.execute({ question: "What is ML?" })

        expect(mockPipeline.retrieve).toHaveBeenCalledWith("test-collection", "What is ML?")
        expect(result).toContain("Machine learning content")
        expect(result).toContain("Source: wiki")
      })

      it("should return message when no documents found", async () => {
        mockPipeline.retrieve.mockResolvedValueOnce(createMockContext([]))

        const tools = createRAGTools(config)
        const result = await tools.getInformation.execute({ question: "Unknown topic" })

        expect(result).toBe("No relevant information found in the knowledge base.")
      })

      it("should filter by similarity threshold", async () => {
        const mockContext = createMockContext([
          { id: "1", content: "High relevance", rerankScore: 0.9 },
          { id: "2", content: "Low relevance", rerankScore: 0.3 },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools({ ...config, similarityThreshold: 0.5 })
        const result = await tools.getInformation.execute({ question: "test" })

        expect(result).toContain("High relevance")
        expect(result).not.toContain("Low relevance")
      })

      it("should limit results by topK", async () => {
        const mockContext = createMockContext([
          { id: "1", content: "Doc 1", rerankScore: 0.9 },
          { id: "2", content: "Doc 2", rerankScore: 0.8 },
          { id: "3", content: "Doc 3", rerankScore: 0.7 },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools({ ...config, topK: 2 })
        const result = await tools.getInformation.execute({ question: "test" })

        expect(result).toContain("Doc 1")
        expect(result).toContain("Doc 2")
        expect(result).not.toContain("Doc 3")
      })

      it("should handle errors gracefully", async () => {
        mockPipeline.retrieve.mockRejectedValueOnce(new Error("Database error"))

        const tools = createRAGTools(config)
        const result = await tools.getInformation.execute({ question: "test" })

        expect(result).toBe("Error retrieving information from knowledge base.")
      })
    })

    describe("addResource tool", () => {
      it("should add content to knowledge base", async () => {
        mockPipeline.indexDocument.mockResolvedValueOnce({
          success: true,
          chunksCreated: 3,
        })

        const tools = createRAGTools(config)
        const result = await tools.addResource.execute({
          content: "New knowledge content",
          title: "Test Title",
          category: "test-category",
        })

        expect(mockPipeline.indexDocument).toHaveBeenCalledWith(
          "New knowledge content",
          expect.objectContaining({
            collectionName: "test-collection",
            documentTitle: "Test Title",
            metadata: expect.objectContaining({
              category: "test-category",
            }),
          })
        )
        expect(result).toContain("Successfully added content")
        expect(result).toContain("3 chunks")
      })

      it("should handle failed indexing", async () => {
        mockPipeline.indexDocument.mockResolvedValueOnce({
          success: false,
          error: "Indexing failed",
          chunksCreated: 0,
        })

        const tools = createRAGTools(config)
        const result = await tools.addResource.execute({
          content: "Some content",
        })

        expect(result).toContain("Failed to add content")
      })

      it("should handle errors gracefully", async () => {
        mockPipeline.indexDocument.mockRejectedValueOnce(new Error("API error"))

        const tools = createRAGTools(config)
        const result = await tools.addResource.execute({
          content: "Some content",
        })

        expect(result).toBe("Error adding content to knowledge base.")
      })
    })

    describe("searchWithFilters tool", () => {
      it("should filter by category", async () => {
        const mockContext = createMockContext([
          { id: "1", content: "Cat A content", rerankScore: 0.9, metadata: { category: "A" } },
          { id: "2", content: "Cat B content", rerankScore: 0.8, metadata: { category: "B" } },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools({ ...config, enableFilteredSearch: true })
        const result = await tools.searchWithFilters.execute({
          query: "test",
          category: "A",
        })

        expect(result).toContain("Cat A content")
        expect(result).not.toContain("Cat B content")
      })

      it("should filter by source", async () => {
        const mockContext = createMockContext([
          { id: "1", content: "Wiki content", rerankScore: 0.9, metadata: { source: "wiki" } },
          { id: "2", content: "Book content", rerankScore: 0.8, metadata: { source: "book" } },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools({ ...config, enableFilteredSearch: true })
        const result = await tools.searchWithFilters.execute({
          query: "test",
          source: "wiki",
        })

        expect(result).toContain("Wiki content")
        expect(result).not.toContain("Book content")
      })

      it("should respect custom limit", async () => {
        const mockContext = createMockContext([
          { id: "1", content: "Doc 1", rerankScore: 0.9 },
          { id: "2", content: "Doc 2", rerankScore: 0.8 },
          { id: "3", content: "Doc 3", rerankScore: 0.7 },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools({ ...config, enableFilteredSearch: true })
        const result = await tools.searchWithFilters.execute({
          query: "test",
          limit: 1,
        })

        expect(result).toContain("Doc 1")
        expect(result).not.toContain("Doc 2")
      })

      it("should return message when no results match filters", async () => {
        const mockContext = createMockContext([
          { id: "1", content: "Content", rerankScore: 0.9, metadata: { category: "B" } },
        ])
        mockPipeline.retrieve.mockResolvedValueOnce(mockContext)

        const tools = createRAGTools({ ...config, enableFilteredSearch: true })
        const result = await tools.searchWithFilters.execute({
          query: "test",
          category: "A",
        })

        expect(result).toBe("No results found matching the specified filters.")
      })
    })
  })

  describe("createSimpleRetrievalTool", () => {
    it("should create a retrieval tool from custom function", async () => {
      const mockFindRelevant = jest
        .fn()
        .mockResolvedValue([{ content: "Found content", similarity: 0.9, source: "test-source" }])

      const tool = createSimpleRetrievalTool(mockFindRelevant)
      const result = await tool.execute!(
        { question: "test question" },
        { toolCallId: "test", messages: [], context: {} }
      )

      expect(mockFindRelevant).toHaveBeenCalledWith("test question")
      expect(result).toContain("Found content")
      expect(result).toContain("test-source")
      expect(result).toContain("90%")
    })

    it("should return message when no results", async () => {
      const mockFindRelevant = jest.fn().mockResolvedValue([])

      const tool = createSimpleRetrievalTool(mockFindRelevant)
      const result = await tool.execute!(
        { question: "unknown" },
        { toolCallId: "test", messages: [], context: {} }
      )

      expect(result).toBe("No relevant information found.")
    })

    it("should handle errors gracefully", async () => {
      const mockFindRelevant = jest.fn().mockRejectedValue(new Error("Search failed"))

      const tool = createSimpleRetrievalTool(mockFindRelevant)
      const result = await tool.execute!(
        { question: "test" },
        { toolCallId: "test", messages: [], context: {} }
      )

      expect(result).toBe("Error searching knowledge base.")
    })
  })

  describe("createKnowledgeBaseManagementTools", () => {
    let mockPipeline: jest.Mocked<RAGPipeline>

    beforeEach(() => {
      mockPipeline = createMockPipeline()
    })

    describe("getKnowledgeBaseStats tool", () => {
      it("should return stats", async () => {
        mockPipeline.getCollectionStats.mockResolvedValue({
          documentCount: 100,
          exists: true,
        })

        const tools = createKnowledgeBaseManagementTools(mockPipeline, "my-kb")
        const result = await tools.getKnowledgeBaseStats.execute!(
          {},
          { toolCallId: "test", messages: [], context: {} }
        )

        expect(result).toContain("my-kb")
        expect(result).toContain("100")
        expect(result).toContain("true")
      })

      it("should handle errors", async () => {
        mockPipeline.getCollectionStats.mockImplementation(() => {
          throw new Error("Stats error")
        })

        const tools = createKnowledgeBaseManagementTools(mockPipeline, "my-kb")
        const result = await tools.getKnowledgeBaseStats.execute!(
          {},
          { toolCallId: "test", messages: [], context: {} }
        )

        expect(result).toBe("Error getting knowledge base stats.")
      })
    })

    describe("clearKnowledgeBase tool", () => {
      it("should clear when confirmed", async () => {
        const tools = createKnowledgeBaseManagementTools(mockPipeline, "my-kb")
        const result = await tools.clearKnowledgeBase.execute!(
          { confirm: true },
          { toolCallId: "test", messages: [], context: {} }
        )

        expect(mockPipeline.clearCollection).toHaveBeenCalledWith("my-kb")
        expect(result).toContain("has been cleared")
      })

      it("should cancel when not confirmed", async () => {
        const tools = createKnowledgeBaseManagementTools(mockPipeline, "my-kb")
        const result = await tools.clearKnowledgeBase.execute!(
          { confirm: false },
          { toolCallId: "test", messages: [], context: {} }
        )

        expect(mockPipeline.clearCollection).not.toHaveBeenCalled()
        expect(result).toContain("cancelled")
      })

      it("should handle errors", async () => {
        mockPipeline.clearCollection.mockImplementation(() => {
          throw new Error("Clear error")
        })

        const tools = createKnowledgeBaseManagementTools(mockPipeline, "my-kb")
        const result = await tools.clearKnowledgeBase.execute!(
          { confirm: true },
          { toolCallId: "test", messages: [], context: {} }
        )

        expect(result).toBe("Error clearing knowledge base.")
      })
    })
  })
})
