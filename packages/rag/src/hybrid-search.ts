/**
 * Hybrid Search Module
 *
 * Combines semantic vector search with BM25 keyword search
 * using Reciprocal Rank Fusion (RRF) for optimal retrieval.
 *
 * Features:
 * - BM25 keyword search implementation
 * - Vector similarity search
 * - Reciprocal Rank Fusion (RRF) for result merging
 * - Configurable weights for each search method
 * - CJK language support via multilingual tokenizer
 */

import { tokenizeMultilingual } from "./cjk-tokenizer"

export interface BM25Config {
  k1?: number // Term frequency saturation parameter (default: 1.2)
  b?: number // Length normalization parameter (default: 0.75)
}

export interface HybridSearchConfig {
  vectorWeight?: number // Weight for vector search results (0-1, default: 0.5)
  keywordWeight?: number // Weight for keyword search results (0-1, default: 0.5)
  sparseWeight?: number // Weight for sparse search results (0-1, default: 0.3)
  lateInteractionWeight?: number // Weight for late interaction results (0-1, default: 0.2)
  bm25Config?: BM25Config
  rrf?: {
    k?: number // RRF constant (default: 60)
  }
  deduplicateResults?: boolean
  minScore?: number // Minimum score threshold
}

export interface SearchDocument {
  id: string
  content: string
  metadata?: Record<string, unknown>
}

export interface HybridSearchResult {
  id: string
  content: string
  metadata?: Record<string, unknown>
  vectorScore?: number
  keywordScore?: number
  sparseScore?: number
  lateInteractionScore?: number
  combinedScore: number
  sources: ("vector" | "keyword" | "sparse" | "late")[]
}

export interface BM25SnapshotDocumentV1 {
  id: string
  length: number
  terms: Array<[term: string, frequency: number]>
}

export interface BM25SnapshotV1 {
  version: 1
  k1: number
  b: number
  documents: BM25SnapshotDocumentV1[]
}

/**
 * BM25 Index for keyword-based search
 */
export class BM25Index {
  private documents: Map<string, { content: string; terms: Map<string, number>; length: number }> =
    new Map()
  private termDocFreq: Map<string, number> = new Map()
  private avgDocLength: number = 0
  private k1: number
  private b: number

  constructor(config: BM25Config = {}) {
    this.k1 = config.k1 ?? 1.2
    this.b = config.b ?? 0.75
  }

  /**
   * Tokenize text into terms (supports CJK languages via multilingual tokenizer)
   */
  private tokenize(text: string): string[] {
    return tokenizeMultilingual(text)
  }

  /**
   * Calculate term frequency in a document
   */
  private calculateTermFrequency(terms: string[]): Map<string, number> {
    const freq = new Map<string, number>()
    for (const term of terms) {
      freq.set(term, (freq.get(term) || 0) + 1)
    }
    return freq
  }

  /**
   * Add a document to the index
   */
  addDocument(id: string, content: string): void {
    if (this.documents.has(id)) this.removeDocument(id)
    const terms = this.tokenize(content)
    const termFreq = this.calculateTermFrequency(terms)

    this.documents.set(id, {
      content,
      terms: termFreq,
      length: terms.length,
    })

    // Update document frequencies
    const uniqueTerms = new Set(terms)
    for (const term of uniqueTerms) {
      this.termDocFreq.set(term, (this.termDocFreq.get(term) || 0) + 1)
    }

    // Update average document length
    this.updateAvgDocLength()
  }

  /**
   * Add multiple documents to the index
   */
  addDocuments(documents: SearchDocument[]): void {
    for (const doc of documents) {
      this.addDocument(doc.id, doc.content)
    }
  }

  /**
   * Remove a document from the index
   */
  removeDocument(id: string): void {
    const doc = this.documents.get(id)
    if (!doc) return

    // Update term document frequencies
    for (const term of doc.terms.keys()) {
      const freq = this.termDocFreq.get(term) || 0
      if (freq <= 1) {
        this.termDocFreq.delete(term)
      } else {
        this.termDocFreq.set(term, freq - 1)
      }
    }

    this.documents.delete(id)
    this.updateAvgDocLength()
  }

  /**
   * Update average document length
   */
  private updateAvgDocLength(): void {
    if (this.documents.size === 0) {
      this.avgDocLength = 0
      return
    }
    let totalLength = 0
    for (const doc of this.documents.values()) {
      totalLength += doc.length
    }
    this.avgDocLength = totalLength / this.documents.size
  }

  /**
   * Calculate IDF for a term
   */
  private calculateIDF(term: string): number {
    const N = this.documents.size
    const df = this.termDocFreq.get(term) || 0
    if (df === 0 || N === 0) return 0
    return Math.log((N - df + 0.5) / (df + 0.5) + 1)
  }

  /**
   * Calculate BM25 score for a document given a query
   */
  private calculateScore(docId: string, queryTerms: string[]): number {
    const doc = this.documents.get(docId)
    if (!doc) return 0

    let score = 0
    const queryTermFreq = this.calculateTermFrequency(queryTerms)

    for (const [term, queryFreq] of queryTermFreq) {
      const idf = this.calculateIDF(term)
      const tf = doc.terms.get(term) || 0

      if (tf === 0) continue

      const numerator = tf * (this.k1 + 1)
      const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength))

      score += idf * (numerator / denominator) * queryFreq
    }

    return score
  }

  /**
   * Search the index with a query
   */
  search(query: string, topK: number = 10): { id: string; score: number }[] {
    const queryTerms = this.tokenize(query)
    if (queryTerms.length === 0) return []

    const results: { id: string; score: number }[] = []

    for (const docId of this.documents.keys()) {
      const score = this.calculateScore(docId, queryTerms)
      if (score > 0) {
        results.push({ id: docId, score })
      }
    }

    // Sort by score descending and take top K
    return results.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  /**
   * Get the number of documents in the index
   */
  size(): number {
    return this.documents.size
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.documents.clear()
    this.termDocFreq.clear()
    this.avgDocLength = 0
  }

  /**
   * Check if a document exists in the index
   */
  hasDocument(id: string): boolean {
    return this.documents.has(id)
  }

  /**
   * Get all document IDs
   */
  getDocumentIds(): string[] {
    return Array.from(this.documents.keys())
  }

  /** Content-free lexical projection used by the encrypted segment codec. */
  exportSnapshot(): BM25SnapshotV1 {
    return {
      version: 1,
      k1: this.k1,
      b: this.b,
      documents: [...this.documents.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, document]) => ({
          id,
          length: document.length,
          terms: [...document.terms.entries()].sort(([left], [right]) => left.localeCompare(right)),
        })),
    }
  }

  static fromSnapshot(snapshot: BM25SnapshotV1): BM25Index {
    if (snapshot.version !== 1) throw new Error("Unsupported BM25 snapshot version")
    if (!Number.isFinite(snapshot.k1) || snapshot.k1 <= 0) throw new Error("Invalid BM25 k1")
    if (!Number.isFinite(snapshot.b) || snapshot.b < 0 || snapshot.b > 1) {
      throw new Error("Invalid BM25 b")
    }
    const index = new BM25Index({ k1: snapshot.k1, b: snapshot.b })
    for (const document of snapshot.documents) {
      if (!document.id || !Number.isInteger(document.length) || document.length < 0) {
        throw new Error("Invalid BM25 snapshot document")
      }
      const terms = new Map<string, number>()
      for (const [term, frequency] of document.terms) {
        if (!term || !Number.isInteger(frequency) || frequency < 1 || terms.has(term)) {
          throw new Error("Invalid BM25 snapshot term")
        }
        terms.set(term, frequency)
        index.termDocFreq.set(term, (index.termDocFreq.get(term) ?? 0) + 1)
      }
      index.documents.set(document.id, { content: "", terms, length: document.length })
    }
    index.updateAvgDocLength()
    return index
  }
}

/**
 * Reciprocal Rank Fusion (RRF) for combining ranked results
 *
 * RRF formula: score = sum(1 / (k + rank)) for each ranking
 * where k is a constant (typically 60)
 */
export function reciprocalRankFusion(
  rankedLists: { id: string; score: number }[][],
  weights: number[] = [],
  k: number = 60
): { id: string; score: number }[] {
  const scores = new Map<string, number>()

  // Normalize weights if provided
  const normalizedWeights =
    weights.length === rankedLists.length ? weights : rankedLists.map(() => 1 / rankedLists.length)

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const rankedList = rankedLists[listIdx]
    const weight = normalizedWeights[listIdx]

    for (let rank = 0; rank < rankedList.length; rank++) {
      const item = rankedList[rank]
      const rrfScore = weight * (1 / (k + rank + 1))
      scores.set(item.id, (scores.get(item.id) || 0) + rrfScore)
    }
  }

  // Convert to array and sort by score
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Normalize scores to 0-1 range using min-max normalization
 */
export function normalizeScores(
  results: { id: string; score: number }[]
): { id: string; score: number }[] {
  if (results.length === 0) return []
  if (results.length === 1) return [{ id: results[0].id, score: 1 }]

  const scores = results.map((r) => r.score)
  const minScore = Math.min(...scores)
  const maxScore = Math.max(...scores)
  const range = maxScore - minScore

  if (range === 0) {
    return results.map((r) => ({ id: r.id, score: 1 }))
  }

  return results.map((r) => ({
    id: r.id,
    score: (r.score - minScore) / range,
  }))
}

/**
 * Deduplicate results by ID, keeping the highest score
 */
export function deduplicateResults<T extends { id: string; score?: number }>(results: T[]): T[] {
  const seen = new Map<string, T>()

  for (const result of results) {
    const existing = seen.get(result.id)
    if (!existing || (result.score && (!existing.score || result.score > existing.score))) {
      seen.set(result.id, result)
    }
  }

  return Array.from(seen.values())
}

/**
 * Hybrid Search Engine combining vector and keyword search
 */
export class HybridSearchEngine {
  private bm25Index: BM25Index
  private documents: Map<string, SearchDocument> = new Map()
  private config: Required<HybridSearchConfig>

  constructor(config: HybridSearchConfig = {}) {
    this.config = {
      vectorWeight: config.vectorWeight ?? 0.5,
      keywordWeight: config.keywordWeight ?? 0.5,
      sparseWeight: config.sparseWeight ?? 0.3,
      lateInteractionWeight: config.lateInteractionWeight ?? 0.2,
      bm25Config: config.bm25Config ?? {},
      rrf: { k: config.rrf?.k ?? 60 },
      deduplicateResults: config.deduplicateResults ?? true,
      minScore: config.minScore ?? 0,
    }
    this.bm25Index = new BM25Index(this.config.bm25Config)
  }

  /**
   * Add documents to the hybrid search engine
   */
  addDocuments(documents: SearchDocument[]): void {
    for (const doc of documents) {
      this.documents.set(doc.id, doc)
      this.bm25Index.addDocument(doc.id, doc.content)
    }
  }

  /**
   * Remove documents from the engine
   */
  removeDocuments(ids: string[]): void {
    for (const id of ids) {
      this.documents.delete(id)
      this.bm25Index.removeDocument(id)
    }
  }

  /**
   * Perform hybrid search combining vector and keyword results
   */
  hybridSearch(
    vectorResults: { id: string; score: number }[],
    query: string,
    topK: number = 10,
    sparseResults: { id: string; score: number }[] = [],
    lateResults: { id: string; score: number }[] = []
  ): HybridSearchResult[] {
    // Get keyword search results
    const keywordResults = this.bm25Index.search(query, topK * 2)

    // Normalize scores
    const normalizedVector = normalizeScores(vectorResults)
    const normalizedKeyword = normalizeScores(keywordResults)
    const normalizedSparse = sparseResults.length > 0 ? normalizeScores(sparseResults) : []
    const normalizedLate = lateResults.length > 0 ? normalizeScores(lateResults) : []

    // Apply RRF to combine results
    const rankedLists = [normalizedVector, normalizedKeyword]
    const weights = [this.config.vectorWeight, this.config.keywordWeight]
    if (normalizedSparse.length > 0) {
      rankedLists.push(normalizedSparse)
      weights.push(this.config.sparseWeight)
    }
    if (normalizedLate.length > 0) {
      rankedLists.push(normalizedLate)
      weights.push(this.config.lateInteractionWeight)
    }

    const fusedResults = reciprocalRankFusion(rankedLists, weights, this.config.rrf.k)

    // Build final results with all scores
    const vectorScoreMap = new Map(vectorResults.map((r) => [r.id, r.score]))
    const keywordScoreMap = new Map(keywordResults.map((r) => [r.id, r.score]))
    const sparseScoreMap = new Map(sparseResults.map((r) => [r.id, r.score]))
    const lateScoreMap = new Map(lateResults.map((r) => [r.id, r.score]))

    let results: HybridSearchResult[] = fusedResults.map((r) => {
      const doc = this.documents.get(r.id)
      const sources: ("vector" | "keyword" | "sparse" | "late")[] = []

      if (vectorScoreMap.has(r.id)) sources.push("vector")
      if (keywordScoreMap.has(r.id)) sources.push("keyword")
      if (sparseScoreMap.has(r.id)) sources.push("sparse")
      if (lateScoreMap.has(r.id)) sources.push("late")

      return {
        id: r.id,
        content: doc?.content || "",
        metadata: doc?.metadata,
        vectorScore: vectorScoreMap.get(r.id),
        keywordScore: keywordScoreMap.get(r.id),
        sparseScore: sparseScoreMap.get(r.id),
        lateInteractionScore: lateScoreMap.get(r.id),
        combinedScore: r.score,
        sources,
      }
    })

    // Apply deduplication if enabled
    if (this.config.deduplicateResults) {
      results = deduplicateResults(results)
    }

    // Filter by minimum score
    if (this.config.minScore > 0) {
      results = results.filter((r) => r.combinedScore >= this.config.minScore)
    }

    return results.slice(0, topK)
  }

  /**
   * Perform keyword-only search
   */
  keywordSearch(query: string, topK: number = 10): HybridSearchResult[] {
    const results = this.bm25Index.search(query, topK)

    return results.map((r) => {
      const doc = this.documents.get(r.id)
      return {
        id: r.id,
        content: doc?.content || "",
        metadata: doc?.metadata,
        keywordScore: r.score,
        combinedScore: r.score,
        sources: ["keyword"] as "keyword"[],
      }
    })
  }

  /**
   * Get document count
   */
  size(): number {
    return this.documents.size
  }

  /**
   * Clear all documents
   */
  clear(): void {
    this.documents.clear()
    this.bm25Index.clear()
  }

  /**
   * Check if a document exists
   */
  hasDocument(id: string): boolean {
    return this.documents.has(id)
  }

  /**
   * Get a document by ID
   */
  getDocument(id: string): SearchDocument | undefined {
    return this.documents.get(id)
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HybridSearchConfig>): void {
    if (config.vectorWeight !== undefined) {
      this.config.vectorWeight = config.vectorWeight
    }
    if (config.keywordWeight !== undefined) {
      this.config.keywordWeight = config.keywordWeight
    }
    if (config.sparseWeight !== undefined) {
      this.config.sparseWeight = config.sparseWeight
    }
    if (config.lateInteractionWeight !== undefined) {
      this.config.lateInteractionWeight = config.lateInteractionWeight
    }
    if (config.rrf?.k !== undefined) {
      this.config.rrf.k = config.rrf.k
    }
    if (config.deduplicateResults !== undefined) {
      this.config.deduplicateResults = config.deduplicateResults
    }
    if (config.minScore !== undefined) {
      this.config.minScore = config.minScore
    }
  }
}

/**
 * Create a hybrid search engine with default configuration
 */
export function createHybridSearchEngine(
  documents: SearchDocument[] = [],
  config: HybridSearchConfig = {}
): HybridSearchEngine {
  const engine = new HybridSearchEngine(config)
  if (documents.length > 0) {
    engine.addDocuments(documents)
  }
  return engine
}
