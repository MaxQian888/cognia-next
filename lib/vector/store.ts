/**
 * Unified Vector Store Interface
 * Provides a consistent API across different vector database backends
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { isTauri } from "@/lib/platform/detect"
import type { EmbeddingModelConfig } from "./embedding"
import { generateEmbedding, generateEmbeddings } from "./embedding"
import { vectorCloudInvoke, type CloudProvider, type FilterOpWire, type FilterWire } from "./invoke"

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
  /**
   * Cloud-provider credential id. Required for non-native providers; the
   * actual secrets live in the OS keyring (see ADR-0022). Resolved at
   * VectorStore construction time; missing on a cloud provider throws.
   */
  configId?: string
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
    return isTauri()
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
    collectionName: string,
    options: ScrollOptions = {}
  ): Promise<ScrollResponse> {
    // Rust scroll_points is cursor-paged (id-ordered). The TS interface
    // requires offset/limit semantics — we accept `offset === 0` only
    // and document the limitation in the error message. Callers that
    // need deep pagination should iterate via `cursor` directly through
    // the Tauri command instead.
    const limit = Math.max(1, options.limit ?? 100)
    const offset = options.offset ?? 0
    if (offset !== 0) {
      throw new Error(
        "NativeVectorStore.scrollDocuments: only offset=0 is supported (use cursor pagination via the Tauri command for deep paging)"
      )
    }
    const page = await this.invoke<{
      points: Array<{ id: string; vector: number[]; payload?: Record<string, unknown> }>
      next_cursor?: string
      has_more: boolean
    }>("vector_scroll_points", {
      collection: collectionName,
      cursor: undefined,
      limit,
    })
    const total = await this.invoke<number>("vector_count_points", {
      collection: collectionName,
    })
    return {
      documents: (page.points || []).map((p) => ({
        id: p.id,
        content: (p.payload?.content as string) || "",
        metadata: p.payload,
        embedding: p.vector,
      })),
      total,
      offset,
      limit,
      hasMore: page.has_more,
    }
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

  async renameCollection(oldName: string, newName: string): Promise<void> {
    await this.invoke("vector_rename_collection", { from: oldName, to: newName })
  }

  async truncateCollection(name: string): Promise<void> {
    await this.invoke("vector_truncate_collection", { name })
  }

  async getStoreSize(): Promise<number> {
    if (!this.isInTauri()) return 0
    return await this.invoke<number>("vector_get_store_size", {})
  }

  async exportCollection(name: string): Promise<CollectionExport> {
    // Rust returns a JSONL string — line 1 is the collection header,
    // subsequent lines are points. Re-pack into the structured
    // `CollectionExport` shape the TS interface promises.
    const jsonl = await this.invoke<string>("vector_export_collection", { collection: name })
    const lines = jsonl.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      throw new Error(`NativeVectorStore.exportCollection: empty export for "${name}"`)
    }
    const header = JSON.parse(lines[0]) as {
      kind: string
      name: string
      dim: number
      description?: string
      embedding_model?: string
      embedding_provider?: string
      metadata?: Record<string, unknown>
      created_at?: string
      updated_at?: string
      point_count?: number
    }
    if (header.kind !== "collection") {
      throw new Error(
        `NativeVectorStore.exportCollection: expected header kind="collection", got "${header.kind}"`
      )
    }
    const parseTimestamp = (s: string | undefined): number | undefined =>
      s ? Date.parse(s) || undefined : undefined
    const meta: VectorCollectionInfo = {
      name: header.name,
      dimension: header.dim,
      documentCount: header.point_count ?? 0,
      description: header.description,
      embeddingModel: header.embedding_model,
      embeddingProvider: header.embedding_provider,
      metadata: header.metadata,
      createdAt: parseTimestamp(header.created_at),
      updatedAt: parseTimestamp(header.updated_at),
    }
    const points = lines.slice(1).map((line) => {
      const row = JSON.parse(line) as {
        kind?: string
        id?: string
        vector?: number[]
        payload?: Record<string, unknown>
      }
      return {
        id: row.id ?? "",
        vector: row.vector ?? [],
        payload: row.payload,
      }
    })
    return { meta, points }
  }

  async importCollection(data: CollectionImport, overwrite?: boolean): Promise<void> {
    // Inverse of `exportCollection` — pack the structured payload into
    // the JSONL shape Rust expects and forward.
    const header = {
      kind: "collection",
      name: data.meta.name,
      dim: data.meta.dimension,
      description: data.meta.description,
      embedding_model: data.meta.embeddingModel,
      embedding_provider: data.meta.embeddingProvider,
      metadata: data.meta.metadata,
      created_at: data.meta.createdAt ? new Date(data.meta.createdAt).toISOString() : undefined,
      updated_at: data.meta.updatedAt ? new Date(data.meta.updatedAt).toISOString() : undefined,
      point_count: data.meta.documentCount,
    }
    const lines = [JSON.stringify(header)]
    for (const point of data.points) {
      lines.push(
        JSON.stringify({
          kind: "point",
          id: point.id,
          content: (point.payload?.content as string) ?? null,
          payload: point.payload,
          vector: point.vector,
        })
      )
    }
    await this.invoke("vector_import_collection", {
      collection: data.meta.name,
      jsonl: lines.join("\n"),
      overwrite: overwrite ?? false,
    })
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
    collectionName: string,
    options?: {
      filter?: Record<string, unknown>
      filters?: PayloadFilter[]
      filterMode?: "and" | "or"
    }
  ): Promise<number> {
    // When the caller passes payload filters we route through the
    // search command (which already supports them) and read its
    // `total` field. The plain `vector_count_points` path is hot — used
    // by every "how many sources are indexed?" UI — so we keep it
    // filterless for max throughput.
    if (
      (options?.filters && options.filters.length > 0) ||
      (options?.filter && Object.keys(options.filter).length > 0)
    ) {
      // Filter-aware count via the search command's pagination total.
      // We don't actually need results; top_k=1 + offset=0 + limit=1
      // is the cheapest invocation that still reads `total`.
      const probeVector = new Array(this.config.embeddingConfig.dimensions ?? 1536).fill(0)
      const resp = await this.invoke<{ total: number }>("vector_search_points", {
        collection: collectionName,
        vector: probeVector,
        top_k: 1,
        offset: 0,
        limit: 1,
        filters: options.filters,
        filter_mode: options.filterMode,
      })
      return resp.total ?? 0
    }
    return await this.invoke<number>("vector_count_points", { collection: collectionName })
  }

  async getStats(): Promise<VectorStats> {
    // No global stats command — sum per-collection stats over the
    // collection list. `getStoreSize` is authoritative for on-disk
    // bytes so we use that and only roll up the count fields here.
    const collections = await this.listCollections()
    let totalPoints = 0
    for (const c of collections) {
      try {
        const stats = await this.invoke<{ count: number }>("vector_get_stats", {
          collection: c.name,
        })
        totalPoints += stats.count ?? 0
      } catch {
        // A collection that vanished mid-iteration just contributes 0.
      }
    }
    const storageSizeBytes = await this.getStoreSize()
    return {
      collectionCount: collections.length,
      totalPoints,
      storagePath: "(native sqlite-vec)",
      storageSizeBytes,
    }
  }
}

// ============================================================================
// Cloud Vector Stores (ADR-0022)
//
// The 5 cloud providers (Chroma, Pinecone, Qdrant, Milvus, Weaviate) all
// dispatch through Rust via `vectorCloudInvoke` (see `./invoke.ts`). The
// JS side still owns:
//   - Embedding generation (calls OpenAI/Google/Cohere/Mistral directly)
//   - Post-filter for filter ops not natively supported by every provider
//     (substring / null-checks etc.) via `applyUnifiedPostFilters`
//   - Threshold-cutoff + offset/limit slicing via `applyThresholdAndPagination`
//
// `CloudVectorStore` is the shared base; each provider is a 3-line subclass
// that just sets the `provider` discriminator.
// ============================================================================

abstract class CloudVectorStore implements IVectorStore {
  abstract readonly provider: VectorStoreProvider

  constructor(protected readonly config: VectorStoreConfig) {
    if (!config.configId) {
      throw new Error(
        `${this.constructor.name} requires config.configId — cloud providers no longer accept inline credentials, configure via the credential form first`
      )
    }
  }

  protected get args(): { provider: CloudProvider; configId: string } {
    return { provider: this.provider as CloudProvider, configId: this.config.configId! }
  }

  private filtersToWire(filters?: PayloadFilter[]): FilterWire[] | undefined {
    if (!filters || filters.length === 0) return undefined
    return filters.map((f) => ({
      key: f.key,
      value: f.value,
      // FilterOperation snake_case strings are already wire-compatible.
      operation: f.operation as FilterOpWire,
    }))
  }

  async addDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    const needsEmbedding = documents.some((doc) => !doc.embedding)
    let embeddings: number[][]
    if (needsEmbedding) {
      const textsToEmbed = documents.filter((doc) => !doc.embedding).map((doc) => doc.content)
      const result =
        textsToEmbed.length > 0
          ? await generateEmbeddings(
              textsToEmbed,
              this.config.embeddingConfig,
              this.config.embeddingApiKey
            )
          : { embeddings: [] as number[][] }
      let idx = 0
      embeddings = documents.map((doc) => doc.embedding ?? result.embeddings[idx++])
    } else {
      embeddings = documents.map((doc) => doc.embedding!)
    }
    const points = documents.map((doc, i) => ({
      id: doc.id,
      vector: embeddings[i],
      payload: { ...(doc.metadata ?? {}), content: doc.content },
    }))
    await vectorCloudInvoke.upsert(this.args, collectionName, points)
  }

  async updateDocuments(collectionName: string, documents: VectorDocument[]): Promise<void> {
    return this.addDocuments(collectionName, documents)
  }

  async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
    await vectorCloudInvoke.deletePoints(this.args, collectionName, ids)
  }

  async deleteAllDocuments(collectionName: string): Promise<number> {
    return vectorCloudInvoke.truncate(this.args, collectionName)
  }

  async searchDocuments(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const { embedding } = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    return this.searchByEmbedding(collectionName, embedding, options)
  }

  async searchByEmbedding(
    collectionName: string,
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const topK = options.topK ?? options.limit ?? 5
    const offset = options.offset ?? 0
    const resp = await vectorCloudInvoke.query(this.args, collectionName, embedding, {
      limit: topK + offset,
      offset: 0,
      filter: this.filtersToWire(options.filters),
      filter_mode: options.filterMode,
      include_payload: true,
      include_content: true,
    })
    const mapped: VectorSearchResult[] = resp.results.map((r) => ({
      id: r.id,
      content: r.content ?? "",
      metadata: r.payload as Record<string, unknown> | undefined,
      score: r.score,
    }))
    const postFiltered = applyUnifiedPostFilters(mapped, options.filters, options.filterMode)
    return applyThresholdAndPagination(postFiltered, options).results
  }

  async searchDocumentsWithTotal(
    collectionName: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const { embedding } = await generateEmbedding(
      query,
      this.config.embeddingConfig,
      this.config.embeddingApiKey
    )
    const requested = Math.max(
      (options.offset ?? 0) + (options.limit ?? options.topK ?? 5),
      options.topK ?? 5
    )
    const results = await this.searchByEmbedding(collectionName, embedding, {
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
    const points = await vectorCloudInvoke.getPoints(this.args, collectionName, ids)
    return points.map((p) => ({
      id: p.id,
      content: (p.payload?.content as string | undefined) ?? "",
      metadata: p.payload as Record<string, unknown> | undefined,
      embedding: p.vector.length > 0 ? p.vector : undefined,
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
    await vectorCloudInvoke.createCollection(this.args, {
      name,
      dimension: options?.dimension ?? this.config.embeddingConfig.dimensions ?? 1536,
      description: options?.description,
      embedding_model: options?.embeddingModel,
      embedding_provider: options?.embeddingProvider,
      metadata: options?.metadata,
    })
  }

  async deleteCollection(name: string): Promise<void> {
    await vectorCloudInvoke.deleteCollection(this.args, name)
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const list = await vectorCloudInvoke.listCollections(this.args)
    return list.map((c) => ({
      name: c.name,
      documentCount: c.document_count,
      dimension: c.dimension > 0 ? c.dimension : undefined,
      description: c.description,
    }))
  }

  async getCollectionInfo(name: string): Promise<VectorCollectionInfo> {
    const c = await vectorCloudInvoke.getCollection(this.args, name)
    return {
      name: c.name,
      documentCount: c.document_count,
      dimension: c.dimension > 0 ? c.dimension : undefined,
      description: c.description,
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
    // If no filters at all → cheap path through count endpoint.
    if (!options?.filter && (!options?.filters || options.filters.length === 0)) {
      return vectorCloudInvoke.count(this.args, collectionName, undefined)
    }
    // With filters: over-fetch via search probe then post-filter for ops
    // the provider can't natively express. The probe vector is zero —
    // results ranking doesn't matter, only post-filter cardinality.
    const probe = new Array(this.config.embeddingConfig.dimensions ?? 1536).fill(0)
    const rows = await this.searchByEmbedding(collectionName, probe, {
      topK: 10000,
      filter: options?.filter,
      filters: options?.filters,
      filterMode: options?.filterMode,
    })
    return rows.length
  }
}

export class ChromaVectorStore extends CloudVectorStore {
  readonly provider: VectorStoreProvider = "chroma"
}

export class PineconeVectorStore extends CloudVectorStore {
  readonly provider: VectorStoreProvider = "pinecone"
}

export class WeaviateVectorStore extends CloudVectorStore {
  readonly provider: VectorStoreProvider = "weaviate"
}

export class QdrantVectorStore extends CloudVectorStore {
  readonly provider: VectorStoreProvider = "qdrant"
}

export class MilvusVectorStore extends CloudVectorStore {
  readonly provider: VectorStoreProvider = "milvus"
}

// ============================================================================
// Pre-Phase C legacy SDK-based cloud store implementations have been deleted.
// All cloud paths now go through CloudVectorStore → vectorCloudInvoke → Rust.
// ============================================================================

/**
 * Create a vector store instance based on provider
 */
export function createVectorStore(config: VectorStoreConfig): IVectorStore {
  let store: IVectorStore
  switch (config.provider) {
    case "chroma":
      store = new ChromaVectorStore(config)
      break
    case "pinecone":
      if (!config.pineconeApiKey) {
        throw new Error("Pinecone API key is required")
      }
      if (!config.pineconeIndexName) {
        throw new Error("Pinecone index name is required")
      }
      store = new PineconeVectorStore(config)
      break
    case "weaviate":
      if (!config.weaviateUrl) {
        throw new Error("Weaviate URL is required")
      }
      store = new WeaviateVectorStore(config)
      break
    case "qdrant":
      if (!config.qdrantUrl) {
        throw new Error("Qdrant URL is required")
      }
      store = new QdrantVectorStore(config)
      break
    case "milvus":
      if (!config.milvusAddress) {
        throw new Error("Milvus address is required")
      }
      store = new MilvusVectorStore(config)
      break
    case "native":
      store = new NativeVectorStore(config)
      break
    default:
      throw new Error(`Unsupported vector store provider: ${config.provider}`)
  }
  return wrapVectorStoreWithPluginHooks(store)
}

/**
 * Wrap a concrete vector store with plugin-event dispatching for
 * `onDocumentsIndexed` and `onVectorSearch`. The wrapper is a thin proxy:
 * every other method delegates straight to the inner store. Hook dispatch
 * happens after the underlying call resolves so plugins observe completed
 * work, not in-flight intent.
 */
function wrapVectorStoreWithPluginHooks(inner: IVectorStore): IVectorStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver) as unknown
      if (typeof original !== "function") return original
      // Bind early so `this` inside provider classes points back at the
      // underlying instance, not the proxy (avoids infinite recursion when a
      // method calls another method on the same store).
      const bound = (original as (...args: unknown[]) => unknown).bind(target)

      if (prop === "addDocuments") {
        return async (collectionName: string, documents: VectorDocument[]) => {
          const result = await (bound as IVectorStore["addDocuments"])(collectionName, documents)
          // Lazy-load the hooks module so importing the vector store doesn't
          // pull in the plugin runtime (which transitively touches `@tauri-
          // apps/api/core` and breaks tests that mock it via jest.mock).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getPluginEventHooks } = require("@/lib/plugin/messaging/hooks-system") as {
            getPluginEventHooks: () => {
              dispatchDocumentsIndexed: (c: string, n: number) => void
            }
          }
          getPluginEventHooks().dispatchDocumentsIndexed(collectionName, documents.length)
          return result
        }
      }
      if (prop === "searchDocuments") {
        return async (
          collectionName: string,
          query: string,
          options?: SearchOptions
        ): Promise<VectorSearchResult[]> => {
          const results = await (bound as IVectorStore["searchDocuments"])(
            collectionName,
            query,
            options
          )
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getPluginEventHooks } = require("@/lib/plugin/messaging/hooks-system") as {
            getPluginEventHooks: () => {
              dispatchVectorSearch: (c: string, q: string, n: number) => void
            }
          }
          getPluginEventHooks().dispatchVectorSearch(collectionName, query, results.length)
          return results
        }
      }
      return bound
    },
  })
}

/**
 * Get supported vector store providers
 */
export function getSupportedVectorStoreProviders(): VectorStoreProvider[] {
  return ["chroma", "pinecone", "qdrant", "milvus", "native", "weaviate"]
}
