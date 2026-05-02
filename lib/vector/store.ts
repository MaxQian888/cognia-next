/**
 * Unified Vector Store Interface
 * Provides a consistent API across different vector database backends
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EmbeddingModelConfig } from "./embedding"
import { generateEmbedding, generateEmbeddings } from "./embedding"

export type VectorStoreProvider =
  | "chroma"
  | "pinecone"
  | "qdrant"
  | "milvus"
  | "native"
  | "weaviate"

export interface VectorDocument {
  id: string
  content: string
  metadata?: Record<string, unknown>
  embedding?: number[]
}

export interface VectorSearchResult {
  id: string
  content: string
  metadata?: Record<string, unknown>
  score: number
}

export interface VectorStoreConfig {
  provider: VectorStoreProvider
  embeddingConfig: EmbeddingModelConfig
  embeddingApiKey: string
  // Chroma-specific
  chromaMode?: "embedded" | "server"
  chromaServerUrl?: string
  // Pinecone-specific
  pineconeApiKey?: string
  pineconeIndexName?: string
  pineconeNamespace?: string
  // Weaviate-specific
  weaviateUrl?: string
  weaviateApiKey?: string
  // Qdrant-specific
  qdrantUrl?: string
  qdrantApiKey?: string
  qdrantCollectionName?: string
  // Milvus-specific
  milvusAddress?: string
  milvusToken?: string
  milvusUsername?: string
  milvusPassword?: string
  milvusSsl?: boolean
  milvusCollectionName?: string
  // Native (Tauri) local store
  native?: Record<string, never>
}

function sanitizePineconeMetadata(
  metadata?: Record<string, unknown>
): Record<string, string | number | boolean | string[]> | undefined {
  if (!metadata) return undefined

  const safe: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      safe[key] = value
    }
  }
  return safe
}

const PINECONE_DEFAULT_NAMESPACE = "__default__"

function getMetadataValue(metadata: Record<string, unknown> | undefined, key: string): unknown {
  if (!metadata) return undefined
  return metadata[key]
}

function comparePrimitive(left: unknown, right: unknown): number | null {
  if (typeof left === "number" && typeof right === "number") {
    return left - right
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right)
  }
  return null
}

function matchesUnifiedFilter(
  metadata: Record<string, unknown> | undefined,
  filter: PayloadFilter
): boolean {
  const payloadValue = getMetadataValue(metadata, filter.key)

  switch (filter.operation) {
    case "equals":
      return payloadValue === filter.value
    case "not_equals":
      return payloadValue !== filter.value
    case "contains": {
      if (typeof payloadValue === "string" && typeof filter.value === "string") {
        return payloadValue.includes(filter.value)
      }
      if (Array.isArray(payloadValue)) {
        return payloadValue.includes(filter.value)
      }
      return false
    }
    case "not_contains": {
      if (typeof payloadValue === "string" && typeof filter.value === "string") {
        return !payloadValue.includes(filter.value)
      }
      if (Array.isArray(payloadValue)) {
        return !payloadValue.includes(filter.value)
      }
      return true
    }
    case "greater_than": {
      const cmp = comparePrimitive(payloadValue, filter.value)
      return cmp !== null && cmp > 0
    }
    case "greater_than_or_equals": {
      const cmp = comparePrimitive(payloadValue, filter.value)
      return cmp !== null && cmp >= 0
    }
    case "less_than": {
      const cmp = comparePrimitive(payloadValue, filter.value)
      return cmp !== null && cmp < 0
    }
    case "less_than_or_equals": {
      const cmp = comparePrimitive(payloadValue, filter.value)
      return cmp !== null && cmp <= 0
    }
    case "is_null":
      return payloadValue === null || payloadValue === undefined
    case "is_not_null":
      return payloadValue !== null && payloadValue !== undefined
    case "starts_with":
      return typeof payloadValue === "string" && typeof filter.value === "string"
        ? payloadValue.startsWith(filter.value)
        : false
    case "ends_with":
      return typeof payloadValue === "string" && typeof filter.value === "string"
        ? payloadValue.endsWith(filter.value)
        : false
    case "in":
      return Array.isArray(filter.value) ? filter.value.includes(payloadValue) : false
    case "not_in":
      return Array.isArray(filter.value) ? !filter.value.includes(payloadValue) : false
    default:
      return true
  }
}

function applyUnifiedPostFilters<T extends { metadata?: Record<string, unknown> }>(
  results: T[],
  filters?: PayloadFilter[],
  filterMode: "and" | "or" = "and"
): T[] {
  if (!filters || filters.length === 0) return results

  return results.filter((result) => {
    const matches = filters.map((filter) => matchesUnifiedFilter(result.metadata, filter))
    return filterMode === "or" ? matches.some(Boolean) : matches.every(Boolean)
  })
}

function applyThresholdAndPagination(
  results: VectorSearchResult[],
  options: SearchOptions = {}
): SearchResponse {
  const thresholdFiltered =
    options.threshold === undefined
      ? results
      : results.filter((result) => result.score >= options.threshold!)
  const offset = options.offset ?? 0
  const limit = options.limit ?? options.topK ?? 5
  const paginated = thresholdFiltered.slice(offset, offset + limit)

  return {
    results: paginated,
    total: thresholdFiltered.length,
    offset,
    limit,
  }
}

function toPineconeClause(filter: PayloadFilter): Record<string, unknown> | null {
  const key = filter.key

  switch (filter.operation) {
    case "equals":
      return { [key]: { $eq: filter.value } }
    case "not_equals":
      return { [key]: { $ne: filter.value } }
    case "greater_than":
      return { [key]: { $gt: filter.value } }
    case "greater_than_or_equals":
      return { [key]: { $gte: filter.value } }
    case "less_than":
      return { [key]: { $lt: filter.value } }
    case "less_than_or_equals":
      return { [key]: { $lte: filter.value } }
    case "in":
      return Array.isArray(filter.value) ? { [key]: { $in: filter.value } } : null
    case "not_in":
      return Array.isArray(filter.value) ? { [key]: { $nin: filter.value } } : null
    case "is_null":
      return { [key]: { $exists: false } }
    case "is_not_null":
      return { [key]: { $exists: true } }
    default:
      return null
  }
}

function buildPineconeFilterFromUnified(
  filters?: PayloadFilter[],
  filterMode: "and" | "or" = "and"
): { filter?: Record<string, unknown>; requiresPostFilter: boolean } {
  if (!filters || filters.length === 0) {
    return { filter: undefined, requiresPostFilter: false }
  }

  const clauses: Record<string, unknown>[] = []
  let requiresPostFilter = false
  for (const filter of filters) {
    const clause = toPineconeClause(filter)
    if (clause) {
      clauses.push(clause)
    } else {
      requiresPostFilter = true
    }
  }

  if (clauses.length === 0) {
    return { filter: undefined, requiresPostFilter: true }
  }

  return {
    filter:
      clauses.length === 1
        ? clauses[0]
        : filterMode === "or"
          ? { $or: clauses }
          : { $and: clauses },
    requiresPostFilter,
  }
}

function toQdrantConditions(
  filters?: PayloadFilter[],
  mode: "and" | "or" = "and"
): { filter?: Record<string, unknown>; requiresPostFilter: boolean } {
  if (!filters || filters.length === 0) {
    return { filter: undefined, requiresPostFilter: false }
  }

  const must: Record<string, unknown>[] = []
  const should: Record<string, unknown>[] = []
  const mustNot: Record<string, unknown>[] = []
  let requiresPostFilter = false

  for (const filter of filters) {
    const target = mode === "or" ? should : must

    switch (filter.operation) {
      case "equals":
        target.push({ key: filter.key, match: { value: filter.value } })
        break
      case "not_equals":
        mustNot.push({ key: filter.key, match: { value: filter.value } })
        break
      case "greater_than":
        target.push({ key: filter.key, range: { gt: filter.value } })
        break
      case "greater_than_or_equals":
        target.push({ key: filter.key, range: { gte: filter.value } })
        break
      case "less_than":
        target.push({ key: filter.key, range: { lt: filter.value } })
        break
      case "less_than_or_equals":
        target.push({ key: filter.key, range: { lte: filter.value } })
        break
      case "in":
        if (Array.isArray(filter.value)) {
          target.push({ key: filter.key, match: { any: filter.value } })
        } else {
          requiresPostFilter = true
        }
        break
      case "not_in":
        if (Array.isArray(filter.value)) {
          mustNot.push({ key: filter.key, match: { any: filter.value } })
        } else {
          requiresPostFilter = true
        }
        break
      case "is_null":
        target.push({ is_null: { key: filter.key } })
        break
      case "is_not_null":
        mustNot.push({ is_null: { key: filter.key } })
        break
      default:
        requiresPostFilter = true
        break
    }
  }

  const builtFilter: Record<string, unknown> = {}
  if (must.length > 0) builtFilter.must = must
  if (should.length > 0) builtFilter.should = should
  if (mustNot.length > 0) builtFilter.must_not = mustNot

  return {
    filter: Object.keys(builtFilter).length > 0 ? builtFilter : undefined,
    requiresPostFilter,
  }
}

function toMilvusLiteral(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (typeof value === "string") {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  throw new Error("Milvus filter value must be a string, number, or boolean")
}

function buildMilvusFilterFromUnified(
  filters?: PayloadFilter[],
  filterMode: "and" | "or" = "and"
): string | undefined {
  if (!filters || filters.length === 0) return undefined

  const clauses = filters.map((filter) => {
    const field = filter.key
    switch (filter.operation) {
      case "equals":
        return `${field} == ${toMilvusLiteral(filter.value)}`
      case "not_equals":
        return `${field} != ${toMilvusLiteral(filter.value)}`
      case "greater_than":
        return `${field} > ${toMilvusLiteral(filter.value)}`
      case "greater_than_or_equals":
        return `${field} >= ${toMilvusLiteral(filter.value)}`
      case "less_than":
        return `${field} < ${toMilvusLiteral(filter.value)}`
      case "less_than_or_equals":
        return `${field} <= ${toMilvusLiteral(filter.value)}`
      case "in":
        if (!Array.isArray(filter.value)) {
          throw new Error(`Milvus filter 'in' requires array value for key ${field}`)
        }
        return `${field} in [${filter.value.map((v) => toMilvusLiteral(v)).join(", ")}]`
      case "not_in":
        if (!Array.isArray(filter.value)) {
          throw new Error(`Milvus filter 'not_in' requires array value for key ${field}`)
        }
        return `${field} not in [${filter.value.map((v) => toMilvusLiteral(v)).join(", ")}]`
      case "contains":
        if (typeof filter.value !== "string") {
          throw new Error(`Milvus filter 'contains' requires string value for key ${field}`)
        }
        return `${field} like "%${filter.value.replace(/"/g, '\\"')}%"`
      case "not_contains":
        if (typeof filter.value !== "string") {
          throw new Error(`Milvus filter 'not_contains' requires string value for key ${field}`)
        }
        return `not (${field} like "%${filter.value.replace(/"/g, '\\"')}%")`
      case "starts_with":
        if (typeof filter.value !== "string") {
          throw new Error(`Milvus filter 'starts_with' requires string value for key ${field}`)
        }
        return `${field} like "${filter.value.replace(/"/g, '\\"')}%"`
      case "ends_with":
        if (typeof filter.value !== "string") {
          throw new Error(`Milvus filter 'ends_with' requires string value for key ${field}`)
        }
        return `${field} like "%${filter.value.replace(/"/g, '\\"')}"`
      default:
        throw new Error(`Milvus filter operation '${filter.operation}' is not supported`)
    }
  })

  const joiner = filterMode === "or" ? " or " : " and "
  return clauses.length > 1 ? `(${clauses.join(joiner)})` : clauses[0]
}

export interface VectorCollectionInfo {
  name: string
  documentCount: number
  dimension?: number
  metadata?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
  description?: string
  embeddingModel?: string
  embeddingProvider?: string
}

export interface CollectionExport {
  meta: VectorCollectionInfo
  points: Array<{
    id: string
    vector: number[]
    payload?: Record<string, unknown>
  }>
}

export interface CollectionImport {
  meta: VectorCollectionInfo
  points: Array<{
    id: string
    vector: number[]
    payload?: Record<string, unknown>
  }>
}

export type FilterOperation =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_than_or_equals"
  | "less_than"
  | "less_than_or_equals"
  | "is_null"
  | "is_not_null"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"

export interface PayloadFilter {
  key: string
  value: unknown
  operation: FilterOperation
}

export interface SearchOptions {
  /**
   * Native provider filter payload (passthrough).
   * This shape is backend-specific (e.g. Qdrant/Pinecone/Weaviate native DSL).
   */
  topK?: number
  threshold?: number
  filter?: Record<string, unknown>
  offset?: number
  limit?: number
  /**
   * Unified filter DSL that is mapped to provider-native filters when possible.
   * Unsupported operations are applied via client-side post filtering.
   */
  filters?: PayloadFilter[]
  filterMode?: "and" | "or"
}

export interface SearchResponse {
  results: VectorSearchResult[]
  total: number
  offset: number
  limit: number
}

export interface ScrollOptions {
  offset?: number
  limit?: number
  filter?: Record<string, unknown>
  filters?: PayloadFilter[]
  filterMode?: "and" | "or"
}

export interface ScrollResponse {
  documents: VectorDocument[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface VectorStats {
  collectionCount: number
  totalPoints: number
  storagePath: string
  storageSizeBytes: number
}

/**
 * Abstract Vector Store interface
 */
export interface IVectorStore {
  readonly provider: VectorStoreProvider

  addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void>

  updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void>

  deleteDocuments(collectionName: string, ids: string[]): Promise<void>

  deleteAllDocuments?(collectionName: string): Promise<number>

  searchDocuments(
    collectionName: string,
    query: string,
    options?: SearchOptions
  ): Promise<VectorSearchResult[]>

  searchByEmbedding?(
    collectionName: string,
    embedding: number[],
    options?: SearchOptions
  ): Promise<VectorSearchResult[]>

  searchDocumentsWithTotal?(
    collectionName: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResponse>

  scrollDocuments?(collectionName: string, options?: ScrollOptions): Promise<ScrollResponse>

  getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]>

  createCollection(
    name: string,
    options?: {
      dimension?: number
      metadata?: Record<string, unknown>
      description?: string
      embeddingModel?: string
      embeddingProvider?: string
    }
  ): Promise<void>

  deleteCollection(name: string): Promise<void>

  renameCollection?(oldName: string, newName: string): Promise<void>

  truncateCollection?(name: string): Promise<void>

  exportCollection?(name: string): Promise<CollectionExport>

  importCollection?(data: CollectionImport, overwrite?: boolean): Promise<void>

  listCollections(): Promise<VectorCollectionInfo[]>

  getCollectionInfo(name: string): Promise<VectorCollectionInfo>

  countDocuments?(
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number>

  getStats?(): Promise<VectorStats>
}

/**
 * Native (Tauri) Vector Store implementation
 * Backed by local JSON persistence via Tauri commands.
 */
export class NativeVectorStore implements IVectorStore {
  readonly provider: VectorStoreProvider = "native"
  private config: VectorStoreConfig

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  private isInTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  }

  private async invoke<T>(cmd: string, payload?: Record<string, unknown>): Promise<T> {
    if (!this.isInTauri()) {
      throw new Error("Native vector store is only available in Tauri environment")
    }
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>(cmd, payload as any)
  }

  private async ensureEmbeddings(documents: VectorDocument[]): Promise<number[][]> {
    const needsEmbedding = documents.some((doc) => !doc.embedding)
    if (!needsEmbedding) {
      return documents.map((d) => d.embedding!) as number[][]
    }
    const texts = documents.filter((d) => !d.embedding).map((d) => d.content)
    const result = await generateEmbeddings(
      texts,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    let idx = 0
    return documents.map((d) => (d.embedding ? d.embedding : result.embeddings[idx++]))
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const embeddings = await this.ensureEmbeddings(documents)
    await this.invoke("vector_upsert_points", {
      collection: collectionName,
      points: documents.map((doc, i) => ({
        id: doc.id,
        vector: embeddings[i],
        payload: { content: doc.content, ...doc.metadata },
      })),
    })
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    // Upsert semantics
    await this.addDocuments(collectionName, documents)
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    await this.invoke("vector_delete_points", { collection: collectionName, ids })
  }

  async deleteAllDocuments(collectionName: string): Promise<number> {
    return await this.invoke<number>("vector_delete_all_points", { collection: collectionName })
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    if (!this.isInTauri()) {
      throw new Error("Native vector store is only available in Tauri environment")
    }
    const queryEmbedding = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, queryEmbedding.embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const response = await this.searchByEmbeddingWithTotal(collectionName, embedding, options)
    return response.results
  }

  private async searchByEmbeddingWithTotal(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const { topK = 5, threshold, offset, limit, filters, filterMode } = options

    const searchPayload = {
      collection: collectionName,
      vector: embedding,
      top_k: topK,
      score_threshold: threshold,
      offset,
      limit,
      filters: filters?.map((f) => ({
        key: f.key,
        value: f.value,
        operation: f.operation,
      })),
      filter_mode: filterMode,
    }

    const response = await this.invoke<
      | { id: string; score: number; payload?: Record<string, unknown> }[]
      | {
          results: {
            id: string
            score: number
            payload?: Record<string, unknown>
            content?: string
          }[]
          total: number
          offset: number
          limit: number
        }
      | null
    >("vector_search_points", searchPayload)

    if (!response) {
      return { results: [], total: 0, offset: 0, limit: 0 }
    }

    if (Array.isArray(response)) {
      const mapped = response.map((r) => ({
        id: r.id,
        content: (r.payload?.content as string) || "",
        metadata: r.payload,
        score: r.score,
      }))
      const paged = applyThresholdAndPagination(mapped, options)
      return paged
    }

    return {
      results: (response.results || []).map((r) => ({
        id: r.id,
        content: r.content || (r.payload?.content as string) || "",
        metadata: r.payload,
        score: r.score,
      })),
      total: response.total ?? 0,
      offset: response.offset ?? 0,
      limit: response.limit ?? 0,
    }
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    if (!this.isInTauri()) {
      throw new Error("Native vector store is only available in Tauri environment")
    }
    const queryEmbedding = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbeddingWithTotal(collectionName, queryEmbedding.embedding, options)
  }

  async scrollDocuments(
    _collectionName: string,
    _options: ScrollOptions = {}
  ): Promise<ScrollResponse> {
    throw new Error("scrollDocuments is not yet supported on the native backend")
  }

  async getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]> {
    const results = await this.invoke<
      { id: string; vector: number[]; payload?: Record<string, unknown> }[]
    >("vector_get_points", { collection: collectionName, ids })
    return (results || []).map((p) => ({
      id: p.id,
      content: (p.payload?.content as string) || "",
      metadata: p.payload,
      embedding: p.vector,
    }))
  }

  async createCollection(
    name: string,
    options?: {
      dimension?: number
      metadata?: Record<string, unknown>
      description?: string
      embeddingModel?: string
      embeddingProvider?: string
    }
  ): Promise<void> {
    const dimension = options?.dimension || this.config.embeddingConfig.dimensions || 1536
    await this.invoke("vector_create_collection", {
      name,
      dimension,
      metadata: options?.metadata,
      description: options?.description,
      embedding_model: options?.embeddingModel || this.config.embeddingConfig.model,
      embedding_provider: options?.embeddingProvider || this.config.embeddingConfig.provider,
    })
  }

  async deleteCollection(name: string): Promise<void> {
    await this.invoke("vector_delete_collection", { name })
  }

  async renameCollection(_oldName: string, _newName: string): Promise<void> {
    throw new Error("renameCollection is not yet supported on the native backend")
  }

  async truncateCollection(name: string): Promise<void> {
    await this.invoke("vector_truncate_collection", { name })
  }

  async exportCollection(_name: string): Promise<CollectionExport> {
    throw new Error("exportCollection is not yet supported on the native backend")
  }

  async importCollection(_data: CollectionImport, _overwrite?: boolean): Promise<void> {
    throw new Error("importCollection is not yet supported on the native backend")
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const list = await this.invoke<
      {
        name: string
        dimension: number
        metadata?: Record<string, unknown>
        document_count?: number
        created_at?: string
        updated_at?: string
        description?: string
        embedding_model?: string
        embedding_provider?: string
      }[]
    >("vector_list_collections")
    const parseTimestamp = (s: string | undefined): number | undefined =>
      s ? Date.parse(s) || undefined : undefined
    return (list || []).map((c) => ({
      name: c.name,
      documentCount: c.document_count ?? 0,
      dimension: c.dimension,
      metadata: c.metadata,
      createdAt: parseTimestamp(c.created_at),
      updatedAt: parseTimestamp(c.updated_at),
      description: c.description,
      embeddingModel: c.embedding_model,
      embeddingProvider: c.embedding_provider,
    }))
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const info = await this.invoke<{
      name: string
      dimension: number
      metadata?: Record<string, unknown>
      document_count?: number
      created_at?: string
      updated_at?: string
      description?: string
      embedding_model?: string
      embedding_provider?: string
    }>("vector_get_collection", { name })
    const parseTimestamp = (s: string | undefined): number | undefined =>
      s ? Date.parse(s) || undefined : undefined
    return {
      name: info.name,
      documentCount: info.document_count ?? 0,
      dimension: info.dimension,
      metadata: info.metadata,
      createdAt: parseTimestamp(info.created_at),
      updatedAt: parseTimestamp(info.updated_at),
      description: info.description,
      embeddingModel: info.embedding_model,
      embeddingProvider: info.embedding_provider,
    }
  }

  async countDocuments(
    _collectionName: string,
    _options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    // TODO(commit-3+): implement via vector_search_points with top_k=1 reading the total field
    throw new Error("countDocuments is not yet supported on the native backend")
  }

  async getStats(): Promise<VectorStats> {
    throw new Error("getStats is not yet supported on the native backend")
  }
}

/**
 * Chroma Vector Store implementation
 */
export class ChromaVectorStore implements IVectorStore {
  readonly provider: VectorStoreProvider = "chroma"
  private config: VectorStoreConfig
  private chromaClient: import("chromadb").ChromaClient | null = null

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  private async getClient(): Promise<import("chromadb").ChromaClient> {
    if (!this.chromaClient) {
      const { ChromaClient } = await import("chromadb")
      if (this.config.chromaMode === "server" && this.config.chromaServerUrl) {
        this.chromaClient = new ChromaClient({ path: this.config.chromaServerUrl })
      } else {
        this.chromaClient = new ChromaClient()
      }
    }
    return this.chromaClient
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const client = await this.getClient()
    const collection = await client.getOrCreateCollection({ name: collectionName })

    const { generateEmbeddings } = await import("./embedding")

    const ids = documents.map((doc) => doc.id)
    const contents = documents.map((doc) => doc.content)
    const metadatas = documents.map((doc) => doc.metadata || {})

    const needsEmbedding = documents.some((doc) => !doc.embedding)
    let embeddings: number[][] | undefined

    if (needsEmbedding) {
      const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)
      if (textsToEmbed.length > 0) {
        const result = await generateEmbeddings(
          textsToEmbed,
          this.config.embeddingConfig,
          this.config.embeddingApiKey
        )
        let embeddingIndex = 0
        embeddings = documents.map((doc) => {
          if (doc.embedding) return doc.embedding
          return result.embeddings[embeddingIndex++]
        })
      }
    } else {
      embeddings = documents.map((doc) => doc.embedding!)
    }

    await collection.add({
      ids,
      documents: contents,
      metadatas: metadatas as import("chromadb").Metadata[],
      embeddings,
    })
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const client = await this.getClient()
    const collection = await client.getCollection({ name: collectionName })

    const { generateEmbeddings } = await import("./embedding")

    const ids = documents.map((doc) => doc.id)
    const contents = documents.map((doc) => doc.content)
    const metadatas = documents.map((doc) => doc.metadata || {})

    const result = await generateEmbeddings(
      contents,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )

    await collection.update({
      ids,
      documents: contents,
      metadatas: metadatas as import("chromadb").Metadata[],
      embeddings: result.embeddings,
    })
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    const client = await this.getClient()
    const collection = await client.getCollection({ name: collectionName })
    await collection.delete({ ids })
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, queryResult.embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const client = await this.getClient()
    const collection = await client.getCollection({ name: collectionName })
    const { topK = 5 } = options
    const nativeWhere = options.filter as import("chromadb").Where | undefined

    const results = await collection.query({
      queryEmbeddings: [embedding],
      nResults: topK,
      where: nativeWhere,
      include: ["documents", "metadatas", "distances"],
    })

    const searchResults: VectorSearchResult[] = []
    const resultIds = results.ids[0] || []
    const resultDocs = results.documents?.[0] || []
    const resultMeta = results.metadatas?.[0] || []
    const resultDist = results.distances?.[0] || []

    for (let i = 0; i < resultIds.length; i++) {
      const distance = resultDist[i] || 0
      searchResults.push({
        id: resultIds[i],
        content: resultDocs[i] || "",
        metadata: resultMeta[i] as Record<string, unknown> | undefined,
        score: 1 - distance,
      })
    }

    const postFiltered = applyUnifiedPostFilters(searchResults, options.filters, options.filterMode)
    return applyThresholdAndPagination(postFiltered, options).results
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    const resultSet = await this.searchByEmbedding(collectionName, queryResult.embedding, {
      ...options,
      offset: 0,
      limit: Math.max(
        (options.offset ?? 0) + (options.limit ?? options.topK ?? 5),
        options.topK ?? 5
      ),
    })
    const response = applyThresholdAndPagination(resultSet, options)
    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => response.total)
    return { ...response, total }
  }

  async getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]> {
    const client = await this.getClient()
    const collection = await client.getCollection({ name: collectionName })
    const results = await collection.get({ ids, include: ["documents", "metadatas", "embeddings"] })

    return results.ids.map((id, i) => ({
      id,
      content: results.documents?.[i] || "",
      metadata: results.metadatas?.[i] as Record<string, unknown> | undefined,
      embedding: results.embeddings?.[i] as number[] | undefined,
    }))
  }

  async createCollection(
    name: string,
    options?: { dimension?: number; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const client = await this.getClient()
    await client.getOrCreateCollection({
      name,
      metadata: options?.metadata as import("chromadb").CollectionMetadata,
    })
  }

  async deleteCollection(name: string): Promise<void> {
    const client = await this.getClient()
    await client.deleteCollection({ name })
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const client = await this.getClient()
    const collections = await client.listCollections()
    const infos: VectorCollectionInfo[] = []

    for (const collectionItem of collections as unknown as Array<{ name?: string } | string>) {
      const collectionName =
        typeof collectionItem === "string" ? collectionItem : (collectionItem?.name ?? "")
      if (!collectionName) continue
      try {
        const collection = await client.getCollection({ name: collectionName })
        const count = await collection.count()
        infos.push({ name: collectionName, documentCount: count })
      } catch {
        infos.push({ name: collectionName, documentCount: 0 })
      }
    }

    return infos
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const client = await this.getClient()
    const collection = await client.getCollection({ name })
    const count = await collection.count()
    return { name, documentCount: count }
  }

  async countDocuments(
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    const client = await this.getClient()
    const collection = await client.getCollection({ name: collectionName })
    if (!options?.filter && (!options?.filters || options.filters.length === 0)) {
      return collection.count()
    }

    const rows = await collection.get({
      where: options?.filter as import("chromadb").Where | undefined,
      include: ["metadatas"],
    })
    const docs: Array<{ metadata?: Record<string, unknown> }> = rows.ids.map((_, index) => ({
      metadata: rows.metadatas?.[index] as Record<string, unknown> | undefined,
    }))
    return applyUnifiedPostFilters(docs, options?.filters, options?.filterMode).length
  }
}

/**
 * Pinecone Vector Store implementation
 */
export class PineconeVectorStore implements IVectorStore {
  readonly provider: VectorStoreProvider = "pinecone"
  private config: VectorStoreConfig
  private index:
    | import("@pinecone-database/pinecone").Index<
        import("@pinecone-database/pinecone").RecordMetadata
      >
    | null = null

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  private assertServer(): void {
    if (typeof window !== "undefined") {
      throw new Error("Pinecone vector store is only available in server environments")
    }
  }

  private resolveNamespace(collectionName?: string): string {
    const namespace = this.config.pineconeNamespace ?? collectionName
    if (!namespace || !namespace.trim()) {
      return PINECONE_DEFAULT_NAMESPACE
    }
    return namespace
  }

  private getPineconeConfig(collectionName?: string) {
    return {
      apiKey: this.config.pineconeApiKey!,
      indexName: this.config.pineconeIndexName!,
      namespace: this.resolveNamespace(collectionName),
      embeddingConfig: this.config.embeddingConfig,
      embeddingApiKey: this.config.embeddingApiKey,
    }
  }

  private async getIndex(): Promise<
    import("@pinecone-database/pinecone").Index<
      import("@pinecone-database/pinecone").RecordMetadata
    >
  > {
    this.assertServer()
    if (!this.index) {
      const { getPineconeClient, getPineconeIndex } = await import("./pinecone-client")
      const client = getPineconeClient(this.config.pineconeApiKey!)
      this.index = getPineconeIndex(client, this.config.pineconeIndexName!)
    }
    return this.index
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const index = await this.getIndex()
    const { upsertDocuments } = await import("./pinecone-client")
    const mappedDocs = documents.map((doc) => ({
      id: doc.id,
      content: doc.content,
      metadata: sanitizePineconeMetadata(doc.metadata),
      embedding: doc.embedding,
    }))
    await upsertDocuments(index, mappedDocs, this.getPineconeConfig(collectionName))
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    await this.addDocuments(collectionName, documents)
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    const index = await this.getIndex()
    const { deleteDocuments } = await import("./pinecone-client")
    await deleteDocuments(index, ids, this.getPineconeConfig(collectionName).namespace)
  }

  async deleteAllDocuments(collectionName: string): Promise<number> {
    const index = await this.getIndex()
    const { deleteAllDocuments, getIndexStats } = await import("./pinecone-client")
    const stats = await getIndexStats(index)
    const namespace = this.resolveNamespace(collectionName)
    const before = stats.namespaces?.[namespace]?.vectorCount ?? 0
    await deleteAllDocuments(index, namespace)
    return before
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, queryResult.embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const index = await this.getIndex()
    const namespace = this.resolveNamespace(collectionName)
    const ns = namespace ? index.namespace(namespace) : index
    const { topK = 5 } = options

    const { filter: mappedFilter, requiresPostFilter } = buildPineconeFilterFromUnified(
      options.filters,
      options.filterMode
    )
    const nativeFilter = options.filter
    const effectiveFilter = nativeFilter ?? mappedFilter

    const response = await ns.query({
      vector: embedding,
      topK,
      filter: effectiveFilter,
      includeMetadata: true,
    })

    const mapped = (response.matches || []).map((match) => ({
      id: match.id,
      content: (match.metadata?.content as string) || "",
      metadata: match.metadata as Record<string, unknown> | undefined,
      score: match.score || 0,
    }))

    const postFiltered =
      !nativeFilter && requiresPostFilter
        ? applyUnifiedPostFilters(mapped, options.filters, options.filterMode)
        : mapped

    return applyThresholdAndPagination(postFiltered, options).results
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    const requested = Math.max(
      (options.offset ?? 0) + (options.limit ?? options.topK ?? 5),
      options.topK ?? 5
    )
    const results = await this.searchByEmbedding(collectionName, queryResult.embedding, {
      ...options,
      topK: requested,
      offset: 0,
      limit: requested,
    })
    const paged = applyThresholdAndPagination(results, options)
    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => paged.total)
    return { ...paged, total }
  }

  async getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]> {
    const index = await this.getIndex()
    const { fetchDocuments } = await import("./pinecone-client")
    return fetchDocuments(index, ids, this.getPineconeConfig(collectionName).namespace)
  }

  async createCollection(
    name: string,
    options?: { dimension?: number; metadata?: Record<string, unknown>; description?: string }
  ): Promise<void> {
    const { createPineconeIndex } = await import("./pinecone-client")
    const dimension = options?.dimension || this.config.embeddingConfig.dimensions || 1536
    const client = (await import("./pinecone-client")).getPineconeClient(
      this.config.pineconeApiKey!
    )

    await createPineconeIndex(client, this.config.pineconeIndexName!, dimension, {
      suppressConflicts: true,
      tags: options?.metadata as Record<string, string> | undefined,
    })

    // Pinecone collections are namespaces, no explicit creation needed.
    void name
  }

  async deleteCollection(name: string): Promise<void> {
    const index = await this.getIndex()
    const { deleteAllDocuments } = await import("./pinecone-client")
    await deleteAllDocuments(index, this.getPineconeConfig(name).namespace)
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const index = await this.getIndex()
    const { getIndexStats } = await import("./pinecone-client")
    const stats = await getIndexStats(index)
    return Object.entries(stats.namespaces || {}).map(([name, info]) => ({
      name,
      documentCount: info.vectorCount,
      dimension: stats.dimension,
    }))
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const index = await this.getIndex()
    const { describePineconeIndex, getIndexStats } = await import("./pinecone-client")
    const info = await describePineconeIndex(
      (await import("./pinecone-client")).getPineconeClient(this.config.pineconeApiKey!),
      this.config.pineconeIndexName!
    )
    const stats = await getIndexStats(index)
    const namespace = this.resolveNamespace(name)
    return {
      name: namespace,
      documentCount: stats.namespaces?.[namespace]?.vectorCount ?? 0,
      dimension: info.dimension,
    }
  }

  async countDocuments(
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    const index = await this.getIndex()
    const { getIndexStats } = await import("./pinecone-client")
    if (!options?.filter && (!options?.filters || options.filters.length === 0)) {
      const stats = await getIndexStats(index)
      const namespace = this.resolveNamespace(collectionName)
      return stats.namespaces?.[namespace]?.vectorCount ?? 0
    }

    const probeVector = new Array(this.config.embeddingConfig.dimensions || 1536).fill(0)
    const results = await this.searchByEmbedding(collectionName, probeVector, {
      topK: 10000,
      filter: options?.filter,
      filters: options?.filters,
      filterMode: options?.filterMode,
    })
    return results.length
  }
}

/**
 * Weaviate Vector Store implementation
 */
export class WeaviateVectorStore implements IVectorStore {
  readonly provider: VectorStoreProvider = "weaviate"
  private config: VectorStoreConfig

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  private getWeaviateConfig(collectionName?: string) {
    return {
      url: this.config.weaviateUrl!,
      apiKey: this.config.weaviateApiKey,
      className: collectionName,
      embeddingConfig: this.config.embeddingConfig,
      embeddingApiKey: this.config.embeddingApiKey,
    }
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const { upsertWeaviateDocuments } = await import("./weaviate-client")
    await upsertWeaviateDocuments(this.getWeaviateConfig(collectionName), documents)
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    await this.addDocuments(collectionName, documents)
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    const { deleteWeaviateDocuments } = await import("./weaviate-client")
    await deleteWeaviateDocuments(this.getWeaviateConfig(collectionName), ids)
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const queryEmbedding = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, queryEmbedding.embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const { queryWeaviate } = await import("./weaviate-client")
    const mapped = await queryWeaviate(this.getWeaviateConfig(collectionName), "", {
      ...options,
      embedding,
    })
    const postFiltered = applyUnifiedPostFilters(mapped, options.filters, options.filterMode)
    return applyThresholdAndPagination(postFiltered, options).results
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const queryEmbedding = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    const requested = Math.max(
      (options.offset ?? 0) + (options.limit ?? options.topK ?? 5),
      options.topK ?? 5
    )
    const rows = await this.searchByEmbedding(collectionName, queryEmbedding.embedding, {
      ...options,
      topK: requested,
      offset: 0,
      limit: requested,
    })
    const paged = applyThresholdAndPagination(rows, options)
    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => paged.total)
    return { ...paged, total }
  }

  async getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]> {
    const { getWeaviateDocuments } = await import("./weaviate-client")
    return getWeaviateDocuments(this.getWeaviateConfig(collectionName), ids)
  }

  async createCollection(
    name: string,
    options?: { dimension?: number; metadata?: Record<string, unknown>; description?: string }
  ): Promise<void> {
    const { createWeaviateClass } = await import("./weaviate-client")
    await createWeaviateClass(this.getWeaviateConfig(name), {
      description: options?.description,
      metadata: options?.metadata,
      dimension: options?.dimension || this.config.embeddingConfig.dimensions,
    })
  }

  async deleteCollection(name: string): Promise<void> {
    const { deleteWeaviateClass } = await import("./weaviate-client")
    await deleteWeaviateClass(this.getWeaviateConfig(name))
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const { listWeaviateClasses } = await import("./weaviate-client")
    return listWeaviateClasses(this.getWeaviateConfig()).then(
      (classes: Array<{ name: string; description?: string; documentCount?: number }>) =>
        classes.map((cls) => ({
          name: cls.name,
          documentCount: cls.documentCount ?? 0,
          description: cls.description,
        }))
    )
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const { getWeaviateClassInfo } = await import("./weaviate-client")
    const info = await getWeaviateClassInfo(this.getWeaviateConfig(name))
    return { ...info, documentCount: info.documentCount ?? 0 }
  }

  async scrollDocuments(
    collectionName: string,
    options: ScrollOptions = {}
  ): Promise<ScrollResponse> {
    const { scrollWeaviateDocuments, countWeaviateDocuments } = await import("./weaviate-client")
    const offset = options.offset ?? 0
    const limit = options.limit ?? 100
    const documents = await scrollWeaviateDocuments(this.getWeaviateConfig(collectionName), {
      offset,
      limit,
      filter: options.filter as Record<string, unknown> | undefined,
    })
    const postFiltered = applyUnifiedPostFilters(documents, options.filters, options.filterMode)
    const pagedDocs = postFiltered.slice(0, limit)
    const total = options.filters?.length
      ? postFiltered.length
      : await countWeaviateDocuments(this.getWeaviateConfig(collectionName))
    return {
      documents: pagedDocs,
      total,
      offset,
      limit,
      hasMore: offset + pagedDocs.length < total,
    }
  }

  async countDocuments(
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    const { countWeaviateDocuments, scrollWeaviateDocuments } = await import("./weaviate-client")
    if (!options?.filters || options.filters.length === 0) {
      return countWeaviateDocuments(this.getWeaviateConfig(collectionName))
    }

    const docs = await scrollWeaviateDocuments(this.getWeaviateConfig(collectionName), {
      offset: 0,
      limit: 10000,
      filter: options.filter,
    })
    return applyUnifiedPostFilters(docs, options.filters, options.filterMode).length
  }
}

/**
 * Qdrant Vector Store implementation
 */
export class QdrantVectorStore implements IVectorStore {
  readonly provider: VectorStoreProvider = "qdrant"
  private config: VectorStoreConfig
  private qdrantClient: import("@qdrant/js-client-rest").QdrantClient | null = null

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  private async getClient(): Promise<import("@qdrant/js-client-rest").QdrantClient> {
    if (!this.qdrantClient) {
      const { QdrantClient } = await import("@qdrant/js-client-rest")
      this.qdrantClient = new QdrantClient({
        url: this.config.qdrantUrl!,
        apiKey: this.config.qdrantApiKey,
      })
    }
    return this.qdrantClient
  }

  private buildQdrantFilter(options: {
    filter?: Record<string, unknown>
    filters?: PayloadFilter[]
    filterMode?: "and" | "or"
  }): { filter?: Record<string, unknown>; requiresPostFilter: boolean } {
    if (options.filter) {
      return {
        filter: options.filter,
        requiresPostFilter: Boolean(options.filters && options.filters.length > 0),
      }
    }
    return toQdrantConditions(options.filters, options.filterMode)
  }

  private async queryByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const client = await this.getClient()
    const { topK = 5, threshold } = options
    const { filter, requiresPostFilter } = this.buildQdrantFilter(options)

    let rows: Array<{ id: string | number; payload?: Record<string, unknown>; score: number }> = []
    try {
      const response = await client.query(collectionName, {
        query: embedding,
        limit: topK,
        offset: options.offset,
        score_threshold: threshold,
        filter,
        with_payload: true,
        with_vector: false,
      } as any)
      rows =
        (
          response as {
            points?: Array<{
              id: string | number
              payload?: Record<string, unknown>
              score: number
            }>
          }
        ).points || []
    } catch {
      const fallback = await client.search(collectionName, {
        vector: embedding,
        limit: topK,
        offset: options.offset,
        score_threshold: threshold,
        filter,
        with_payload: true,
      })
      rows = fallback as Array<{
        id: string | number
        payload?: Record<string, unknown>
        score: number
      }>
    }

    const mapped = rows.map((result) => ({
      id: String(result.id),
      content: (result.payload?.content as string) || "",
      metadata: result.payload as Record<string, unknown> | undefined,
      score: result.score,
    }))

    const postFiltered = requiresPostFilter
      ? applyUnifiedPostFilters(mapped, options.filters, options.filterMode)
      : mapped

    return applyThresholdAndPagination(postFiltered, options).results
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const client = await this.getClient()

    const { generateEmbeddings } = await import("./embedding")

    const needsEmbedding = documents.some((doc) => !doc.embedding)
    let embeddings: number[][] | undefined

    if (needsEmbedding) {
      const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)
      if (textsToEmbed.length > 0) {
        const result = await generateEmbeddings(
          textsToEmbed,
          this.config.embeddingConfig,
          this.config.embeddingApiKey
        )
        let embeddingIndex = 0
        embeddings = documents.map((doc) => {
          if (doc.embedding) return doc.embedding
          return result.embeddings[embeddingIndex++]
        })
      }
    } else {
      embeddings = documents.map((doc) => doc.embedding!)
    }

    const points = documents.map((doc, i) => ({
      id: doc.id,
      vector: embeddings![i],
      payload: { content: doc.content, ...doc.metadata },
    }))

    const batchSize = 100
    for (let i = 0; i < points.length; i += batchSize) {
      await client.upsert(collectionName, { wait: true, points: points.slice(i, i + batchSize) })
    }
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    await this.addDocuments(collectionName, documents)
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    const client = await this.getClient()
    await client.delete(collectionName, { wait: true, points: ids })
  }

  async deleteAllDocuments(collectionName: string): Promise<number> {
    const before = await this.countDocuments(collectionName).catch(() => 0)
    await this.deleteCollection(collectionName)
    await this.createCollection(collectionName)
    return before
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, queryResult.embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    return this.queryByEmbedding(collectionName, embedding, options)
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    const requested = Math.max(
      (options.offset ?? 0) + (options.limit ?? options.topK ?? 5),
      options.topK ?? 5
    )
    const results = await this.searchByEmbedding(collectionName, queryResult.embedding, {
      ...options,
      topK: requested,
      offset: 0,
      limit: requested,
    })
    const paged = applyThresholdAndPagination(results, options)
    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => paged.total)
    return { ...paged, total }
  }

  async getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]> {
    const client = await this.getClient()
    const results = await client.retrieve(collectionName, {
      ids,
      with_payload: true,
      with_vector: true,
    })

    return results.map((point) => ({
      id: String(point.id),
      content: (point.payload?.content as string) || "",
      metadata: point.payload as Record<string, unknown> | undefined,
      embedding: point.vector as number[] | undefined,
    }))
  }

  async createCollection(
    name: string,
    options?: { dimension?: number; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const client = await this.getClient()
    await client.createCollection(name, {
      vectors: {
        size: options?.dimension || this.config.embeddingConfig.dimensions || 1536,
        distance: "Cosine",
      },
    })
  }

  async deleteCollection(name: string): Promise<void> {
    const client = await this.getClient()
    await client.deleteCollection(name)
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const client = await this.getClient()
    const response = await client.getCollections()
    const infos: VectorCollectionInfo[] = []

    for (const collection of response.collections) {
      try {
        const info = await client.getCollection(collection.name)
        const vectors = info.config.params.vectors
        infos.push({
          name: collection.name,
          documentCount: info.points_count ?? 0,
          dimension:
            typeof vectors === "object" && vectors !== null && "size" in vectors
              ? (vectors as { size: number }).size
              : undefined,
        })
      } catch {
        infos.push({ name: collection.name, documentCount: 0 })
      }
    }

    return infos
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const client = await this.getClient()
    const info = await client.getCollection(name)
    const vectors = info.config.params.vectors
    return {
      name,
      documentCount: info.points_count ?? 0,
      dimension:
        typeof vectors === "object" && vectors !== null && "size" in vectors
          ? (vectors as { size: number }).size
          : undefined,
    }
  }

  async scrollDocuments(
    collectionName: string,
    options: ScrollOptions = {}
  ): Promise<ScrollResponse> {
    const client = await this.getClient()
    const offset = options.offset
    const limit = options.limit ?? 100
    const { filter, requiresPostFilter } = this.buildQdrantFilter({
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    })
    const response = await client.scroll(collectionName, {
      offset,
      limit,
      filter,
      with_payload: true,
      with_vector: true,
    })

    const mapped = response.points.map((point) => ({
      id: String(point.id),
      content: (point.payload?.content as string) || "",
      metadata: point.payload as Record<string, unknown> | undefined,
      embedding: point.vector as number[] | undefined,
    }))
    const postFiltered = requiresPostFilter
      ? applyUnifiedPostFilters(mapped, options.filters, options.filterMode)
      : mapped
    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => postFiltered.length)

    return {
      documents: postFiltered,
      total,
      offset: options.offset ?? 0,
      limit,
      hasMore: postFiltered.length === limit && (options.offset ?? 0) + limit < total,
    }
  }

  async countDocuments(
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    const client = await this.getClient()
    const { filter, requiresPostFilter } = this.buildQdrantFilter({
      filter: options?.filter,
      filters: options?.filters,
      filterMode: options?.filterMode,
    })

    if (!requiresPostFilter) {
      const result = await client.count(collectionName, {
        filter,
        exact: true,
      } as any)
      return result.count ?? 0
    }

    const response = await client.scroll(collectionName, {
      limit: 10000,
      with_payload: true,
      with_vector: false,
      filter,
    })
    const mapped = response.points.map((point) => ({
      metadata: point.payload as Record<string, unknown> | undefined,
    }))
    return applyUnifiedPostFilters(mapped, options?.filters, options?.filterMode).length
  }
}

/**
 * Milvus Vector Store implementation
 */
export class MilvusVectorStore implements IVectorStore {
  readonly provider: VectorStoreProvider = "milvus"
  private config: VectorStoreConfig
  private milvusClient: import("@zilliz/milvus2-sdk-node").MilvusClient | null = null

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  private async getClient(): Promise<import("@zilliz/milvus2-sdk-node").MilvusClient> {
    if (!this.milvusClient) {
      const { MilvusClient } = await import("@zilliz/milvus2-sdk-node")
      this.milvusClient = new MilvusClient({
        address: this.config.milvusAddress!,
        token: this.config.milvusToken,
        username: this.config.milvusUsername,
        password: this.config.milvusPassword,
        ssl: this.config.milvusSsl,
      })
    }
    return this.milvusClient
  }

  private buildMilvusFilterExpression(options: {
    filter?: Record<string, unknown>
    filters?: PayloadFilter[]
    filterMode?: "and" | "or"
  }): string | undefined {
    if (options.filter) {
      const native = options.filter as unknown
      if (typeof native === "string") {
        return native
      }
      if (typeof native === "object") {
        const clauses = Object.entries(native as Record<string, unknown>).map(
          ([key, value]) => `${key} == ${toMilvusLiteral(value)}`
        )
        if (clauses.length > 0) {
          return clauses.length === 1 ? clauses[0] : `(${clauses.join(" and ")})`
        }
      }
    }

    if (options.filters && options.filters.length > 0) {
      return buildMilvusFilterFromUnified(options.filters, options.filterMode)
    }

    return undefined
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const client = await this.getClient()
    const { generateEmbeddings } = await import("./embedding")

    const needsEmbedding = documents.some((doc) => !doc.embedding)
    let embeddings: number[][] | undefined

    if (needsEmbedding) {
      const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)
      if (textsToEmbed.length > 0) {
        const result = await generateEmbeddings(
          textsToEmbed,
          this.config.embeddingConfig,
          this.config.embeddingApiKey
        )
        let embeddingIndex = 0
        embeddings = documents.map((doc) => {
          if (doc.embedding) return doc.embedding
          return result.embeddings[embeddingIndex++]
        })
      }
    } else {
      embeddings = documents.map((doc) => doc.embedding!)
    }

    const data = documents.map((doc, i) => {
      const baseData: Record<string, unknown> = {
        id: doc.id,
        vector: embeddings![i],
        content: doc.content,
      }
      if (doc.metadata) {
        Object.entries(doc.metadata).forEach(([key, value]) => {
          if (key !== "id" && key !== "vector" && key !== "content") {
            baseData[key] = value
          }
        })
      }
      return baseData
    })

    const batchSize = 1000
    for (let i = 0; i < data.length; i += batchSize) {
      await client.upsert({
        collection_name: collectionName,
        data: data.slice(i, i + batchSize) as any,
      })
    }
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    await this.addDocuments(collectionName, documents)
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    const client = await this.getClient()
    const idsStr = ids.map((id) => `"${id}"`).join(", ")
    await client.delete({ collection_name: collectionName, filter: `id in [${idsStr}]` })
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, queryResult.embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const client = await this.getClient()
    const { topK = 5, threshold } = options
    const filterExpression = this.buildMilvusFilterExpression({
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    })

    const searchResponse = await client.search({
      collection_name: collectionName,
      data: [embedding],
      limit: topK,
      filter: filterExpression,
      output_fields: ["content", "*"],
    } as any)

    const mapped = (searchResponse.results as any[]).map((result: Record<string, unknown>) => ({
      id: String(result.id),
      content: (result.content as string) || "",
      metadata: Object.fromEntries(
        Object.entries(result).filter(([key]) => !["id", "score", "vector"].includes(key))
      ),
      score: result.score as number,
    }))

    const postFiltered = applyUnifiedPostFilters(mapped, options.filters, options.filterMode)
    const thresholdFiltered =
      threshold === undefined ? postFiltered : postFiltered.filter((row) => row.score >= threshold)
    return applyThresholdAndPagination(thresholdFiltered, options).results
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const queryResult = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    const requested = Math.max(
      (options.offset ?? 0) + (options.limit ?? options.topK ?? 5),
      options.topK ?? 5
    )
    const rows = await this.searchByEmbedding(collectionName, queryResult.embedding, {
      ...options,
      topK: requested,
      offset: 0,
      limit: requested,
    })
    const paged = applyThresholdAndPagination(rows, options)
    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => paged.total)
    return { ...paged, total }
  }

  async getDocuments(collectionName: string, ids: string[]): Promise<VectorDocument[]> {
    const client = await this.getClient()
    const idsStr = ids.map((id) => `"${id}"`).join(", ")

    const queryResponse = await client.query({
      collection_name: collectionName,
      filter: `id in [${idsStr}]`,
      output_fields: ["id", "content", "vector", "*"],
    })

    return queryResponse.data.map((item: Record<string, unknown>) => ({
      id: String(item.id),
      content: (item.content as string) || "",
      metadata: Object.fromEntries(
        Object.entries(item).filter(([key]) => !["id", "content", "vector"].includes(key))
      ),
      embedding: item.vector as number[] | undefined,
    }))
  }

  async createCollection(
    name: string,
    options?: { dimension?: number; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const client = await this.getClient()
    const { DataType } = await import("@zilliz/milvus2-sdk-node")

    const exists = await client.hasCollection({ collection_name: name })
    if (exists.value) return

    const dimension = options?.dimension || this.config.embeddingConfig.dimensions || 1536

    await client.createCollection({
      collection_name: name,
      fields: [
        { name: "id", data_type: DataType.VarChar, is_primary_key: true, max_length: 512 },
        { name: "vector", data_type: DataType.FloatVector, dim: dimension },
        { name: "content", data_type: DataType.VarChar, max_length: 65535 },
      ],
      enable_dynamic_field: true,
    })

    await client.createIndex({
      collection_name: name,
      field_name: "vector",
      index_type: "HNSW",
      metric_type: "COSINE",
      params: { M: 16, efConstruction: 256 },
    })

    await client.loadCollection({ collection_name: name })
  }

  async deleteCollection(name: string): Promise<void> {
    const client = await this.getClient()
    const exists = await client.hasCollection({ collection_name: name })
    if (exists.value) {
      await client.dropCollection({ collection_name: name })
    }
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const client = await this.getClient()
    const { DataType } = await import("@zilliz/milvus2-sdk-node")
    const response = await client.listCollections()
    const infos: VectorCollectionInfo[] = []

    for (const collection of response.data) {
      const collectionName = typeof collection === "string" ? collection : (collection as any).name
      try {
        const describeResponse = await client.describeCollection({
          collection_name: collectionName,
        })
        const statsResponse = await client.getCollectionStatistics({
          collection_name: collectionName,
        })

        let dimension = 0
        for (const field of describeResponse.schema.fields) {
          // @ts-expect-error - DataType enum comparison with string
          if (field.data_type === DataType.FloatVector || field.data_type === "FloatVector") {
            dimension =
              Number((field.type_params as any[])?.find((p) => p.key === "dim")?.value) || 0
            break
          }
        }

        let documentCount = 0
        const rowCountStat = (statsResponse.stats as any[])?.find((s) => s.key === "row_count")
        if (rowCountStat) {
          documentCount = parseInt(String(rowCountStat.value), 10) || 0
        }

        infos.push({
          name: String(collectionName),
          documentCount,
          dimension,
          description: describeResponse.schema.description,
        })
      } catch {
        infos.push({ name: collectionName, documentCount: 0 })
      }
    }

    return infos
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const client = await this.getClient()
    const { DataType } = await import("@zilliz/milvus2-sdk-node")

    const describeResponse = await client.describeCollection({ collection_name: name })
    const statsResponse = await client.getCollectionStatistics({ collection_name: name })

    let dimension = 0
    for (const field of describeResponse.schema.fields) {
      // @ts-expect-error - DataType enum comparison with string
      if (field.data_type === DataType.FloatVector || field.data_type === "FloatVector") {
        dimension = Number((field.type_params as any[])?.find((p) => p.key === "dim")?.value) || 0
        break
      }
    }

    let documentCount = 0
    const rowCountStat = (statsResponse.stats as any[])?.find((s) => s.key === "row_count")
    if (rowCountStat) {
      documentCount = parseInt(String(rowCountStat.value), 10) || 0
    }

    return {
      name,
      documentCount,
      dimension,
      description: describeResponse.schema.description,
    }
  }

  async scrollDocuments(
    collectionName: string,
    options: ScrollOptions = {}
  ): Promise<ScrollResponse> {
    const client = await this.getClient()
    const offset = options.offset ?? 0
    const limit = options.limit ?? 100
    const filterExpression = this.buildMilvusFilterExpression({
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    })

    const response = await client.query({
      collection_name: collectionName,
      filter: filterExpression || "",
      output_fields: ["id", "content", "vector", "*"],
      limit,
      offset,
    })

    const docs: VectorDocument[] = response.data.map((item: Record<string, unknown>) => ({
      id: String(item.id),
      content: (item.content as string) || "",
      metadata: Object.fromEntries(
        Object.entries(item).filter(([key]) => !["id", "content", "vector"].includes(key))
      ),
      embedding: item.vector as number[] | undefined,
    }))

    const total = await this.countDocuments(collectionName, {
      filter: options.filter,
      filters: options.filters,
      filterMode: options.filterMode,
    }).catch(() => docs.length)

    return {
      documents: docs,
      total,
      offset,
      limit,
      hasMore: offset + docs.length < total,
    }
  }

  async countDocuments(
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    const client = await this.getClient()
    const filterExpression = this.buildMilvusFilterExpression({
      filter: options?.filter,
      filters: options?.filters,
      filterMode: options?.filterMode,
    })
    const response = await client.query({
      collection_name: collectionName,
      filter: filterExpression || "",
      output_fields: ["count(*)"],
    })
    return (response.data[0]?.["count(*)"] as number) || 0
  }
}

/**
 * Create a vector store instance based on provider
 */
export function createVectorStore(config: VectorStoreConfig): IVectorStore {
  switch (config.provider) {
    case "chroma":
      return new ChromaVectorStore(config)
    case "pinecone":
      if (!config.pineconeApiKey) {
        throw new Error("Pinecone API key is required")
      }
      if (!config.pineconeIndexName) {
        throw new Error("Pinecone index name is required")
      }
      return new PineconeVectorStore(config)
    case "weaviate":
      if (!config.weaviateUrl) {
        throw new Error("Weaviate URL is required")
      }
      return new WeaviateVectorStore(config)
    case "qdrant":
      if (!config.qdrantUrl) {
        throw new Error("Qdrant URL is required")
      }
      return new QdrantVectorStore(config)
    case "milvus":
      if (!config.milvusAddress) {
        throw new Error("Milvus address is required")
      }
      return new MilvusVectorStore(config)
    case "native":
      return new NativeVectorStore(config)
    default:
      throw new Error(`Unsupported vector store provider: ${config.provider}`)
  }
}

/**
 * Get supported vector store providers
 */
export function getSupportedVectorStoreProviders(): VectorStoreProvider[] {
  return ["chroma", "pinecone", "qdrant", "milvus", "native", "weaviate"]
}
