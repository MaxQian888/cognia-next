/**
 * Internal types for the wiki indexer pipeline.
 *
 * These shapes flow between the file-walker, the four agents, and the
 * orchestrator. Public types (the persisted `WikiArticle` etc.) live in
 * `types/wiki/index.ts` — this file is for the in-flight intermediate
 * representations.
 */

import type { WikiSourceRef } from "@/types/wiki"

/**
 * A code chunk produced by the Twin ingest pipeline plus the wiki-relevant
 * metadata. The `lineStart`/`lineEnd` fields come from `TwinChunk.metadata`
 * (the format-aware `code` chunker emits them).
 */
export interface CodeChunk {
  /** Stable id from `twinChunks.id`. */
  id: string
  /** Source file the chunk was sliced from (relative to repo root). */
  filePath: string
  /** Module path (file's parent dir, populated by `moduleForPath`). */
  module: string
  /** 1-based source line range. */
  lineStart: number
  lineEnd: number
  /** Approximate token count (js-tiktoken). */
  tokenCount: number
  /** Original text — used in agent prompts. */
  content: string
  /** SHA-256 of the source file at the moment the chunk was generated. */
  fileHash: string
}

/**
 * Per-module aggregated info computed by `RepoMapAgent`. Drives ordering of
 * `ModuleArticleAgent` invocations and shows up in the article's pageRank
 * field for `wiki_search` ranking.
 */
export interface ModuleStat {
  module: string
  filePaths: string[]
  totalLines: number
  totalTokens: number
  /** 0..1 normalized score; higher = more important. */
  pageRank: number
}

/**
 * Output of `ModuleArticleAgent` before it's persisted. The orchestrator
 * appends the database id, generatorVersion, and embedding before writing.
 */
export interface ModuleArticleDraft {
  module: string
  slug: string
  title: string
  summary: string
  /** Sections in render order; bodyMd is plain markdown, no front-matter. */
  sections: ModuleSectionDraft[]
  /** Cited source refs (union of section refs). */
  sourceRefs: WikiSourceRef[]
  /** Full markdown body — heading + summary + sections concatenated. */
  contentMd: string
  /** File hashes that contributed to this article. */
  fileHashes: Record<string, string>
}

export interface ModuleSectionDraft {
  sectionIndex: number
  headingPath: string[]
  bodyMd: string
  sourceRefs: WikiSourceRef[]
}

/** Index page draft produced by `IndexPageAgent`. */
export interface IndexPageDraft {
  contentMd: string
  /** Links into individual article slugs (for orchestrator validation). */
  referencedSlugs: string[]
}
