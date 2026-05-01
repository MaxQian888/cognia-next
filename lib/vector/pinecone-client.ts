/**
 * Pinecone Vector Database Client
 * Supports serverless and pod-based indexes
 */

import { Pinecone, type Index, type RecordMetadata } from "@pinecone-database/pinecone"
import type { EmbeddingModelConfig } from "./embedding"
import { generateEmbeddings, generateEmbedding } from "./embedding"

export interface PineconeConfig {
  apiKey: string
  indexName: string
  namespace?: string
  embeddingConfig: EmbeddingModelConfig
  embeddingApiKey: string
}

export interface PineconeDocument {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean | string[]>
  embedding?: number[]
}

export interface PineconeSearchResult {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean | string[]>
  score: number
}

export interface PineconeIndexInfo {
  name: string
  dimension: number
  metric: string
  host: string
  deletionProtection?: "enabled" | "disabled"
  tags?: Record<string, string>
  status: {
    ready: boolean
    state: string
  }
}

let pineconeInstance: Pinecone | null = null
const PINECONE_DEFAULT_NAMESPACE = "__default__"

function getNamespaceIndex(
  index: Index<RecordMetadata>,
  namespace?: string
): Index<RecordMetadata> {
  const resolved = namespace && namespace.trim().length > 0 ? namespace : PINECONE_DEFAULT_NAMESPACE
  return index.namespace(resolved)
}

/**
 * Get or create Pinecone client instance
 */
export function getPineconeClient(apiKey: string): Pinecone {
  if (!pineconeInstance) {
    pineconeInstance = new Pinecone({ apiKey })
  }
  return pineconeInstance
}

/**
 * Reset Pinecone client instance
 */
export function resetPineconeClient(): void {
  pineconeInstance = null
}

/**
 * Get a Pinecone index
 */
export function getPineconeIndex(client: Pinecone, indexName: string): Index<RecordMetadata> {
  return client.index(indexName)
}

/**
 * List all indexes
 */
export async function listPineconeIndexes(client: Pinecone): Promise<PineconeIndexInfo[]> {
  const response = await client.listIndexes()

  return (response.indexes || []).map((index) => ({
    name: index.name,
    dimension: index.dimension ?? 0,
    metric: index.metric,
    host: index.host,
    deletionProtection: index.deletionProtection as "enabled" | "disabled" | undefined,
    tags: index.tags,
    status: {
      ready: index.status?.ready ?? false,
      state: index.status?.state ?? "unknown",
    },
  }))
}

/**
 * Create a new index
 */
export async function createPineconeIndex(
  client: Pinecone,
  name: string,
  dimension: number,
  options: {
    metric?: "cosine" | "euclidean" | "dotproduct"
    cloud?: "aws" | "gcp" | "azure"
    region?: string
    waitUntilReady?: boolean
    suppressConflicts?: boolean
    deletionProtection?: "enabled" | "disabled"
    tags?: Record<string, string>
  } = {}
): Promise<void> {
  const {
    metric = "cosine",
    cloud = "aws",
    region = "us-east-1",
    waitUntilReady = true,
    suppressConflicts = false,
    deletionProtection = "disabled",
    tags,
  } = options

  await client.createIndex({
    name,
    dimension,
    metric,
    spec: {
      serverless: {
        cloud,
        region,
      },
    },
    waitUntilReady,
    suppressConflicts,
    deletionProtection,
    tags,
  })
}

/**
 * Describe an index
 */
export async function describePineconeIndex(
  client: Pinecone,
  name: string
): Promise<PineconeIndexInfo> {
  const index = await client.describeIndex(name)

  return {
    name: index.name,
    dimension: index.dimension ?? 0,
    metric: index.metric,
    host: index.host,
    deletionProtection: index.deletionProtection as "enabled" | "disabled" | undefined,
    tags: index.tags,
    status: {
      ready: index.status?.ready ?? false,
      state: index.status?.state ?? "unknown",
    },
  }
}

/**
 * Configure index (update deletionProtection or tags)
 */
export async function configurePineconeIndex(
  client: Pinecone,
  name: string,
  options: {
    deletionProtection?: "enabled" | "disabled"
    tags?: Record<string, string>
  }
): Promise<void> {
  await client.configureIndex({
    name,
    deletionProtection: options.deletionProtection,
    tags: options.tags,
  })
}

/**
 * Delete an index
 */
export async function deletePineconeIndex(client: Pinecone, name: string): Promise<void> {
  await client.deleteIndex(name)
}

/**
 * Upsert documents to Pinecone
 */
export async function upsertDocuments(
  index: Index<RecordMetadata>,
  documents: PineconeDocument[],
  config: PineconeConfig
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

  const vectors = documents.map((doc, i) => ({
    id: doc.id,
    values: embeddings![i],
    metadata: {
      content: doc.content,
      ...doc.metadata,
    },
  }))

  // Pinecone recommends batching upserts in chunks of 100
  const batchSize = 100
  const ns = getNamespaceIndex(index, config.namespace)

  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize)
    await ns.upsert({ records: batch })
  }
}

/**
 * Query Pinecone for similar documents
 */
export async function queryPinecone(
  index: Index<RecordMetadata>,
  query: string,
  config: PineconeConfig,
  options: {
    topK?: number
    filter?: Record<string, unknown>
    includeMetadata?: boolean
  } = {}
): Promise<PineconeSearchResult[]> {
  const queryResult = await generateEmbedding(query, config.embeddingConfig, config.embeddingApiKey)

  return queryPineconeByEmbedding(index, queryResult.embedding, config, options)
}

export async function queryPineconeByEmbedding(
  index: Index<RecordMetadata>,
  embedding: number[],
  config: PineconeConfig,
  options: {
    topK?: number
    filter?: Record<string, unknown>
    includeMetadata?: boolean
  } = {}
): Promise<PineconeSearchResult[]> {
  const { topK = 5, filter, includeMetadata = true } = options
  const ns = getNamespaceIndex(index, config.namespace)

  const results = await ns.query({
    vector: embedding,
    topK,
    filter,
    includeMetadata,
  })

  return (results.matches || []).map((match) => ({
    id: match.id,
    content: (match.metadata?.content as string) || "",
    metadata: match.metadata as Record<string, string | number | boolean | string[]> | undefined,
    score: match.score || 0,
  }))
}

/**
 * Delete documents by IDs
 */
export async function deleteDocuments(
  index: Index<RecordMetadata>,
  ids: string[],
  namespace?: string
): Promise<void> {
  const ns = getNamespaceIndex(index, namespace)
  await ns.deleteMany(ids)
}

/**
 * Delete all documents in a namespace
 */
export async function deleteAllDocuments(
  index: Index<RecordMetadata>,
  namespace?: string
): Promise<void> {
  const ns = getNamespaceIndex(index, namespace)
  await ns.deleteAll()
}

/**
 * Fetch documents by IDs
 */
export async function fetchDocuments(
  index: Index<RecordMetadata>,
  ids: string[],
  namespace?: string
): Promise<PineconeDocument[]> {
  const ns = getNamespaceIndex(index, namespace)
  const results = await ns.fetch({ ids })

  return Object.entries(results.records || {}).map(([id, record]) => ({
    id,
    content: (record.metadata?.content as string) || "",
    metadata: record.metadata as Record<string, string | number | boolean | string[]> | undefined,
    embedding: record.values,
  }))
}

/**
 * Get index statistics
 */
export async function getIndexStats(index: Index<RecordMetadata>): Promise<{
  totalVectorCount: number
  dimension: number
  namespaces: Record<string, { vectorCount: number }>
}> {
  const stats = await index.describeIndexStats()

  return {
    totalVectorCount: stats.totalRecordCount || 0,
    dimension: stats.dimension || 0,
    namespaces: Object.fromEntries(
      Object.entries(stats.namespaces || {}).map(([name, ns]) => [
        name,
        { vectorCount: ns.recordCount || 0 },
      ])
    ),
  }
}
