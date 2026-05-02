/**
 * RAG Tools for AI SDK Integration
 *
 * Provides tool definitions for use with streamText and generateText.
 * Uses the createTool helper from tool-utils for consistent type handling.
 *
 * NOTE: These tools are designed for use with RAGPipeline which provides
 * advanced features like hybrid search, reranking, and query expansion.
 * The pipeline stores data in-memory, so for persistent storage across
 * sessions, use the unified IVectorStore interface (lib/vector/store.ts)
 * which supports ChromaDB, Pinecone, Qdrant, Milvus, Weaviate, and native backends.
 *
 * For agent/chat integration, see:
 * - This file: createRAGTools (advanced features, in-memory pipeline)
 */

import { z } from "zod"
import { createTool, combineTools } from "@/lib/ai/tools/tool-utils"
import type { RAGPipeline } from "./rag-pipeline"
import { loggers } from "@/lib/logger"

const log = loggers.ai

export interface RAGToolsConfig {
  /** The RAG pipeline instance to use */
  pipeline: RAGPipeline
  /** Name of the collection to search/update */
  collectionName: string
  /** Maximum results to return from search (default: 5) */
  topK?: number
  /** Minimum similarity threshold (default: 0.5) */
  similarityThreshold?: number
  /** Whether to include the addResource tool (default: true) */
  enableAddResource?: boolean
  /** Whether to include the filteredSearch tool (default: false) */
  enableFilteredSearch?: boolean
}

// Schema definitions
const getInformationSchema = z.object({
  question: z.string().describe("The question or topic to search for in the knowledge base"),
})

const addResourceSchema = z.object({
  content: z.string().describe("The content to add to the knowledge base"),
  title: z.string().optional().describe("Optional title for the content"),
  category: z.string().optional().describe("Optional category for organizing the content"),
})

const searchWithFiltersSchema = z.object({
  query: z.string().describe("The search query"),
  category: z.string().optional().describe("Filter by category"),
  source: z.string().optional().describe("Filter by source"),
  limit: z.number().optional().describe("Maximum number of results (default: 5)"),
})

const simpleQuestionSchema = z.object({
  question: z.string().describe("The question to search for"),
})

const emptySchema = z.object({})

const confirmSchema = z.object({
  confirm: z.boolean().describe("Must be true to confirm deletion"),
})

/**
 * Create RAG tools for use with AI SDK's streamText/generateText
 */
export function createRAGTools(config: RAGToolsConfig) {
  const {
    pipeline,
    collectionName,
    topK = 5,
    similarityThreshold = 0.5,
    enableAddResource = true,
    enableFilteredSearch = false,
  } = config

  // Base tool: getInformation
  const getInformationTool = createTool({
    description: `Search the knowledge base for relevant information to answer questions. 
Always use this tool before answering questions that might require specific knowledge.`,
    inputSchema: getInformationSchema,
    execute: async (input: z.infer<typeof getInformationSchema>) => {
      try {
        const context = await pipeline.retrieve(collectionName, input.question)

        if (context.documents.length === 0) {
          return "No relevant information found in the knowledge base."
        }

        const relevantDocs = context.documents
          .filter((d) => d.rerankScore >= similarityThreshold)
          .slice(0, topK)

        if (relevantDocs.length === 0) {
          return "No sufficiently relevant information found."
        }

        return relevantDocs
          .map((doc, i) => {
            const source = doc.metadata?.source ? ` (Source: ${doc.metadata.source})` : ""
            const title = doc.metadata?.title ? `\nTitle: ${doc.metadata.title}` : ""
            return `[Source ${i + 1}]${source} (Relevance: ${(doc.rerankScore * 100).toFixed(0)}%)${title}\n${doc.content}`
          })
          .join("\n\n---\n\n")
      } catch (error) {
        log.error("RAG getInformation error", error as Error)
        return "Error retrieving information from knowledge base."
      }
    },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { getInformation: getInformationTool }

  // Optional tool: addResource
  if (enableAddResource) {
    const addResourceTool = createTool({
      description: `Add new information to the knowledge base for future reference.`,
      inputSchema: addResourceSchema,
      execute: async (input: z.infer<typeof addResourceSchema>) => {
        try {
          const metadata: Record<string, unknown> = {
            addedAt: new Date().toISOString(),
          }
          if (input.category) metadata.category = input.category

          const result = await pipeline.indexDocument(input.content, {
            collectionName,
            documentId: `user-doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            documentTitle: input.title,
            metadata,
          })

          return result.success
            ? `Successfully added content (${result.chunksCreated} chunks created).`
            : `Failed to add content: ${result.error}`
        } catch (error) {
          log.error("RAG addResource error", error as Error)
          return "Error adding content to knowledge base."
        }
      },
    })
    tools.addResource = addResourceTool
  }

  // Optional tool: searchWithFilters
  if (enableFilteredSearch) {
    const searchWithFiltersTool = createTool({
      description: `Search the knowledge base with specific filters like category or source.`,
      inputSchema: searchWithFiltersSchema,
      execute: async (input: z.infer<typeof searchWithFiltersSchema>) => {
        try {
          const context = await pipeline.retrieve(collectionName, input.query)

          let results = context.documents

          if (input.category) {
            results = results.filter((d) => d.metadata?.category === input.category)
          }
          if (input.source) {
            results = results.filter((d) => d.metadata?.source === input.source)
          }

          const limitedResults = results.slice(0, input.limit ?? topK)

          if (limitedResults.length === 0) {
            return "No results found matching the specified filters."
          }

          return limitedResults
            .map(
              (doc, i) =>
                `[Result ${i + 1}] (Score: ${(doc.rerankScore * 100).toFixed(0)}%)\n${doc.content}`
            )
            .join("\n\n---\n\n")
        } catch (error) {
          log.error("RAG searchWithFilters error", error as Error)
          return "Error performing filtered search."
        }
      },
    })
    tools.searchWithFilters = searchWithFiltersTool
  }

  return tools
}

/**
 * Create a simple retrieval tool for basic RAG use cases
 */
export function createSimpleRetrievalTool(
  findRelevantContent: (
    query: string
  ) => Promise<Array<{ content: string; similarity: number; source?: string }>>
) {
  return createTool({
    description: "Search the knowledge base for relevant information to answer questions.",
    inputSchema: simpleQuestionSchema,
    execute: async (input: z.infer<typeof simpleQuestionSchema>) => {
      try {
        const results = await findRelevantContent(input.question)

        if (results.length === 0) {
          return "No relevant information found."
        }

        return results
          .map((r, i) => {
            const source = r.source ? ` (Source: ${r.source})` : ""
            return `[${i + 1}]${source} (${(r.similarity * 100).toFixed(0)}% match): ${r.content}`
          })
          .join("\n\n")
      } catch (error) {
        log.error("Retrieval tool error", error as Error)
        return "Error searching knowledge base."
      }
    },
  })
}

/**
 * Create knowledge base management tools
 */
export function createKnowledgeBaseManagementTools(pipeline: RAGPipeline, collectionName: string) {
  const statsTool = createTool({
    description: "Get statistics about the knowledge base",
    inputSchema: emptySchema,
    execute: async () => {
      try {
        const stats = await pipeline.getCollectionStats(collectionName)
        return `Knowledge base "${collectionName}": ${stats.documentCount} documents indexed, exists: ${stats.exists}`
      } catch (error) {
        log.error("Stats error", error as Error)
        return "Error getting knowledge base stats."
      }
    },
  })

  const clearTool = createTool({
    description: "Clear all documents from the knowledge base. Use with caution!",
    inputSchema: confirmSchema,
    execute: async (input: z.infer<typeof confirmSchema>) => {
      if (!input.confirm) {
        return "Deletion cancelled. Set confirm to true to proceed."
      }
      try {
        await pipeline.clearCollection(collectionName)
        return `Knowledge base "${collectionName}" has been cleared.`
      } catch (error) {
        log.error("Clear error", error as Error)
        return "Error clearing knowledge base."
      }
    },
  })

  return {
    getKnowledgeBaseStats: statsTool,
    clearKnowledgeBase: clearTool,
  }
}

// Re-export combineTools for convenience
export { combineTools }
