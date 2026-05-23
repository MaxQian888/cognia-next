/**
 * Contextual Retrieval Module
 *
 * Implements Anthropic's Contextual Retrieval approach:
 * - Prepends chunk-specific context to improve retrieval quality
 * - Generates context using LLM based on document and chunk
 * - Supports caching for cost optimization
 */

import type { LanguageModel } from "ai"
import type { DocumentChunk } from "../embedding/chunking"
import { loggers } from "@/lib/logging"

const log = loggers.ai

export interface ContextualChunk extends DocumentChunk {
  contextPrefix: string
  contextualContent: string
  documentTitle?: string
  documentSummary?: string
}

export interface ContextGenerationConfig {
  model: LanguageModel
  maxContextTokens?: number
  includeDocumentSummary?: boolean
  customPrompt?: string
  batchSize?: number
  onProgress?: (progress: { current: number; total: number; chunkId: string }) => void
}

export interface ContextCache {
  get(key: string): string | undefined
  set(key: string, context: string): void
  has(key: string): boolean
  clear(): void
}

/**
 * Create a simple in-memory context cache
 */
export function createContextCache(maxSize: number = 10000): ContextCache {
  const cache = new Map<string, { context: string; accessTime: number }>()

  const evictOldest = () => {
    if (cache.size <= maxSize) return
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, value] of cache.entries()) {
      if (value.accessTime < oldestTime) {
        oldestTime = value.accessTime
        oldestKey = key
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }

  return {
    get(key: string): string | undefined {
      const entry = cache.get(key)
      if (entry) {
        entry.accessTime = Date.now()
        return entry.context
      }
      return undefined
    },
    set(key: string, context: string): void {
      cache.set(key, { context, accessTime: Date.now() })
      evictOldest()
    },
    has(key: string): boolean {
      return cache.has(key)
    },
    clear(): void {
      cache.clear()
    },
  }
}

/**
 * Generate cache key for a chunk
 */
function generateCacheKey(documentId: string, chunkId: string, chunkContent: string): string {
  const contentHash = chunkContent.slice(0, 100) + chunkContent.length
  return `${documentId}:${chunkId}:${contentHash}`
}

/**
 * Default prompt template for context generation
 */
const DEFAULT_CONTEXT_PROMPT = `You are an expert at understanding documents and generating concise context.

<document>
{DOCUMENT_CONTENT}
</document>

Here is a chunk from the document:

<chunk>
{CHUNK_CONTENT}
</chunk>

Generate a brief context (2-3 sentences, max 100 tokens) that situates this chunk within the overall document. The context should:
1. Identify what section or topic this chunk belongs to
2. Mention any key entities, concepts, or terms that provide context
3. Help a search system understand when this chunk is relevant

Output ONLY the context, no explanations or formatting.`

/**
 * Research paper specific prompt
 */
const RESEARCH_PAPER_PROMPT = `You are an expert at understanding academic papers.

<paper>
{DOCUMENT_CONTENT}
</paper>

Here is a section from the paper:

<section>
{CHUNK_CONTENT}
</section>

Generate a brief context (2-3 sentences) that situates this section within the paper. Include:
1. The paper's main topic/contribution if relevant
2. What part of the paper this is (introduction, methods, results, etc.)
3. Key concepts or findings this section discusses

Output ONLY the context, no other text.`

/**
 * Code documentation specific prompt
 */
const CODE_DOC_PROMPT = `You are an expert at understanding technical documentation.

<documentation>
{DOCUMENT_CONTENT}
</documentation>

Here is a section:

<section>
{CHUNK_CONTENT}
</section>

Generate a brief context (2-3 sentences) for this section. Include:
1. What component, API, or feature this documents
2. The purpose or use case
3. Key terms that would help find this section

Output ONLY the context, no other text.`

export const PROMPT_TEMPLATES = {
  default: DEFAULT_CONTEXT_PROMPT,
  research: RESEARCH_PAPER_PROMPT,
  code: CODE_DOC_PROMPT,
}

/**
 * Generate context for a single chunk
 */
export async function generateChunkContext(
  documentContent: string,
  chunk: DocumentChunk,
  config: ContextGenerationConfig
): Promise<string> {
  const { generateText } = await import("ai")

  const promptTemplate = config.customPrompt || DEFAULT_CONTEXT_PROMPT

  // Truncate document if too long (keep first and last parts)
  const maxDocLength = 50000
  let docContent = documentContent
  if (docContent.length > maxDocLength) {
    const halfLength = maxDocLength / 2
    docContent =
      docContent.slice(0, halfLength) +
      "\n\n[... content truncated ...]\n\n" +
      docContent.slice(-halfLength)
  }

  const prompt = promptTemplate
    .replace("{DOCUMENT_CONTENT}", docContent)
    .replace("{CHUNK_CONTENT}", chunk.content)

  try {
    const result = await generateText({
      model: config.model,
      prompt,
      temperature: 0.1,
    })

    return result.text.trim()
  } catch (error) {
    log.warn("Failed to generate context for chunk", { chunkId: chunk.id, error: String(error) })
    return ""
  }
}

/**
 * Generate document summary for context enrichment
 */
export async function generateDocumentSummary(
  documentContent: string,
  model: LanguageModel,
  options: {
    maxTokens?: number
    title?: string
  } = {}
): Promise<string> {
  const { generateText } = await import("ai")
  const { maxTokens: _maxTokens = 200, title } = options

  const titlePrefix = title ? `Document: "${title}"\n\n` : ""

  // Truncate for summary generation
  const maxDocLength = 30000
  const truncatedDoc =
    documentContent.length > maxDocLength
      ? documentContent.slice(0, maxDocLength) + "\n\n[... truncated ...]"
      : documentContent

  const prompt = `${titlePrefix}Summarize the following document in 2-3 sentences, capturing its main topic, purpose, and key points:

${truncatedDoc}

Summary:`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.1,
    })

    return result.text.trim()
  } catch (error) {
    log.warn("Failed to generate document summary", { error: String(error) })
    return ""
  }
}

/**
 * Process chunks with contextual information
 */
export async function addContextToChunks(
  documentContent: string,
  chunks: DocumentChunk[],
  config: ContextGenerationConfig,
  cache?: ContextCache,
  documentId?: string
): Promise<ContextualChunk[]> {
  const { onProgress, batchSize = 5 } = config
  const results: ContextualChunk[] = []

  // Generate document summary if requested
  let documentSummary: string | undefined
  if (config.includeDocumentSummary) {
    documentSummary = await generateDocumentSummary(documentContent, config.model)
  }

  // Process chunks in batches for better performance
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)

    const batchPromises = batch.map(async (chunk, batchIdx) => {
      const chunkIdx = i + batchIdx

      // Check cache first
      const cacheKey = documentId ? generateCacheKey(documentId, chunk.id, chunk.content) : null

      let contextPrefix: string

      if (cacheKey && cache?.has(cacheKey)) {
        contextPrefix = cache.get(cacheKey) || ""
      } else {
        contextPrefix = await generateChunkContext(documentContent, chunk, config)

        if (cacheKey && cache) {
          cache.set(cacheKey, contextPrefix)
        }
      }

      // Report progress
      onProgress?.({
        current: chunkIdx + 1,
        total: chunks.length,
        chunkId: chunk.id,
      })

      // Create contextual chunk
      const contextualContent = contextPrefix
        ? `${contextPrefix}\n\n${chunk.content}`
        : chunk.content

      return {
        ...chunk,
        contextPrefix,
        contextualContent,
        documentSummary,
        metadata: {
          ...chunk.metadata,
          hasContext: !!contextPrefix,
          contextLength: contextPrefix.length,
        },
      } as ContextualChunk
    })

    const batchResults = await Promise.all(batchPromises)
    results.push(...batchResults)
  }

  return results
}

/**
 * Lightweight context generation without LLM
 * Uses heuristics to extract contextual information
 */
export function addLightweightContext(
  documentContent: string,
  chunks: DocumentChunk[],
  options: {
    documentTitle?: string
    includeHeadings?: boolean
    includePosition?: boolean
  } = {}
): ContextualChunk[] {
  const { documentTitle, includeHeadings = true, includePosition = true } = options

  // Extract headings from document
  const headingRegex = /^(#{1,6})\s+(.+)$/gm
  const headings: { level: number; text: string; position: number }[] = []
  let match

  while ((match = headingRegex.exec(documentContent)) !== null) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      position: match.index,
    })
  }

  return chunks.map((chunk, index) => {
    const contextParts: string[] = []

    // Add document title
    if (documentTitle) {
      contextParts.push(`From document: "${documentTitle}"`)
    }

    // Find nearest preceding heading
    if (includeHeadings && headings.length > 0) {
      const precedingHeadings = headings.filter((h) => h.position < chunk.startOffset)
      if (precedingHeadings.length > 0) {
        const nearestHeading = precedingHeadings[precedingHeadings.length - 1]
        contextParts.push(`Section: ${nearestHeading.text}`)
      }
    }

    // Add position context
    if (includePosition) {
      const totalChunks = chunks.length
      let positionDesc: string

      if (index === 0) {
        positionDesc = "beginning"
      } else if (index === totalChunks - 1) {
        positionDesc = "end"
      } else if (index < totalChunks * 0.33) {
        positionDesc = "early section"
      } else if (index < totalChunks * 0.66) {
        positionDesc = "middle section"
      } else {
        positionDesc = "later section"
      }

      contextParts.push(`Position: ${positionDesc} of document`)
    }

    const contextPrefix = contextParts.join(". ")
    const contextualContent = contextPrefix
      ? `[${contextPrefix}]\n\n${chunk.content}`
      : chunk.content

    return {
      ...chunk,
      contextPrefix,
      contextualContent,
      documentTitle,
      metadata: {
        ...chunk.metadata,
        hasContext: !!contextPrefix,
        contextLength: contextPrefix.length,
      },
    }
  })
}

/**
 * Extract key entities from text for context enrichment
 */
export function extractKeyEntities(text: string): string[] {
  const entities: Set<string> = new Set()

  // Extract capitalized phrases (potential named entities)
  const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g
  const capitalizedMatches = text.match(capitalizedPattern) || []
  capitalizedMatches.forEach((m) => {
    if (
      m.length > 3 &&
      !["The", "This", "That", "These", "Those", "What", "When", "Where", "Which", "Who"].includes(
        m
      )
    ) {
      entities.add(m)
    }
  })

  // Extract quoted terms
  const quotedPattern = /"([^"]+)"|'([^']+)'/g
  let quotedMatch
  while ((quotedMatch = quotedPattern.exec(text)) !== null) {
    const term = quotedMatch[1] || quotedMatch[2]
    if (term && term.length > 2) {
      entities.add(term)
    }
  }

  // Extract code-like terms (camelCase, snake_case)
  const codePattern = /\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g
  const codeMatches = text.match(codePattern) || []
  codeMatches.forEach((m) => entities.add(m))

  return Array.from(entities).slice(0, 10)
}

/**
 * Enhance chunk with extracted entities
 */
export function enrichChunkWithEntities(chunk: DocumentChunk): ContextualChunk {
  const entities = extractKeyEntities(chunk.content)
  const entityContext = entities.length > 0 ? `Key terms: ${entities.join(", ")}` : ""

  return {
    ...chunk,
    contextPrefix: entityContext,
    contextualContent: entityContext ? `[${entityContext}]\n\n${chunk.content}` : chunk.content,
    metadata: {
      ...chunk.metadata,
      entities,
      hasContext: !!entityContext,
    },
  }
}
