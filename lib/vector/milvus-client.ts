/**
 * Milvus Vector Database Client
 * Supports both self-hosted and Zilliz Cloud deployments
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node"
import type { EmbeddingModelConfig } from "./embedding"
import { generateEmbeddings, generateEmbedding } from "./embedding"

export interface MilvusConfig {
  address: string
  token?: string
  username?: string
  password?: string
  ssl?: boolean
  collectionName: string
  embeddingConfig: EmbeddingModelConfig
  embeddingApiKey: string
}

export interface MilvusDocument {
  id: string | number
  content: string
  metadata?: Record<string, unknown>
  embedding?: number[]
}

export interface MilvusSearchResult {
  id: string | number
  content: string
  metadata?: Record<string, unknown>
  score: number
}

export interface MilvusCollectionInfo {
  name: string
  vectorsCount: number
  status: string
  vectorSize: number
  metricType: string
  description?: string
}

export interface MilvusIndexInfo {
  fieldName: string
  indexType: string
  metricType: string
  params?: Record<string, unknown>
}

let milvusInstance: MilvusClient | null = null

/**
 * Get or create Milvus client instance
 */
export function getMilvusClient(config: {
  address: string
  token?: string
  username?: string
  password?: string
  ssl?: boolean
}): MilvusClient {
  if (!milvusInstance) {
    milvusInstance = new MilvusClient({
      address: config.address,
      token: config.token,
      username: config.username,
      password: config.password,
      ssl: config.ssl,
    })
  }
  return milvusInstance
}

/**
 * Reset Milvus client instance
 */
export function resetMilvusClient(): void {
  if (milvusInstance) {
    milvusInstance.closeConnection()
  }
  milvusInstance = null
}

/**
 * Check if collection exists
 */
export async function milvusCollectionExists(client: MilvusClient, name: string): Promise<boolean> {
  const response = await client.hasCollection({ collection_name: name })
  return Boolean(response.value)
}

/**
 * Create a new collection with automatic schema generation
 */
export async function createMilvusCollection(
  client: MilvusClient,
  name: string,
  vectorSize: number,
  options: {
    metricType?: "L2" | "IP" | "COSINE"
    description?: string
    enableDynamicField?: boolean
    autoId?: boolean
    primaryFieldName?: string
    vectorFieldName?: string
    contentFieldName?: string
  } = {}
): Promise<void> {
  const {
    metricType = "COSINE",
    description = "",
    enableDynamicField = true,
    autoId = false,
    primaryFieldName = "id",
    vectorFieldName = "vector",
    contentFieldName = "content",
  } = options

  // Check if collection already exists
  const exists = await milvusCollectionExists(client, name)
  if (exists) {
    return
  }

  // Define schema fields
  const fields = [
    {
      name: primaryFieldName,
      data_type: DataType.VarChar,
      is_primary_key: true,
      autoID: autoId,
      max_length: 512,
    },
    {
      name: vectorFieldName,
      data_type: DataType.FloatVector,
      dim: vectorSize,
    },
    {
      name: contentFieldName,
      data_type: DataType.VarChar,
      max_length: 65535,
    },
  ]

  // Create collection with schema
  await client.createCollection({
    collection_name: name,
    description,
    fields,
    enable_dynamic_field: enableDynamicField,
  })

  // Create vector index for search performance
  await client.createIndex({
    collection_name: name,
    field_name: vectorFieldName,
    index_type: "HNSW",
    metric_type: metricType,
    params: { M: 16, efConstruction: 256 },
  })

  // Load collection into memory for searching
  await client.loadCollection({ collection_name: name })
}

/**
 * Delete a collection
 */
export async function deleteMilvusCollection(client: MilvusClient, name: string): Promise<void> {
  const exists = await milvusCollectionExists(client, name)
  if (exists) {
    await client.dropCollection({ collection_name: name })
  }
}

/**
 * List all collections
 */
export async function listMilvusCollections(client: MilvusClient): Promise<MilvusCollectionInfo[]> {
  const response = await client.listCollections()
  const infos: MilvusCollectionInfo[] = []

  for (const collection of response.data) {
    const collectionName = typeof collection === "string" ? collection : collection.name
    try {
      const info = await getMilvusCollectionInfo(client, collectionName)
      infos.push(info)
    } catch {
      infos.push({
        name: collectionName,
        vectorsCount: 0,
        status: "unknown",
        vectorSize: 0,
        metricType: "unknown",
      })
    }
  }

  return infos
}

/**
 * Get collection info
 */
export async function getMilvusCollectionInfo(
  client: MilvusClient,
  collectionName: string
): Promise<MilvusCollectionInfo> {
  const describeResponse = await client.describeCollection({
    collection_name: collectionName,
  })

  const statsResponse = await client.getCollectionStatistics({
    collection_name: collectionName,
  })

  // Find vector field dimension
  let vectorSize = 0
  for (const field of describeResponse.schema.fields) {
    // @ts-expect-error - DataType enum comparison with string
    if (field.data_type === DataType.FloatVector || field.data_type === "FloatVector") {
      vectorSize = Number((field.type_params as any[])?.find((p) => p.key === "dim")?.value) || 0
      break
    }
  }

  // Get index info for metric type
  let metricType = "unknown"
  try {
    const indexResponse = await client.describeIndex({
      collection_name: collectionName,
      field_name: "vector",
    })
    if (indexResponse.index_descriptions && indexResponse.index_descriptions.length > 0) {
      const indexParams = indexResponse.index_descriptions[0].params
      if (indexParams) {
        const metricParam = (indexParams as any[]).find((p) => p.key === "metric_type")
        if (metricParam) {
          metricType = String(metricParam.value)
        }
      }
    }
  } catch {
    // Index might not exist
  }

  // Parse row count from statistics
  let vectorsCount = 0
  const rowCountStat = (statsResponse.stats as any[])?.find((s) => s.key === "row_count")
  if (rowCountStat) {
    vectorsCount = parseInt(String(rowCountStat.value), 10) || 0
  }

  return {
    name: collectionName,
    vectorsCount,
    status: describeResponse.status?.error_code === "Success" ? "ready" : "unknown",
    vectorSize,
    metricType,
    description: describeResponse.schema.description,
  }
}

/**
 * Upsert documents to Milvus
 */
export async function upsertMilvusDocuments(
  client: MilvusClient,
  collectionName: string,
  documents: MilvusDocument[],
  config: MilvusConfig
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

  // Prepare data for upsert
  const data = documents.map((doc, i) => {
    const baseData: Record<string, unknown> = {
      id: String(doc.id),
      vector: embeddings![i],
      content: doc.content,
    }

    // Add metadata fields as dynamic fields
    if (doc.metadata) {
      Object.entries(doc.metadata).forEach(([key, value]) => {
        if (key !== "id" && key !== "vector" && key !== "content") {
          baseData[key] = value
        }
      })
    }

    return baseData
  })

  // Batch upserts in chunks of 1000 (Milvus limit)
  const batchSize = 1000
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize)
    await client.upsert({
      collection_name: collectionName,
      data: batch as any,
    })
  }
}

/**
 * Insert documents to Milvus (without upsert semantics)
 */
export async function insertMilvusDocuments(
  client: MilvusClient,
  collectionName: string,
  documents: MilvusDocument[],
  config: MilvusConfig
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

  // Prepare data for insert
  const data = documents.map((doc, i) => {
    const baseData: Record<string, unknown> = {
      id: String(doc.id),
      vector: embeddings![i],
      content: doc.content,
    }

    // Add metadata fields as dynamic fields
    if (doc.metadata) {
      Object.entries(doc.metadata).forEach(([key, value]) => {
        if (key !== "id" && key !== "vector" && key !== "content") {
          baseData[key] = value
        }
      })
    }

    return baseData
  })

  // Batch inserts in chunks of 1000
  const batchSize = 1000
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize)
    await client.insert({
      collection_name: collectionName,
      data: batch as any,
    })
  }
}

/**
 * Query Milvus for similar documents
 */
export async function queryMilvus(
  client: MilvusClient,
  collectionName: string,
  query: string,
  config: MilvusConfig,
  options: {
    topK?: number
    filter?: string
    outputFields?: string[]
    searchParams?: Record<string, unknown>
  } = {}
): Promise<MilvusSearchResult[]> {
  const { topK = 5, filter, outputFields = ["content", "*"], searchParams } = options

  const queryResult = await generateEmbedding(query, config.embeddingConfig, config.embeddingApiKey)

  const searchResponse = await client.search({
    collection_name: collectionName,
    data: [queryResult.embedding],
    limit: topK,
    filter,
    output_fields: outputFields,
    params: searchParams,
  } as any)

  return (searchResponse.results as any[]).map((result: Record<string, unknown>) => ({
    id: result.id as string | number,
    content: (result.content as string) || "",
    metadata: Object.fromEntries(
      Object.entries(result).filter(([key]) => !["id", "score", "vector"].includes(key))
    ),
    score: result.score as number,
  }))
}

/**
 * Search with vector directly (no embedding generation)
 */
export async function searchMilvusByVector(
  client: MilvusClient,
  collectionName: string,
  vector: number[],
  options: {
    topK?: number
    filter?: string
    outputFields?: string[]
    searchParams?: Record<string, unknown>
  } = {}
): Promise<MilvusSearchResult[]> {
  const { topK = 5, filter, outputFields = ["content", "*"], searchParams } = options

  const searchResponse = await client.search({
    collection_name: collectionName,
    data: [vector],
    limit: topK,
    filter,
    output_fields: outputFields,
    params: searchParams,
  } as any)

  return (searchResponse.results as any[]).map((result: Record<string, unknown>) => ({
    id: result.id as string | number,
    content: (result.content as string) || "",
    metadata: Object.fromEntries(
      Object.entries(result).filter(([key]) => !["id", "score", "vector"].includes(key))
    ),
    score: result.score as number,
  }))
}

/**
 * Delete documents by IDs
 */
export async function deleteMilvusDocuments(
  client: MilvusClient,
  collectionName: string,
  ids: (string | number)[]
): Promise<void> {
  const idsStr = ids.map((id) => `"${id}"`).join(", ")
  await client.delete({
    collection_name: collectionName,
    filter: `id in [${idsStr}]`,
  })
}

/**
 * Delete documents by filter expression
 */
export async function deleteMilvusByFilter(
  client: MilvusClient,
  collectionName: string,
  filter: string
): Promise<void> {
  await client.delete({
    collection_name: collectionName,
    filter,
  })
}

/**
 * Get documents by IDs using query
 */
export async function getMilvusDocuments(
  client: MilvusClient,
  collectionName: string,
  ids: (string | number)[]
): Promise<MilvusDocument[]> {
  const idsStr = ids.map((id) => `"${id}"`).join(", ")

  const queryResponse = await client.query({
    collection_name: collectionName,
    filter: `id in [${idsStr}]`,
    output_fields: ["id", "content", "vector", "*"],
  })

  return queryResponse.data.map((item: Record<string, unknown>) => ({
    id: item.id as string | number,
    content: (item.content as string) || "",
    metadata: Object.fromEntries(
      Object.entries(item).filter(([key]) => !["id", "content", "vector"].includes(key))
    ),
    embedding: item.vector as number[] | undefined,
  }))
}

/**
 * Query documents with filter expression
 */
export async function queryMilvusByFilter(
  client: MilvusClient,
  collectionName: string,
  filter: string,
  options: {
    outputFields?: string[]
    limit?: number
    offset?: number
  } = {}
): Promise<MilvusDocument[]> {
  const { outputFields = ["id", "content", "*"], limit, offset } = options

  const queryResponse = await client.query({
    collection_name: collectionName,
    filter,
    output_fields: outputFields,
    limit,
    offset,
  })

  return queryResponse.data.map((item: Record<string, unknown>) => ({
    id: item.id as string | number,
    content: (item.content as string) || "",
    metadata: Object.fromEntries(
      Object.entries(item).filter(([key]) => !["id", "content", "vector"].includes(key))
    ),
    embedding: item.vector as number[] | undefined,
  }))
}

/**
 * Count documents in a collection
 */
export async function countMilvusDocuments(
  client: MilvusClient,
  collectionName: string,
  filter?: string
): Promise<number> {
  const response = await client.query({
    collection_name: collectionName,
    filter: filter || "",
    output_fields: ["count(*)"],
  })

  return (response.data[0]?.["count(*)"] as number) || 0
}

/**
 * Create index on a field
 */
export async function createMilvusIndex(
  client: MilvusClient,
  collectionName: string,
  fieldName: string,
  options: {
    indexType?: string
    metricType?: "L2" | "IP" | "COSINE"
    params?: Record<string, unknown>
  } = {}
): Promise<void> {
  const {
    indexType = "HNSW",
    metricType = "COSINE",
    params = { M: 16, efConstruction: 256 },
  } = options

  await client.createIndex({
    collection_name: collectionName,
    field_name: fieldName,
    index_type: indexType,
    metric_type: metricType,
    params,
  })
}

/**
 * Drop index from a field
 */
export async function dropMilvusIndex(
  client: MilvusClient,
  collectionName: string,
  fieldName: string
): Promise<void> {
  await client.dropIndex({
    collection_name: collectionName,
    field_name: fieldName,
  })
}

/**
 * Load collection into memory for searching
 */
export async function loadMilvusCollection(
  client: MilvusClient,
  collectionName: string
): Promise<void> {
  await client.loadCollection({ collection_name: collectionName })
}

/**
 * Release collection from memory
 */
export async function releaseMilvusCollection(
  client: MilvusClient,
  collectionName: string
): Promise<void> {
  await client.releaseCollection({ collection_name: collectionName })
}

/**
 * Flush collection to persist data
 */
export async function flushMilvusCollection(
  client: MilvusClient,
  collectionName: string
): Promise<void> {
  await client.flush({ collection_names: [collectionName] })
}

/**
 * Get loading progress of a collection
 */
export async function getMilvusLoadingProgress(
  client: MilvusClient,
  collectionName: string
): Promise<number> {
  const response = await client.getLoadingProgress({
    collection_name: collectionName,
  })
  return Number(response.progress) || 0
}

/**
 * Compact collection (merge small segments)
 */
export async function compactMilvusCollection(
  client: MilvusClient,
  collectionName: string
): Promise<void> {
  await client.compact({ collection_name: collectionName })
}

/**
 * Create partition in a collection
 */
export async function createMilvusPartition(
  client: MilvusClient,
  collectionName: string,
  partitionName: string
): Promise<void> {
  await client.createPartition({
    collection_name: collectionName,
    partition_name: partitionName,
  })
}

/**
 * Drop partition from a collection
 */
export async function dropMilvusPartition(
  client: MilvusClient,
  collectionName: string,
  partitionName: string
): Promise<void> {
  await client.dropPartition({
    collection_name: collectionName,
    partition_name: partitionName,
  })
}

/**
 * List partitions in a collection
 */
export async function listMilvusPartitions(
  client: MilvusClient,
  collectionName: string
): Promise<string[]> {
  const response = await client.listPartitions({
    collection_name: collectionName,
  })
  return response.partition_names || []
}

/**
 * Hybrid search with multiple vectors (for reranking scenarios)
 */
export async function hybridSearchMilvus(
  client: MilvusClient,
  collectionName: string,
  queries: Array<{
    vector: number[]
    weight?: number
  }>,
  options: {
    topK?: number
    filter?: string
    outputFields?: string[]
    rerank?: "rrf" | "weighted"
    rankParams?: Record<string, unknown>
  } = {}
): Promise<MilvusSearchResult[]> {
  const {
    topK = 5,
    filter,
    outputFields = ["content", "*"],
    rerank = "rrf",
    rankParams = { k: 60 },
  } = options

  // For single query, use standard search
  if (queries.length === 1) {
    return searchMilvusByVector(client, collectionName, queries[0].vector, {
      topK,
      filter,
      outputFields,
    })
  }

  // For multiple queries, use hybrid search
  const searchRequests = queries.map((q) => ({
    data: [q.vector],
    anns_field: "vector",
    param: {},
    limit: topK,
  }))

  const response = await (client.hybridSearch as any)({
    collection_name: collectionName,
    search: searchRequests,
    rerank: {
      type: rerank === "rrf" ? "RRFRanker" : "WeightedRanker",
      params:
        rerank === "weighted"
          ? { weights: queries.map((q) => q.weight || 1 / queries.length) }
          : rankParams,
    },
    limit: topK,
    filter,
    output_fields: outputFields,
  })

  return response.results.map((result: Record<string, unknown>) => ({
    id: result.id as string | number,
    content: (result.content as string) || "",
    metadata: Object.fromEntries(
      Object.entries(result).filter(([key]) => !["id", "score", "vector"].includes(key))
    ),
    score: result.score as number,
  }))
}
