/**
 * Ingest driver for a single workspace knowledge file (project-scoped RAG).
 *
 * Because `KnowledgeFile.content` is already extracted inline text, the pipeline
 * is parse-free: `chunk → (redact) → embed → persist`. PII redaction is applied
 * ONLY when the vector backend is a cloud store — a fully local `native` backend
 * embeds the original text for best retrieval quality (decision: cloud-only
 * redaction). Mirrors the reuse strategy of the memory subsystem: it reuses the
 * twin ingest leaf stages (`prepareChunks`, `embedRedactedChunks`) but owns its
 * own thin orchestration + storage.
 */

import { documentContentHash } from "@cognia/document/document-structure"
import type { KnowledgeFile } from "@/types"
import type { ChunkingStrategy } from "@cognia/provider-embedding/chunking"
import { prepareChunks } from "@/lib/twin/ingest/chunk"
import { embedRedactedChunks, type EmbeddingConfig } from "@/lib/twin/ingest/embed"
import {
  redactText,
  restoreOffsetsThroughRedaction,
  translateOffsetsThroughRedaction,
} from "@cognia/redact"
import type { IVectorStore } from "@cognia/vector/store"
import type { TwinSourceFormat, VectorBackend } from "@/types/twin"
import { getIndexedContentHash } from "@/lib/db/project-chunks"
import { persistProjectChunks } from "./persist"

export interface ProjectKnowledgeIngestDeps {
  store: IVectorStore
  embedding: EmbeddingConfig
  vectorBackend: VectorBackend
}

export interface IngestKnowledgeFileInput {
  projectId: string
  file: KnowledgeFile
  deps: ProjectKnowledgeIngestDeps
  /** Skip when the file's content hash matches the indexed one. Default true. */
  skipUnchanged?: boolean
}

export interface IngestKnowledgeFileResult {
  chunkCount: number
  /** True when ingest was skipped because the content was unchanged. */
  skipped: boolean
}

/**
 * Map a `KnowledgeFile.type` to the chunking strategy used for its content.
 * (`prepareChunks` also takes a `TwinSourceFormat`; we pass an explicit strategy
 * so plain-text / JSON — which have no twin source format — chunk sensibly.)
 */
const KIND_TO_STRATEGY: Record<KnowledgeFile["type"], ChunkingStrategy> = {
  text: "paragraph",
  markdown: "heading",
  pdf: "smart",
  code: "code",
  json: "recursive",
  word: "heading",
  excel: "fixed",
  csv: "fixed",
  html: "heading",
  presentation: "paragraph",
  rtf: "paragraph",
  epub: "heading",
}

/** Best-effort `TwinSourceFormat` for the chunk metadata (cosmetic when a
 *  strategy is passed explicitly). */
export const PROJECT_KNOWLEDGE_SOURCE_FORMATS: Record<KnowledgeFile["type"], TwinSourceFormat> = {
  text: "rtf",
  markdown: "markdown",
  pdf: "pdf",
  code: "code",
  json: "csv",
  word: "docx",
  excel: "xlsx",
  csv: "csv",
  html: "html",
  presentation: "pptx",
  rtf: "rtf",
  epub: "epub",
}

/**
 * Fast, deterministic change-detection hash (djb2). Not cryptographic — used
 * only to decide whether a file's content changed since the last ingest.
 */
export function hashContent(text: string): string {
  return documentContentHash(text)
}

/** Structure and projection changes rebuild derived generations; legacy hashes remain valid. */
export function hashKnowledgeFile(
  file: Pick<KnowledgeFile, "content" | "structure" | "embeddableContent">
): string {
  const content = file.content ?? ""
  if (!file.structure && file.embeddableContent === undefined) return hashContent(content)
  return hashContent(
    JSON.stringify([content, file.structure ?? null, file.embeddableContent ?? null])
  )
}

export async function ingestKnowledgeFile(
  input: IngestKnowledgeFileInput
): Promise<IngestKnowledgeFileResult> {
  const { projectId, file, deps } = input
  const content = file.content ?? ""
  const contentHash = hashKnowledgeFile(file)

  if (input.skipUnchanged !== false) {
    const indexed = await getIndexedContentHash(projectId, file.id)
    if (indexed === contentHash) {
      return { chunkCount: 0, skipped: true }
    }
  }

  if (content.trim().length === 0) {
    await persistProjectChunks({
      projectId,
      fileId: file.id,
      vectorBackend: deps.vectorBackend,
      store: deps.store,
      contentHash,
      expectedSource: file,
      chunks: [],
      embeddings: [],
    })
    return { chunkCount: 0, skipped: false }
  }

  // Cloud-only PII redaction: a local `native` backend embeds originals. For a
  // cloud backend we chunk the REDACTED text (so cloud embeddings + payload
  // never see PII) and reconstruct the displayable original per chunk via
  // `unredactText` using the redaction map — the original text never leaves the
  // machine, but the UI/prompt-return path still shows the user's real content.
  const redactForCloud = deps.vectorBackend !== "native"
  const redaction = redactForCloud ? redactText(content) : null
  const redactedText = redaction ? redaction.redacted : content

  const structure =
    file.structure?.contentHash === documentContentHash(content) &&
    file.structure.textLength === content.length
      ? file.structure
      : undefined
  const prepared = prepareChunks({
    redactedText,
    originalText: content,
    // Both maps are exhaustive over `KnowledgeFile["type"]`, so these always
    // resolve to a concrete format/strategy.
    format: PROJECT_KNOWLEDGE_SOURCE_FORMATS[file.type],
    strategy: KIND_TO_STRATEGY[file.type],
    ...(structure?.pages.length
      ? {
          pageMap: redaction
            ? translateOffsetsThroughRedaction(structure.pages, redactedText, redaction.map)
            : structure.pages,
        }
      : {}),
  })

  if (prepared.length === 0) {
    await persistProjectChunks({
      projectId,
      fileId: file.id,
      vectorBackend: deps.vectorBackend,
      store: deps.store,
      contentHash,
      expectedSource: file,
      chunks: [],
      embeddings: [],
    })
    return { chunkCount: 0, skipped: false }
  }

  const { embeddings } = await embedRedactedChunks(
    prepared.map((c) => c.content),
    deps.embedding
  )

  const sourceChunks = redaction
    ? restoreOffsetsThroughRedaction(prepared, redactedText, redaction.map)
    : prepared
  await persistProjectChunks({
    projectId,
    fileId: file.id,
    vectorBackend: deps.vectorBackend,
    store: deps.store,
    contentHash,
    expectedSource: file,
    chunks: sourceChunks.map((c) => ({
      // `c.content` is the (possibly redacted) slice. `contentRedacted` is what
      // gets embedded + sent to the remote store; `content` is the displayable
      // original, recovered from canonical source ranges after inverse redaction.
      content: content.slice(c.charStart, c.charEnd),
      contentRedacted: c.content,
      charStart: c.charStart,
      charEnd: c.charEnd,
      strategy: c.strategy,
      tokenCount: c.tokenCount,
      metadata: c.metadata,
    })),
    embeddings,
  })

  return { chunkCount: prepared.length, skipped: false }
}
