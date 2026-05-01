/**
 * ChromaDB Client - Vector database integration
 * Supports both embedded (local) and server modes
 */

import {
  ChromaClient,
  Collection,
  type Where,
  type WhereDocument,
  type CollectionMetadata,
} from "chromadb"
import type { EmbeddingModelConfig } from "./embedding"
import { generateEmbeddings, generateEmbedding } from "./embedding"

export type ChromaMode = "embedded" | "server"

export interface ChromaConfig {
  mode: ChromaMode
  serverUrl?: string // For server mode
  embeddingConfig: EmbeddingModelConfig
  apiKey: string
}

export interface DocumentChunk {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean>
  embedding?: number[]
}

export interface SearchResult {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean>
  distance: number
  similarity: number
}

export interface CollectionInfo {
  name: string
  count: number
  metadata?: Record<string, unknown>
}

let chromaClientInstance: ChromaClient | null = null

/**
 * Get or create ChromaDB client instance
 */
export function getChromaClient(config: ChromaConfig): ChromaClient {
  if (!chromaClientInstance) {
    if (config.mode === "server" && config.serverUrl) {
      chromaClientInstance = new ChromaClient({
        path: config.serverUrl,
      })
    } else {
      // Embedded mode - uses local storage
      chromaClientInstance = new ChromaClient()
    }
  }
  return chromaClientInstance
}

/**
 * Reset ChromaDB client instance
 */
export function resetChromaClient(): void {
  chromaClientInstance = null
}

/**
 * Create or get a collection
 */
export async function getOrCreateCollection(
  client: ChromaClient,
  name: string,
  metadata?: CollectionMetadata
): Promise<Collection> {
  return client.getOrCreateCollection({
    name,
    metadata,
  })
}

/**
 * Delete a collection
 */
export async function deleteCollection(client: ChromaClient, name: string): Promise<void> {
  await client.deleteCollection({ name })
}

/**
 * List all collections
 */
export async function listCollections(client: ChromaClient): Promise<CollectionInfo[]> {
  const collections = await client.listCollections()
  const infos: CollectionInfo[] = []

  for (const collectionItem of collections as unknown as Array<{ name?: string } | string>) {
    const collectionName =
      typeof collectionItem === "string" ? collectionItem : (collectionItem?.name ?? "")
    if (!collectionName) continue
    try {
      const collection = await client.getCollection({ name: collectionName })
      const count = await collection.count()
      infos.push({
        name: collectionName,
        count,
      })
    } catch {
      // Collection might have been deleted, skip it
      infos.push({
        name: collectionName,
        count: 0,
      })
    }
  }

  return infos
}

/**
 * Add documents to a collection with auto-generated embeddings
 */
export async function addDocuments(
  collection: Collection,
  documents: DocumentChunk[],
  config: ChromaConfig
): Promise<void> {
  const ids = documents.map((doc) => doc.id)
  const contents = documents.map((doc) => doc.content)
  const metadatas = documents.map((doc) => doc.metadata || {})

  // Generate embeddings if not provided
  const needsEmbedding = documents.some((doc) => !doc.embedding)
  let embeddings: number[][] | undefined

  if (needsEmbedding) {
    const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)

    if (textsToEmbed.length > 0) {
      const result = await generateEmbeddings(textsToEmbed, config.embeddingConfig, config.apiKey)

      // Merge with existing embeddings
      let embeddingIndex = 0
      embeddings = documents.map((doc) => {
        if (doc.embedding) {
          return doc.embedding
        }
        return result.embeddings[embeddingIndex++]
      })
    }
  } else {
    embeddings = documents.map((doc) => doc.embedding!)
  }

  await collection.add({
    ids,
    documents: contents,
    metadatas,
    embeddings,
  })
}

/**
 * Update documents in a collection
 */
export async function updateDocuments(
  collection: Collection,
  documents: DocumentChunk[],
  config: ChromaConfig
): Promise<void> {
  const ids = documents.map((doc) => doc.id)
  const contents = documents.map((doc) => doc.content)
  const metadatas = documents.map((doc) => doc.metadata || {})

  // Generate new embeddings
  const result = await generateEmbeddings(contents, config.embeddingConfig, config.apiKey)

  await collection.update({
    ids,
    documents: contents,
    metadatas,
    embeddings: result.embeddings,
  })
}

/**
 * Delete documents from a collection
 */
export async function deleteDocuments(collection: Collection, ids: string[]): Promise<void> {
  await collection.delete({ ids })
}

/**
 * Query collection for similar documents
 */
export async function queryCollection(
  collection: Collection,
  query: string,
  config: ChromaConfig,
  options: {
    nResults?: number
    where?: Where
    whereDocument?: WhereDocument
  } = {}
): Promise<SearchResult[]> {
  const { nResults = 5, where, whereDocument } = options

  // Generate query embedding
  const queryResult = await generateEmbedding(query, config.embeddingConfig, config.apiKey)

  const results = await collection.query({
    queryEmbeddings: [queryResult.embedding],
    nResults,
    where,
    whereDocument,
    include: ["documents", "metadatas", "distances"],
  })

  // Transform results
  const searchResults: SearchResult[] = []
  const ids = results.ids[0] || []
  const documents = results.documents?.[0] || []
  const metadatas = results.metadatas?.[0] || []
  const distances = results.distances?.[0] || []

  for (let i = 0; i < ids.length; i++) {
    const distance = distances[i] || 0
    searchResults.push({
      id: ids[i],
      content: documents[i] || "",
      metadata: metadatas[i] as Record<string, string | number | boolean> | undefined,
      distance,
      similarity: 1 - distance, // Convert distance to similarity
    })
  }

  return searchResults
}

/**
 * Get documents by IDs
 */
export async function getDocuments(
  collection: Collection,
  ids: string[]
): Promise<DocumentChunk[]> {
  const results = await collection.get({
    ids,
    include: ["documents", "metadatas", "embeddings"],
  })

  const documents: DocumentChunk[] = []
  for (let i = 0; i < results.ids.length; i++) {
    documents.push({
      id: results.ids[i],
      content: results.documents?.[i] || "",
      metadata: results.metadatas?.[i] as Record<string, string | number | boolean> | undefined,
      embedding: results.embeddings?.[i] as number[] | undefined,
    })
  }

  return documents
}

/**
 * Upsert documents (add or update)
 */
export async function upsertDocuments(
  collection: Collection,
  documents: DocumentChunk[],
  config: ChromaConfig
): Promise<void> {
  const ids = documents.map((doc) => doc.id)
  const contents = documents.map((doc) => doc.content)
  const metadatas = documents.map((doc) => doc.metadata || {})

  const needsEmbedding = documents.some((doc) => !doc.embedding)
  let embeddings: number[][] | undefined

  if (needsEmbedding) {
    const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)

    if (textsToEmbed.length > 0) {
      const result = await generateEmbeddings(textsToEmbed, config.embeddingConfig, config.apiKey)

      let embeddingIndex = 0
      embeddings = documents.map((doc) => {
        if (doc.embedding) {
          return doc.embedding
        }
        return result.embeddings[embeddingIndex++]
      })
    }
  } else {
    embeddings = documents.map((doc) => doc.embedding!)
  }

  await collection.upsert({
    ids,
    documents: contents,
    metadatas,
    embeddings,
  })
}

/**
 * Get collection count
 */
export async function getCollectionCount(collection: Collection): Promise<number> {
  return collection.count()
}

/**
 * Peek at collection (get first n documents)
 */
export async function peekCollection(
  collection: Collection,
  limit: number = 10
): Promise<DocumentChunk[]> {
  const results = await collection.peek({ limit })

  const documents: DocumentChunk[] = []
  for (let i = 0; i < results.ids.length; i++) {
    documents.push({
      id: results.ids[i],
      content: results.documents?.[i] || "",
      metadata: results.metadatas?.[i] as Record<string, string | number | boolean> | undefined,
    })
  }

  return documents
}
