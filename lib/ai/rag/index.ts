/**
 * Enhanced RAG Module
 *
 * Combines all advanced RAG components:
 * - Hybrid search (BM25 + Vector)
 * - Reranking
 * - Contextual retrieval
 * - Query expansion
 */

// Hybrid Search
export {
  type BM25Config,
  type HybridSearchConfig,
  type SearchDocument,
  type HybridSearchResult,
  BM25Index,
  HybridSearchEngine,
  reciprocalRankFusion,
  normalizeScores,
  deduplicateResults,
  createHybridSearchEngine,
} from "./hybrid-search"

// Reranking
export {
  type RerankDocument,
  type RerankResult,
  type RerankConfig,
  rerankWithLLM,
  rerankWithCohere,
  rerankWithHeuristics,
  rerankWithMMR,
  rerank,
  filterByRelevance,
  boostByMetadata,
  boostByRecency,
} from "./reranker"

// Contextual Retrieval
export {
  type ContextualChunk,
  type ContextGenerationConfig,
  type ContextCache,
  createContextCache,
  generateChunkContext,
  generateDocumentSummary,
  addContextToChunks,
  addLightweightContext,
  extractKeyEntities,
  enrichChunkWithEntities,
  PROMPT_TEMPLATES,
} from "./contextual-retrieval"

// Query Expansion
export {
  type QueryExpansionConfig,
  type ExpandedQuery,
  generateQueryVariants,
  generateHypotheticalAnswer,
  rewriteQuery,
  extractKeywords,
  generateSynonyms,
  expandWithSynonyms,
  expandQuery,
  decomposeQuery,
  generateStepBackQuery,
  mergeQueryResults,
} from "./query-expansion"

// RAG Pipeline
export {
  type RAGPipelineConfig,
  type RAGPipelineContext,
  type IndexingOptions,
  RAGPipeline,
  createRAGPipeline,
} from "./rag-pipeline"

// Unified RAG runtime
export {
  type RAGRuntimeConfig,
  type SharedRAGRuntimeSelection,
  type VectorSettingsLike,
  RAGRuntime,
  createRAGRuntime,
  createRAGRuntimeConfigFromVectorSettings,
  getSharedRAGRuntime,
  resolveSharedRAGRuntimeSelection,
  resetSharedRAGRuntimes,
} from "./rag-runtime"

// RAG Consumption Contract
export {
  type RAGDegradeReason,
  type RAGRetrievalOutcome,
  type RAGCollectionSource,
  type RAGCollectionResolutionStatus,
  type RAGSearchMetadata,
  type ResolveRAGCollectionInput,
  type RAGCollectionResolution,
  type NormalizeRAGRetrievalInput,
  type NormalizedRAGDocument,
  type NormalizedRAGRetrievalResult,
  createEmptyRAGSearchMetadata,
  composeRAGRuntimeConfig,
  resolveRAGCollection,
  normalizeRAGRetrievalResult,
} from "./consumption-contract"

// Find Relevant Content API
export {
  type DocumentWithEmbedding,
  type RelevantContent,
  type FindRelevantOptions,
  findRelevantContent,
  findRelevantContentWithEmbedding,
  batchFindRelevantContent,
  findMostRelevant,
  hasRelevantContent,
  groupBySimilarity,
} from "./find-relevant"

// RAG Tools for AI SDK Integration
export {
  type RAGToolsConfig,
  createRAGTools,
  createSimpleRetrievalTool,
  createKnowledgeBaseManagementTools,
  combineTools,
} from "./rag-tools"

// Query Cache
export {
  type RAGCacheConfig,
  type CacheEntry,
  type CacheStats as RAGCacheStats,
  LRUCache,
  RAGQueryCache,
  createRAGQueryCache,
  createHighPerformanceCache,
  createLightweightCache,
} from "./cache"

// Embedding Batcher
export {
  type BatcherConfig,
  type BatchRequest,
  type BatcherStats,
  EmbeddingBatcher,
  batchGenerateEmbeddings,
  createEmbeddingBatcher,
  getGlobalBatcher,
  resetGlobalBatcher,
} from "./embedding-batcher"

// Dynamic Context Manager
export {
  type ContextManagerConfig,
  type ContextBudget,
  type ChunkWithScore,
  type ContextSelectionResult,
  DynamicContextManager,
  createContextManager,
  getModelContextLimits,
} from "./context-manager"

// Adaptive Reranker
export {
  type RelevanceFeedback,
  type FeedbackHistoryEntry,
  type AdaptiveRerankerConfig,
  type LearningStats,
  AdaptiveReranker,
  createAdaptiveReranker,
  getGlobalAdaptiveReranker,
  resetGlobalAdaptiveReranker,
} from "./adaptive-reranker"

// Persistent Storage
export {
  type StoredDocument,
  type StoredCollection,
  type PersistentStorageConfig,
  type ExportData,
  PersistentRAGStorage,
  createPersistentStorage,
  isIndexedDBAvailable,
  getStorageEstimate,
} from "./persistent-storage"

// Collection Manager
export {
  type CollectionConfig,
  type CollectionStats,
  type CollectionInfo,
  type CollectionManagerConfig,
  RAGCollectionManager,
  createCollectionManager,
  getGlobalCollectionManager,
  resetGlobalCollectionManager,
} from "./collection-manager"

// Citation Formatter
export {
  type CitationStyle,
  type CitationOptions,
  type Citation,
  type FormattedCitation,
  formatCitations,
  formatContextWithCitations,
  generateReferenceList,
  addInlineCitations,
  CITATION_STYLE_INFO,
  getAvailableCitationStyles,
} from "./citation-formatter"

// Retrieval Grader (Corrective RAG)
export {
  type RetrievalGraderConfig,
  type GradedDocument,
  type GradingResult,
  gradeDocumentHeuristic,
  gradeDocumentLLM,
  gradeRetrievedDocuments,
  isRetrievalSufficient,
} from "./retrieval-grader"

// Answer Grounding (Self-Reflective RAG)
export {
  type GroundingCheckConfig,
  type GroundingCheckResult,
  checkGroundingHeuristic,
  checkGroundingLLM,
  checkAnswerGrounding,
  isAnswerGrounded,
} from "./answer-grounding"

// RAG Evaluator (Quality Metrics)
export {
  type RAGEvaluationConfig,
  type RAGEvaluationResult,
  evaluateContextPrecision,
  evaluateContextRecall,
  evaluateFaithfulness,
  evaluateAnswerRelevance,
  evaluateRAG,
} from "./rag-evaluator"

// RAG Guardrails (Input/Output Safety)
export {
  type GuardrailsConfig,
  type SanitizationResult,
  type ValidationResult,
  type ConfidenceAssessment,
  sanitizeQuery,
  validateRetrievalInput,
  assessConfidence,
  detectLowConfidence,
} from "./rag-guardrails"

// CJK Tokenizer (Multilingual Support)
export {
  isCJKChar,
  isCJKText,
  detectCJKLanguage,
  tokenizeCJK,
  tokenizeMultilingual,
  estimateCJKTokenCount,
  CJK_STOP_WORDS,
  CHINESE_STOP_WORDS,
  JAPANESE_STOP_WORDS,
  KOREAN_STOP_WORDS,
} from "./cjk-tokenizer"

// Embedding Cache (LRU)
export {
  type EmbeddingCacheConfig,
  type EmbeddingCacheStats,
  EmbeddingCache as RAGEmbeddingCache,
  createEmbeddingCache as createRAGEmbeddingCache,
  getGlobalEmbeddingCache,
  resetGlobalEmbeddingCache,
} from "./embedding-cache"
