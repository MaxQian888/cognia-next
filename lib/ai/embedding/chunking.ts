/**
 * Document Chunking - Split documents into smaller chunks for embedding
 *
 * Strategies:
 * - fixed: Split by character count with word boundary respect
 * - sentence: Split by sentences, grouped to target size
 * - paragraph: Split by paragraphs, grouped to target size
 * - semantic: AI-powered splitting based on content boundaries
 * - heading: Split by markdown/document headings
 */

import type { LanguageModel } from "ai"
import { loggers } from "@/lib/logging"

const log = loggers.ai

export type ChunkingStrategy =
  | "fixed"
  | "sentence"
  | "paragraph"
  | "semantic"
  | "heading"
  | "smart"
  | "recursive"
  | "sliding_window"
  | "code"

export interface ChunkingOptions {
  strategy: ChunkingStrategy
  chunkSize: number
  chunkOverlap: number
  minChunkSize?: number
  maxChunkSize?: number
  model?: LanguageModel // For semantic chunking
}

export interface DocumentChunk {
  id: string
  content: string
  index: number
  startOffset: number
  endOffset: number
  metadata?: Record<string, unknown>
}

export interface ChunkingResult {
  chunks: DocumentChunk[]
  totalChunks: number
  originalLength: number
  strategy: ChunkingStrategy
}

const DEFAULT_OPTIONS: ChunkingOptions = {
  strategy: "semantic",
  chunkSize: 1000,
  chunkOverlap: 200,
  minChunkSize: 0,
  maxChunkSize: 2000,
}

function normalizeChunkingInputs(
  text: string,
  options: Partial<ChunkingOptions>
): {
  cleanedText: string
  normalizedChunkSize: number
  normalizedOverlap: number
  opts: ChunkingOptions
} {
  const opts = { ...DEFAULT_OPTIONS, ...options } as ChunkingOptions

  const normalizedChunkSize =
    typeof options.chunkSize === "number" && options.chunkSize > 0
      ? options.chunkSize
      : DEFAULT_OPTIONS.chunkSize

  // If the caller didn't specify overlap, pick a proportional default.
  const rawOverlap =
    typeof options.chunkOverlap === "number"
      ? options.chunkOverlap
      : Math.min(DEFAULT_OPTIONS.chunkOverlap, Math.floor(normalizedChunkSize * 0.2))

  const normalizedOverlap = Math.min(Math.max(0, rawOverlap), Math.max(0, normalizedChunkSize - 1))

  return {
    cleanedText: text.replace(/\r\n/g, "\n").trim(),
    normalizedChunkSize,
    normalizedOverlap,
    opts,
  }
}

/**
 * Split text into chunks using fixed-size strategy
 */
function fixedSizeChunking(
  text: string,
  chunkSize: number,
  overlap: number
): { content: string; start: number; end: number }[] {
  const chunks: { content: string; start: number; end: number }[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    let chunkEnd = end

    // Try to break at word boundary
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end)
      if (lastSpace > start + chunkSize * 0.5) {
        chunkEnd = lastSpace
      }
    }

    chunks.push({
      content: text.slice(start, chunkEnd).trim(),
      start,
      end: chunkEnd,
    })

    // If we reached the end, do not apply overlap again (prevents infinite loop)
    if (chunkEnd >= text.length) break

    start = Math.max(0, chunkEnd - overlap)
  }

  return chunks
}

/**
 * Split text into chunks by sentences
 */
function sentenceChunking(
  text: string,
  chunkSize: number,
  overlap: number
): { content: string; start: number; end: number }[] {
  // Split by sentence-ending punctuation
  const sentenceRegex = /[.!?]+[\s]+/g
  const sentences: { text: string; start: number; end: number }[] = []

  let lastIndex = 0
  let match

  while ((match = sentenceRegex.exec(text)) !== null) {
    sentences.push({
      text: text.slice(lastIndex, match.index + match[0].length).trim(),
      start: lastIndex,
      end: match.index + match[0].length,
    })
    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    sentences.push({
      text: text.slice(lastIndex).trim(),
      start: lastIndex,
      end: text.length,
    })
  }

  // Group sentences into chunks
  const chunks: { content: string; start: number; end: number }[] = []
  let currentChunk = ""
  let chunkStart = 0
  let chunkEnd = 0
  let sentenceBuffer: typeof sentences = []

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.text.length > chunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        start: chunkStart,
        end: chunkEnd,
      })

      // Calculate overlap
      const overlapSentences: typeof sentences = []
      let overlapLength = 0
      for (let i = sentenceBuffer.length - 1; i >= 0; i--) {
        if (overlapLength + sentenceBuffer[i].text.length <= overlap) {
          overlapSentences.unshift(sentenceBuffer[i])
          overlapLength += sentenceBuffer[i].text.length
        } else {
          break
        }
      }

      currentChunk = overlapSentences.map((s) => s.text).join(" ")
      chunkStart = overlapSentences[0]?.start ?? sentence.start
      sentenceBuffer = [...overlapSentences]
    }

    currentChunk += (currentChunk ? " " : "") + sentence.text
    chunkEnd = sentence.end
    sentenceBuffer.push(sentence)
  }

  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      start: chunkStart,
      end: chunkEnd,
    })
  }

  return chunks
}

/**
 * Split text into chunks by headings (markdown style)
 */
function headingChunking(
  text: string,
  chunkSize: number,
  overlap: number
): { content: string; start: number; end: number }[] {
  // Match markdown headings (# ## ### etc.) or underlined headings
  const headingRegex = /^(#{1,6}\s+.+|.+\n[=-]+)$/gm
  const sections: { text: string; start: number; end: number; heading?: string }[] = []

  let match
  const matches: { index: number; heading: string }[] = []

  while ((match = headingRegex.exec(text)) !== null) {
    matches.push({ index: match.index, heading: match[0] })
  }

  // Split by headings
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const next = matches[i + 1]

    // Add content before first heading
    if (i === 0 && current.index > 0) {
      const beforeContent = text.slice(0, current.index).trim()
      if (beforeContent) {
        sections.push({
          text: beforeContent,
          start: 0,
          end: current.index,
        })
      }
    }

    const sectionEnd = next ? next.index : text.length
    const sectionContent = text.slice(current.index, sectionEnd).trim()

    if (sectionContent) {
      sections.push({
        text: sectionContent,
        start: current.index,
        end: sectionEnd,
        heading: current.heading,
      })
    }
  }

  // If no headings found, fall back to paragraph chunking
  if (sections.length === 0) {
    return paragraphChunking(text, chunkSize, overlap)
  }

  // Group sections into chunks respecting chunkSize
  const chunks: { content: string; start: number; end: number }[] = []
  let currentChunk = ""
  let chunkStart = 0
  let chunkEnd = 0

  for (const section of sections) {
    // If adding this section exceeds chunk size, save current chunk
    if (currentChunk.length + section.text.length > chunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        start: chunkStart,
        end: chunkEnd,
      })

      // Start new chunk (with overlap from previous content if small enough)
      if (currentChunk.length <= overlap) {
        // Keep entire previous chunk as overlap
        chunkStart = chunkStart // Keep same start for overlap
      } else {
        currentChunk = ""
        chunkStart = section.start
      }
    }

    if (!currentChunk) {
      chunkStart = section.start
    }
    currentChunk += (currentChunk ? "\n\n" : "") + section.text
    chunkEnd = section.end
  }

  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      start: chunkStart,
      end: chunkEnd,
    })
  }

  return chunks
}

/**
 * Split text into chunks by paragraphs
 */
function paragraphChunking(
  text: string,
  chunkSize: number,
  overlap: number
): { content: string; start: number; end: number }[] {
  // Split by double newlines (paragraphs)
  const paragraphRegex = /\n\s*\n/g
  const paragraphs: { text: string; start: number; end: number }[] = []

  let lastIndex = 0
  let match

  while ((match = paragraphRegex.exec(text)) !== null) {
    const paraText = text.slice(lastIndex, match.index).trim()
    if (paraText) {
      paragraphs.push({
        text: paraText,
        start: lastIndex,
        end: match.index,
      })
    }
    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  const remaining = text.slice(lastIndex).trim()
  if (remaining) {
    paragraphs.push({
      text: remaining,
      start: lastIndex,
      end: text.length,
    })
  }

  // Group paragraphs into chunks
  const chunks: { content: string; start: number; end: number }[] = []
  let currentChunk = ""
  let chunkStart = 0
  let chunkEnd = 0

  for (const para of paragraphs) {
    if (currentChunk.length + para.text.length > chunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        start: chunkStart,
        end: chunkEnd,
      })

      // For paragraph chunking, we use the last paragraph as overlap
      const lastChunkContent = currentChunk.trim()
      if (lastChunkContent.length <= overlap) {
        currentChunk = lastChunkContent + "\n\n"
        // Keep the same start
      } else {
        currentChunk = ""
        chunkStart = para.start
      }
    }

    if (!currentChunk) {
      chunkStart = para.start
    }
    currentChunk += (currentChunk ? "\n\n" : "") + para.text
    chunkEnd = para.end
  }

  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      start: chunkStart,
      end: chunkEnd,
    })
  }

  return chunks
}

/**
 * Main chunking function - splits document into chunks
 */
export function chunkDocument(
  text: string,
  options: Partial<ChunkingOptions> = {},
  documentId?: string
): ChunkingResult {
  const { cleanedText, normalizedChunkSize, normalizedOverlap, opts } = normalizeChunkingInputs(
    text,
    options
  )

  if (!cleanedText) {
    return {
      chunks: [],
      totalChunks: 0,
      originalLength: 0,
      strategy: opts.strategy,
    }
  }

  let rawChunks: { content: string; start: number; end: number }[]

  switch (opts.strategy) {
    case "sentence":
      rawChunks = sentenceChunking(cleanedText, normalizedChunkSize, normalizedOverlap)
      break
    case "paragraph":
      rawChunks = paragraphChunking(cleanedText, normalizedChunkSize, normalizedOverlap)
      break
    case "semantic":
      rawChunks = headingChunking(cleanedText, normalizedChunkSize, normalizedOverlap)
      break
    case "heading":
      rawChunks = headingChunking(cleanedText, normalizedChunkSize, normalizedOverlap)
      break
    case "smart":
      rawChunks = chunkDocumentSmart(cleanedText, { ...opts }, documentId).chunks.map((c) => ({
        content: c.content,
        start: c.startOffset,
        end: c.endOffset,
      }))
      break
    case "recursive":
      rawChunks = chunkDocumentRecursive(
        cleanedText,
        {
          maxChunkSize: normalizedChunkSize,
          minChunkSize: opts.minChunkSize,
          overlap: normalizedOverlap,
        },
        documentId
      ).chunks.map((c) => ({ content: c.content, start: c.startOffset, end: c.endOffset }))
      break
    case "sliding_window":
      rawChunks = chunkDocumentSlidingWindow(
        cleanedText,
        {
          windowSize: normalizedChunkSize,
          stepSize: Math.max(1, normalizedChunkSize - normalizedOverlap),
          preserveWords: true,
        },
        documentId
      ).chunks.map((c) => ({ content: c.content, start: c.startOffset, end: c.endOffset }))
      break
    case "code":
      rawChunks = chunkCodeDocument(
        cleanedText,
        { maxChunkSize: normalizedChunkSize },
        documentId
      ).chunks.map((c) => ({ content: c.content, start: c.startOffset, end: c.endOffset }))
      break
    case "fixed":
    default:
      rawChunks = fixedSizeChunking(cleanedText, normalizedChunkSize, normalizedOverlap)
      break
  }

  // Filter chunks by min/max size
  const filteredChunks = rawChunks.filter((chunk) => {
    const len = chunk.content.length
    return len >= (opts.minChunkSize || 0) && len <= (opts.maxChunkSize || Infinity)
  })

  // Create DocumentChunk objects
  const chunks: DocumentChunk[] = filteredChunks.map((chunk, index) => ({
    id: documentId ? `${documentId}-chunk-${index}` : `chunk-${index}-${Date.now()}`,
    content: chunk.content,
    index,
    startOffset: chunk.start,
    endOffset: chunk.end,
  }))

  return {
    chunks,
    totalChunks: chunks.length,
    originalLength: cleanedText.length,
    strategy: opts.strategy,
  }
}

/**
 * Async variant that can leverage AI-powered semantic chunking when a model is provided.
 * Falls back to heading-based chunking if the model call fails or returns no split points.
 */
export async function chunkDocumentAsync(
  text: string,
  options: Partial<ChunkingOptions> = {},
  documentId?: string
): Promise<ChunkingResult> {
  const normalized = normalizeChunkingInputs(text, options)

  // Only the semantic strategy is AI-assisted; others reuse the sync implementation.
  if (normalized.opts.strategy === "semantic" && normalized.opts.model) {
    try {
      const semanticResult = await chunkDocumentSemantic(text, normalized.opts.model, {
        targetChunkSize: normalized.normalizedChunkSize,
        documentId,
      })

      if (semanticResult.totalChunks > 0) {
        return semanticResult
      }
    } catch (error) {
      log.warn("Semantic chunking failed, falling back to heading strategy", { error })
    }

    // Fallback to deterministic heading-based chunking when AI path fails.
    return chunkDocument(text, { ...options, strategy: "heading" }, documentId)
  }

  return chunkDocument(text, options, documentId)
}

/**
 * Estimate number of chunks for a given text
 */
export function estimateChunkCount(
  textLength: number,
  chunkSize: number = 1000,
  overlap: number = 200
): number {
  if (textLength <= chunkSize) return 1
  const effectiveChunkSize = chunkSize - overlap
  return Math.ceil((textLength - overlap) / effectiveChunkSize)
}

/**
 * Merge overlapping chunks back into original text
 */
export function mergeChunks(chunks: DocumentChunk[]): string {
  if (chunks.length === 0) return ""
  if (chunks.length === 1) return chunks[0].content

  // Sort by index
  const sorted = [...chunks].sort((a, b) => a.index - b.index)

  // Simple concatenation with deduplication
  let result = sorted[0].content

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i].content
    const prev = sorted[i - 1].content

    // Find overlap
    let overlapStart = 0
    for (let j = Math.min(prev.length, current.length); j > 0; j--) {
      if (prev.endsWith(current.slice(0, j))) {
        overlapStart = j
        break
      }
    }

    result += current.slice(overlapStart)
  }

  return result
}

/**
 * Get chunk statistics
 */
export function getChunkStats(chunks: DocumentChunk[]): {
  count: number
  avgLength: number
  minLength: number
  maxLength: number
  totalLength: number
} {
  if (chunks.length === 0) {
    return { count: 0, avgLength: 0, minLength: 0, maxLength: 0, totalLength: 0 }
  }

  const lengths = chunks.map((c) => c.content.length)
  const totalLength = lengths.reduce((a, b) => a + b, 0)

  return {
    count: chunks.length,
    avgLength: Math.round(totalLength / chunks.length),
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    totalLength,
  }
}

function parseSemanticSplitPoints(responseText: string, textLength: number): number[] {
  const jsonMatch = responseText.match(/\[[^\]]+\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const splitPoints = parsed
      .map((p) => Number(p))
      .filter((p) => Number.isFinite(p) && p > 0 && p < textLength)
      .sort((a, b) => a - b)

    // De-duplicate while preserving order
    return Array.from(new Set(splitPoints))
  } catch {
    return []
  }
}

/**
 * AI-powered semantic chunking using language model to identify split points
 * This provides true semantic chunking based on content meaning
 */
export async function chunkDocumentSemantic(
  text: string,
  model: LanguageModel,
  options: {
    targetChunkSize?: number
    documentId?: string
  } = {}
): Promise<ChunkingResult> {
  const { targetChunkSize = 1000, documentId } = options
  const cleanedText = text.replace(/\r\n/g, "\n").trim()

  if (!cleanedText || cleanedText.length <= targetChunkSize) {
    // Text is small enough, return as single chunk
    return {
      chunks: cleanedText
        ? [
            {
              id: documentId ? `${documentId}-chunk-0` : `chunk-0-${Date.now()}`,
              content: cleanedText,
              index: 0,
              startOffset: 0,
              endOffset: cleanedText.length,
            },
          ]
        : [],
      totalChunks: cleanedText ? 1 : 0,
      originalLength: cleanedText.length,
      strategy: "semantic",
    }
  }

  try {
    const { generateText } = await import("ai")

    // Use AI to identify natural break points in the text
    const prompt = `Analyze the following text and identify the best positions to split it into semantic chunks of approximately ${targetChunkSize} characters each. Each chunk should contain a complete thought or topic.

Return ONLY a JSON array of character positions (numbers) where the text should be split. The positions should be at natural break points (end of paragraphs, sections, or logical divisions).

Example output format: [500, 1200, 1800]

Text to analyze:
${cleanedText.slice(0, 8000)}${cleanedText.length > 8000 ? "\n...[truncated]" : ""}`

    const result = await generateText({
      model,
      prompt,
      temperature: 0.1,
    })

    const splitPoints = parseSemanticSplitPoints(result.text, cleanedText.length)

    // If AI couldn't find good split points, fall back to heading chunking
    if (splitPoints.length === 0) {
      return chunkDocument(
        cleanedText,
        { strategy: "heading", chunkSize: targetChunkSize, chunkOverlap: 100 },
        documentId
      )
    }

    // Create chunks based on split points
    const chunks: DocumentChunk[] = []
    let lastPos = 0

    for (let i = 0; i <= splitPoints.length; i++) {
      const endPos = i < splitPoints.length ? splitPoints[i] : cleanedText.length
      const content = cleanedText.slice(lastPos, endPos).trim()

      if (content) {
        chunks.push({
          id: documentId
            ? `${documentId}-chunk-${chunks.length}`
            : `chunk-${chunks.length}-${Date.now()}`,
          content,
          index: chunks.length,
          startOffset: lastPos,
          endOffset: endPos,
          metadata: { semantic: true },
        })
      }

      lastPos = endPos
    }

    return {
      chunks,
      totalChunks: chunks.length,
      originalLength: cleanedText.length,
      strategy: "semantic",
    }
  } catch (error) {
    // If AI fails, fall back to heading chunking
    log.warn("Semantic chunking failed, falling back to heading strategy", { error })
    return chunkDocument(
      cleanedText,
      { strategy: "heading", chunkSize: targetChunkSize, chunkOverlap: 100 },
      documentId
    )
  }
}

/**
 * Smart chunking that automatically selects the best strategy based on content
 */
export function chunkDocumentSmart(
  text: string,
  options: Partial<ChunkingOptions> = {},
  documentId?: string
): ChunkingResult {
  const cleanedText = text.replace(/\r\n/g, "\n").trim()

  // Detect document type and select appropriate strategy
  const hasMarkdownHeadings = /^#{1,6}\s+/m.test(cleanedText)
  const hasParagraphs = /\n\s*\n/.test(cleanedText)
  const avgSentenceLength = cleanedText.length / (cleanedText.split(/[.!?]+/).length || 1)

  let strategy: ChunkingStrategy

  if (hasMarkdownHeadings) {
    strategy = "heading"
  } else if (hasParagraphs && avgSentenceLength > 50) {
    strategy = "paragraph"
  } else if (avgSentenceLength > 30) {
    strategy = "sentence"
  } else {
    strategy = "fixed"
  }

  return chunkDocument(cleanedText, { ...options, strategy }, documentId)
}

/**
 * Recursive chunking - splits content hierarchically
 * First by major sections, then by paragraphs, then by sentences
 */
export function chunkDocumentRecursive(
  text: string,
  options: {
    maxChunkSize?: number
    minChunkSize?: number
    overlap?: number
    separators?: string[]
  } = {},
  documentId?: string
): ChunkingResult {
  const {
    maxChunkSize = 1000,
    minChunkSize = 100,
    overlap = 50,
    separators = ["\n\n\n", "\n\n", "\n", ". ", " "],
  } = options

  const cleanedText = text.replace(/\r\n/g, "\n").trim()

  if (!cleanedText) {
    return { chunks: [], totalChunks: 0, originalLength: 0, strategy: "fixed" }
  }

  const rawChunks: { content: string; start: number; end: number }[] = []

  function splitRecursively(content: string, startOffset: number, separatorIdx: number): void {
    // Base case: content is small enough
    if (content.length <= maxChunkSize) {
      if (content.trim().length >= minChunkSize) {
        rawChunks.push({
          content: content.trim(),
          start: startOffset,
          end: startOffset + content.length,
        })
      }
      return
    }

    // Try current separator
    if (separatorIdx >= separators.length) {
      // No more separators, force split at maxChunkSize
      let pos = 0
      while (pos < content.length) {
        const end = Math.min(pos + maxChunkSize, content.length)
        const chunk = content.slice(pos, end).trim()
        if (chunk.length >= minChunkSize) {
          rawChunks.push({
            content: chunk,
            start: startOffset + pos,
            end: startOffset + end,
          })
        }
        pos = end - overlap
        if (pos <= 0 || end >= content.length) break
      }
      return
    }

    const separator = separators[separatorIdx]
    const parts = content.split(separator)

    if (parts.length === 1) {
      // Separator not found, try next one
      splitRecursively(content, startOffset, separatorIdx + 1)
      return
    }

    let currentOffset = startOffset
    let currentChunk = ""
    let chunkStart = startOffset

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const potentialChunk = currentChunk + (currentChunk ? separator : "") + part

      if (potentialChunk.length > maxChunkSize && currentChunk.length > 0) {
        // Current chunk is full, process it
        if (currentChunk.length <= maxChunkSize) {
          if (currentChunk.trim().length >= minChunkSize) {
            rawChunks.push({
              content: currentChunk.trim(),
              start: chunkStart,
              end: currentOffset,
            })
          }
        } else {
          // Recursively split the large chunk
          splitRecursively(currentChunk, chunkStart, separatorIdx + 1)
        }

        // Start new chunk with overlap
        const overlapContent = currentChunk.slice(-overlap)
        currentChunk = overlapContent + separator + part
        chunkStart = currentOffset - overlap
      } else {
        currentChunk = potentialChunk
      }

      currentOffset += part.length + separator.length
    }

    // Handle remaining content
    if (currentChunk.trim().length >= minChunkSize) {
      if (currentChunk.length <= maxChunkSize) {
        rawChunks.push({
          content: currentChunk.trim(),
          start: chunkStart,
          end: startOffset + content.length,
        })
      } else {
        splitRecursively(currentChunk, chunkStart, separatorIdx + 1)
      }
    }
  }

  splitRecursively(cleanedText, 0, 0)

  // Create DocumentChunk objects
  const chunks: DocumentChunk[] = rawChunks.map((chunk, index) => ({
    id: documentId ? `${documentId}-chunk-${index}` : `chunk-${index}-${Date.now()}`,
    content: chunk.content,
    index,
    startOffset: chunk.start,
    endOffset: chunk.end,
  }))

  return {
    chunks,
    totalChunks: chunks.length,
    originalLength: cleanedText.length,
    strategy: "fixed", // Recursive uses multiple strategies
  }
}

/**
 * Sliding window chunking with configurable step size
 * Creates overlapping chunks for better context preservation
 */
export function chunkDocumentSlidingWindow(
  text: string,
  options: {
    windowSize?: number
    stepSize?: number
    preserveWords?: boolean
  } = {},
  documentId?: string
): ChunkingResult {
  const { windowSize = 1000, stepSize = 500, preserveWords = true } = options

  const cleanedText = text.replace(/\r\n/g, "\n").trim()

  if (!cleanedText) {
    return { chunks: [], totalChunks: 0, originalLength: 0, strategy: "fixed" }
  }

  const rawChunks: { content: string; start: number; end: number }[] = []
  let start = 0

  while (start < cleanedText.length) {
    let end = Math.min(start + windowSize, cleanedText.length)

    // Adjust to word boundary if requested
    if (preserveWords && end < cleanedText.length) {
      const nextSpace = cleanedText.indexOf(" ", end)
      const prevSpace = cleanedText.lastIndexOf(" ", end)

      if (prevSpace > start + windowSize * 0.5) {
        end = prevSpace
      } else if (nextSpace !== -1 && nextSpace < end + 50) {
        end = nextSpace
      }
    }

    const content = cleanedText.slice(start, end).trim()
    if (content.length > 0) {
      rawChunks.push({ content, start, end })
    }

    start += stepSize

    // Prevent infinite loop
    if (start >= cleanedText.length) break
  }

  const chunks: DocumentChunk[] = rawChunks.map((chunk, index) => ({
    id: documentId ? `${documentId}-chunk-${index}` : `chunk-${index}-${Date.now()}`,
    content: chunk.content,
    index,
    startOffset: chunk.start,
    endOffset: chunk.end,
  }))

  return {
    chunks,
    totalChunks: chunks.length,
    originalLength: cleanedText.length,
    strategy: "fixed",
  }
}

/**
 * Code-aware chunking for source code files
 * Splits by functions, classes, and logical blocks
 */
export function chunkCodeDocument(
  code: string,
  options: {
    language?: "javascript" | "typescript" | "python" | "generic"
    maxChunkSize?: number
    preserveContext?: boolean
  } = {},
  documentId?: string
): ChunkingResult {
  const { language = "generic", maxChunkSize = 2000, preserveContext = true } = options

  const cleanedCode = code.replace(/\r\n/g, "\n")

  if (!cleanedCode.trim()) {
    return { chunks: [], totalChunks: 0, originalLength: 0, strategy: "fixed" }
  }

  // Define patterns based on language
  const patterns: Record<string, RegExp> = {
    javascript:
      /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>|^(export\s+)?class\s+\w+/gm,
    typescript:
      /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>|^(export\s+)?class\s+\w+|^(export\s+)?interface\s+\w+|^(export\s+)?type\s+\w+/gm,
    python: /^(async\s+)?def\s+\w+|^class\s+\w+/gm,
    generic: /^(function|class|def|interface|type|export|public|private|protected)\s+\w+/gm,
  }

  const pattern = patterns[language] || patterns.generic
  const matches: { index: number; match: string }[] = []
  let match

  while ((match = pattern.exec(cleanedCode)) !== null) {
    matches.push({ index: match.index, match: match[0] })
  }

  if (matches.length === 0) {
    // No recognizable code structures, fall back to recursive chunking
    return chunkDocumentRecursive(cleanedCode, { maxChunkSize }, documentId)
  }

  const rawChunks: { content: string; start: number; end: number }[] = []

  // Add content before first match if significant
  if (matches[0].index > 50) {
    const headerContent = cleanedCode.slice(0, matches[0].index).trim()
    if (headerContent.length > 0) {
      rawChunks.push({
        content: headerContent,
        start: 0,
        end: matches[0].index,
      })
    }
  }

  // Process each code block
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i < matches.length - 1 ? matches[i + 1].index : cleanedCode.length
    const content = cleanedCode.slice(start, end).trim()

    // Add context header if preserving context
    if (preserveContext && rawChunks.length > 0) {
      const prevChunk = rawChunks[rawChunks.length - 1]
      const lastLine = prevChunk.content.split("\n").pop() || ""
      if (lastLine.includes("import") || lastLine.includes("export")) {
        // Don't add import context
      }
    }

    // Split large blocks
    if (content.length > maxChunkSize) {
      const subChunks = chunkDocumentRecursive(
        content,
        {
          maxChunkSize,
          separators: ["\n\n", "\n", "  "],
        },
        documentId
      )

      for (const subChunk of subChunks.chunks) {
        rawChunks.push({
          content: subChunk.content,
          start: start + subChunk.startOffset,
          end: start + subChunk.endOffset,
        })
      }
    } else if (content.length > 0) {
      rawChunks.push({ content, start, end })
    }
  }

  const chunks: DocumentChunk[] = rawChunks.map((chunk, index) => ({
    id: documentId ? `${documentId}-chunk-${index}` : `chunk-${index}-${Date.now()}`,
    content: chunk.content,
    index,
    startOffset: chunk.start,
    endOffset: chunk.end,
    metadata: { language },
  }))

  return {
    chunks,
    totalChunks: chunks.length,
    originalLength: cleanedCode.length,
    strategy: "semantic",
  }
}
