// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  chunkCodeDocument,
  chunkDocument,
  chunkDocumentAsync,
  chunkDocumentRecursive,
  chunkDocumentSemantic,
  chunkDocumentSlidingWindow,
  chunkDocumentSmart,
  estimateChunkCount,
  getChunkStats,
  mergeChunks,
} from "@cognia/provider-embedding/chunking"
export type {
  ChunkingOptions,
  ChunkingResult,
  ChunkingStrategy,
  DocumentChunk,
} from "@cognia/provider-embedding/chunking"
