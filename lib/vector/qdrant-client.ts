/**
 * Qdrant Vector Database Client
 * Supports both local and cloud deployments
 */

import { QdrantClient } from "@qdrant/js-client-rest"
import type { EmbeddingModelConfig } from "./embedding"
import { generateEmbeddings, generateEmbedding } from "./embedding"

export interface QdrantConfig {
  url: string
  apiKey?: string
  collectionName: string
  embeddingConfig: EmbeddingModelConfig
  embeddingApiKey: string
}

export interface QdrantDocument {
  id: string | number
  content: string
  metadata?: Record<string, unknown>
  embedding?: number[]
}

export interface QdrantSearchResult {
  id: string | number
  content: string
  metadata?: Record<string, unknown>
  score: number
}

export interface QdrantCollectionInfo {
  name: string
  vectorsCount: number
  pointsCount: number
  status: string
  vectorSize: number
  distance: string
}

let qdrantInstance: QdrantClient | null = null

/**
 * Get or create Qdrant client instance
 */
export function getQdrantClient(url: string, apiKey?: string): QdrantClient {
  if (!qdrantInstance) {
    qdrantInstance = new QdrantClient({
      url,
      apiKey,
    })
  }
  return qdrantInstance
}

/**
 * Reset Qdrant client instance
 */
export function resetQdrantClient(): void {
  qdrantInstance = null
}

/**
 * Create a new collection
 */
export async function createQdrantCollection(
  client: QdrantClient,
  name: string,
  vectorSize: number,
  options: {
    distance?: "Cosine" | "Euclid" | "Dot"
    onDiskPayload?: boolean
  } = {}
): Promise<void> {
  const { distance = "Cosine", onDiskPayload = false } = options

  await client.createCollection(name, {
    vectors: {
      size: vectorSize,
      distance,
    },
    on_disk_payload: onDiskPayload,
  })
}

/**
 * Delete a collection
 */
export async function deleteQdrantCollection(client: QdrantClient, name: string): Promise<void> {
  await client.deleteCollection(name)
}

/**
 * List all collections
 */
export async function listQdrantCollections(client: QdrantClient): Promise<QdrantCollectionInfo[]> {
  const response = await client.getCollections()

  const infos: QdrantCollectionInfo[] = []
  for (const collection of response.collections) {
    try {
      const info = await client.getCollection(collection.name)
      const vectors = info.config.params.vectors
      infos.push({
        name: collection.name,
        vectorsCount: info.indexed_vectors_count ?? 0,
        pointsCount: info.points_count ?? 0,
        status: info.status,
        vectorSize:
          typeof vectors === "object" && vectors !== null && "size" in vectors
            ? (vectors as { size: number }).size
            : 0,
        distance:
          typeof vectors === "object" && vectors !== null && "distance" in vectors
            ? String((vectors as { distance: string }).distance)
            : "unknown",
      })
    } catch {
      infos.push({
        name: collection.name,
        vectorsCount: 0,
        pointsCount: 0,
        status: "unknown",
        vectorSize: 0,
        distance: "unknown",
      })
    }
  }

  return infos
}

/**
 * Check if collection exists
 */
export async function collectionExists(client: QdrantClient, name: string): Promise<boolean> {
  try {
    await client.getCollection(name)
    return true
  } catch {
    return false
  }
}

/**
 * Upsert documents to Qdrant
 */
export async function upsertQdrantDocuments(
  client: QdrantClient,
  collectionName: string,
  documents: QdrantDocument[],
  config: QdrantConfig
): Promise<void> {
  const needsEmbedding = documents.some((doc) => !doc.embedding)
  let embeddings: number[][] | undefined

  if (needsEmbedding) {
    const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)

    if (textsToEmbed.length > 0) {
      const result = await generateEmbeddings(
        textsToEmbed,
        config.embeddingConfig,
        config.embeddingApiKey
      )

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

  const points = documents.map((doc, i) => ({
    id: typeof doc.id === "string" ? doc.id : doc.id,
    vector: embeddings![i],
    payload: {
      content: doc.content,
      ...doc.metadata,
    },
  }))

  // Batch upserts in chunks of 100
  const batchSize = 100
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize)
    await client.upsert(collectionName, {
      wait: true,
      points: batch,
    })
  }
}

/**
 * Query Qdrant for similar documents
 */
export async function queryQdrant(
  client: QdrantClient,
  collectionName: string,
  query: string,
  config: QdrantConfig,
  options: {
    topK?: number
    filter?: Record<string, unknown>
    scoreThreshold?: number
  } = {}
): Promise<QdrantSearchResult[]> {
  const { topK = 5, filter, scoreThreshold } = options

  const queryResult = await generateEmbedding(query, config.embeddingConfig, config.embeddingApiKey)

  let points: Array<{ id: string | number; payload?: Record<string, unknown>; score: number }> = []
  try {
    const queryPayload: Record<string, unknown> = {
      query: queryResult.embedding,
      limit: topK,
      filter: filter as Record<string, unknown> | undefined,
      score_threshold: scoreThreshold,
      with_payload: true,
      with_vector: false,
    }

    const response = await client.query(collectionName, {
      ...(queryPayload as Parameters<QdrantClient["query"]>[1]),
    })
    points =
      (
        response as {
          points?: Array<{ id: string | number; payload?: Record<string, unknown>; score: number }>
        }
      ).points || []
  } catch {
    const fallback = await client.search(collectionName, {
      vector: queryResult.embedding,
      limit: topK,
      filter: filter as Record<string, unknown> | undefined,
      score_threshold: scoreThreshold,
      with_payload: true,
    })
    points = fallback as Array<{
      id: string | number
      payload?: Record<string, unknown>
      score: number
    }>
  }

  return points.map((result) => ({
    id: result.id,
    content: (result.payload?.content as string) || "",
    metadata: result.payload as Record<string, unknown> | undefined,
    score: result.score,
  }))
}

/**
 * Delete documents by IDs
 */
export async function deleteQdrantDocuments(
  client: QdrantClient,
  collectionName: string,
  ids: (string | number)[]
): Promise<void> {
  await client.delete(collectionName, {
    wait: true,
    points: ids,
  })
}

/**
 * Delete documents by filter
 */
export async function deleteQdrantByFilter(
  client: QdrantClient,
  collectionName: string,
  filter: Record<string, unknown>
): Promise<void> {
  await client.delete(collectionName, {
    wait: true,
    filter,
  })
}

/**
 * Get documents by IDs
 */
export async function getQdrantDocuments(
  client: QdrantClient,
  collectionName: string,
  ids: (string | number)[]
): Promise<QdrantDocument[]> {
  const results = await client.retrieve(collectionName, {
    ids,
    with_payload: true,
    with_vector: true,
  })

  return results.map((point) => ({
    id: point.id,
    content: (point.payload?.content as string) || "",
    metadata: point.payload as Record<string, unknown> | undefined,
    embedding: point.vector as number[] | undefined,
  }))
}

/**
 * Get collection info
 */
export async function getQdrantCollectionInfo(
  client: QdrantClient,
  collectionName: string
): Promise<QdrantCollectionInfo> {
  const info = await client.getCollection(collectionName)
  const vectors = info.config.params.vectors

  return {
    name: collectionName,
    vectorsCount: info.indexed_vectors_count ?? 0,
    pointsCount: info.points_count ?? 0,
    status: info.status,
    vectorSize:
      typeof vectors === "object" && vectors !== null && "size" in vectors
        ? (vectors as { size: number }).size
        : 0,
    distance:
      typeof vectors === "object" && vectors !== null && "distance" in vectors
        ? String((vectors as { distance: string }).distance)
        : "unknown",
  }
}

/**
 * Scroll through all points in a collection
 */
export async function scrollQdrantCollection(
  client: QdrantClient,
  collectionName: string,
  options: {
    limit?: number
    offset?: string | number
    filter?: Record<string, unknown>
    withPayload?: boolean
    withVector?: boolean
  } = {}
): Promise<{
  documents: QdrantDocument[]
  nextOffset?: string | number
}> {
  const { limit = 100, offset, filter, withPayload = true, withVector = false } = options

  const result = await client.scroll(collectionName, {
    limit,
    offset,
    filter,
    with_payload: withPayload,
    with_vector: withVector,
  })

  return {
    documents: result.points.map((point) => ({
      id: point.id,
      content: (point.payload?.content as string) || "",
      metadata: point.payload as Record<string, unknown> | undefined,
      embedding: point.vector as number[] | undefined,
    })),
    nextOffset:
      typeof result.next_page_offset === "string" || typeof result.next_page_offset === "number"
        ? result.next_page_offset
        : undefined,
  }
}
