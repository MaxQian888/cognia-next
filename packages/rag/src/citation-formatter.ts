/**
 * Citation Formatter
 *
 * Formats search results with proper source citations
 * in various academic and professional styles.
 *
 * Features:
 * - Multiple citation styles (APA, MLA, Chicago, Harvard)
 * - Source attribution formatting
 * - Reference list generation
 * - Inline citation markers
 * - Footnote support
 */

import type { RerankResult } from "./reranker"
import type { VectorSearchResult as SearchResult } from "@cognia/vector"

export type CitationStyle = "apa" | "mla" | "chicago" | "harvard" | "ieee" | "simple"

export interface CitationOptions {
  style: CitationStyle
  includeRelevanceScore: boolean
  includePageNumbers: boolean
  includeTimestamps: boolean
  includeUrls: boolean
  maxCitations: number
  inlineFormat: "number" | "author-date" | "footnote"
}

export interface Citation {
  id: string
  marker: string // e.g., "[1]" or "(Smith, 2023)"
  fullCitation: string
  source: string
  title?: string
  author?: string
  date?: string
  url?: string
  relevanceScore?: number
}

export interface FormattedCitation {
  context: string
  citations: Citation[]
  referenceList: string
  footnotes?: string[]
}

const DEFAULT_OPTIONS: CitationOptions = {
  style: "simple",
  includeRelevanceScore: false,
  includePageNumbers: false,
  includeTimestamps: false,
  includeUrls: true,
  maxCitations: 10,
  inlineFormat: "number",
}

/**
 * Extract metadata from search result
 */
function extractMetadata(result: RerankResult | SearchResult): {
  source: string
  title?: string
  author?: string
  date?: string
  url?: string
  page?: string
} {
  const metadata = result.metadata || {}

  return {
    source: String(metadata.source || metadata.documentId || result.id || "Unknown"),
    title: metadata.title ? String(metadata.title) : undefined,
    author: metadata.author ? String(metadata.author) : undefined,
    date: metadata.date ? String(metadata.date) : undefined,
    url: metadata.url ? String(metadata.url) : undefined,
    page: metadata.page ? String(metadata.page) : undefined,
  }
}

/**
 * Format date for citations
 */
function formatDate(date: string | undefined): string {
  if (!date) return "n.d."

  try {
    const d = new Date(date)
    if (isNaN(d.getTime())) return date
    return d.getFullYear().toString()
  } catch {
    return date
  }
}

/**
 * Generate citation in Simple style
 */
function formatSimpleCitation(
  index: number,
  meta: ReturnType<typeof extractMetadata>,
  options: CitationOptions
): Citation {
  const parts: string[] = []

  if (meta.title) parts.push(meta.title)
  if (meta.source && meta.source !== meta.title) parts.push(`Source: ${meta.source}`)
  if (options.includeUrls && meta.url) parts.push(`URL: ${meta.url}`)

  return {
    id: `cite-${index}`,
    marker: `[${index}]`,
    fullCitation: parts.join(". ") || `Source ${index}`,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    url: meta.url,
  }
}

/**
 * Generate citation in APA style
 */
function formatAPACitation(
  index: number,
  meta: ReturnType<typeof extractMetadata>,
  _options: CitationOptions
): Citation {
  const author = meta.author || "Unknown Author"
  const year = formatDate(meta.date)
  const title = meta.title || "Untitled"

  // APA: Author, A. A. (Year). Title of work. Source.
  const fullCitation = `${author} (${year}). ${title}. ${meta.source}${meta.url ? `. Retrieved from ${meta.url}` : ""}`

  return {
    id: `cite-${index}`,
    marker: `(${author.split(",")[0]}, ${year})`,
    fullCitation,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    url: meta.url,
  }
}

/**
 * Generate citation in MLA style
 */
function formatMLACitation(
  index: number,
  meta: ReturnType<typeof extractMetadata>,
  _options: CitationOptions
): Citation {
  const author = meta.author || "Unknown Author"
  const title = meta.title || "Untitled"

  // MLA: Author. "Title of Work." Source, Year.
  const fullCitation = `${author}. "${title}." ${meta.source}${meta.date ? `, ${formatDate(meta.date)}` : ""}.`

  return {
    id: `cite-${index}`,
    marker: `(${author.split(",")[0]})`,
    fullCitation,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    url: meta.url,
  }
}

/**
 * Generate citation in Chicago style
 */
function formatChicagoCitation(
  index: number,
  meta: ReturnType<typeof extractMetadata>,
  _options: CitationOptions
): Citation {
  const author = meta.author || "Unknown Author"
  const year = formatDate(meta.date)
  const title = meta.title || "Untitled"

  // Chicago: Author. Year. "Title of Work." Source.
  const fullCitation = `${author}. ${year}. "${title}." ${meta.source}.`

  return {
    id: `cite-${index}`,
    marker: `[${index}]`,
    fullCitation,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    url: meta.url,
  }
}

/**
 * Generate citation in Harvard style
 */
function formatHarvardCitation(
  index: number,
  meta: ReturnType<typeof extractMetadata>,
  _options: CitationOptions
): Citation {
  const author = meta.author || "Unknown Author"
  const year = formatDate(meta.date)
  const title = meta.title || "Untitled"

  // Harvard: Author (Year) Title. Source.
  const fullCitation = `${author} (${year}) ${title}. ${meta.source}.`

  return {
    id: `cite-${index}`,
    marker: `(${author.split(",")[0]} ${year})`,
    fullCitation,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    url: meta.url,
  }
}

/**
 * Generate citation in IEEE style
 */
function formatIEEECitation(
  index: number,
  meta: ReturnType<typeof extractMetadata>,
  _options: CitationOptions
): Citation {
  const author = meta.author || "Unknown Author"
  const year = formatDate(meta.date)
  const title = meta.title || "Untitled"

  // IEEE: [1] A. Author, "Title," Source, Year.
  const fullCitation = `[${index}] ${author}, "${title}," ${meta.source}, ${year}.`

  return {
    id: `cite-${index}`,
    marker: `[${index}]`,
    fullCitation,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    url: meta.url,
  }
}

/**
 * Format a single citation based on style
 */
function formatCitation(
  index: number,
  result: RerankResult | SearchResult,
  options: CitationOptions
): Citation {
  const meta = extractMetadata(result)

  let citation: Citation

  switch (options.style) {
    case "apa":
      citation = formatAPACitation(index, meta, options)
      break
    case "mla":
      citation = formatMLACitation(index, meta, options)
      break
    case "chicago":
      citation = formatChicagoCitation(index, meta, options)
      break
    case "harvard":
      citation = formatHarvardCitation(index, meta, options)
      break
    case "ieee":
      citation = formatIEEECitation(index, meta, options)
      break
    case "simple":
    default:
      citation = formatSimpleCitation(index, meta, options)
  }

  // Add relevance score if requested
  if (options.includeRelevanceScore) {
    const score =
      "rerankScore" in result
        ? result.rerankScore
        : "score" in result
          ? (result as SearchResult).score
          : 0
    citation.relevanceScore = score
  }

  return citation
}

/**
 * Format multiple results with citations
 */
export function formatCitations(
  results: (RerankResult | SearchResult)[],
  options: Partial<CitationOptions> = {}
): FormattedCitation {
  const opts: CitationOptions = { ...DEFAULT_OPTIONS, ...options }
  const limitedResults = results.slice(0, opts.maxCitations)

  const citations: Citation[] = limitedResults.map((result, index) =>
    formatCitation(index + 1, result, opts)
  )

  // Build context with inline citations
  const contextParts: string[] = []
  for (let i = 0; i < limitedResults.length; i++) {
    const result = limitedResults[i]
    const citation = citations[i]
    contextParts.push(`${result.content} ${citation.marker}`)
  }
  const context = contextParts.join("\n\n")

  // Build reference list
  const referenceList = citations.map((c) => c.fullCitation).join("\n")

  // Build footnotes if using footnote format
  const footnotes =
    opts.inlineFormat === "footnote"
      ? citations.map((c, i) => `${i + 1}. ${c.fullCitation}`)
      : undefined

  return {
    context,
    citations,
    referenceList,
    footnotes,
  }
}

/**
 * Generate context with embedded citations
 */
export function formatContextWithCitations(
  results: (RerankResult | SearchResult)[],
  options: Partial<CitationOptions> = {}
): string {
  const formatted = formatCitations(results, options)

  return `## Context

${formatted.context}

## References

${formatted.referenceList}`
}

/**
 * Generate a reference list only
 */
export function generateReferenceList(
  results: (RerankResult | SearchResult)[],
  style: CitationStyle = "simple"
): string {
  const opts: CitationOptions = { ...DEFAULT_OPTIONS, style }

  const citations = results.map((result, index) => formatCitation(index + 1, result, opts))

  return citations.map((c) => c.fullCitation).join("\n")
}

/**
 * Add inline citations to text
 */
export function addInlineCitations(
  text: string,
  results: (RerankResult | SearchResult)[],
  options: Partial<CitationOptions> = {}
): string {
  const opts: CitationOptions = { ...DEFAULT_OPTIONS, ...options }

  // Create citation markers
  const citations = results.map((result, index) => formatCitation(index + 1, result, opts))

  // For each result, try to find matching content in text and add citation
  let annotatedText = text

  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i]
    const citation = citations[i]

    // Find the last occurrence of a snippet from this result
    const snippet = result.content.slice(0, 50).trim()
    const snippetIndex = annotatedText.lastIndexOf(snippet)

    if (snippetIndex !== -1) {
      // Find end of sentence or paragraph
      const afterSnippet = annotatedText.slice(snippetIndex + snippet.length)
      const sentenceEnd = afterSnippet.search(/[.!?]\s|$/)
      const insertPos = snippetIndex + snippet.length + sentenceEnd + 1

      annotatedText =
        annotatedText.slice(0, insertPos) + ` ${citation.marker}` + annotatedText.slice(insertPos)
    }
  }

  return annotatedText
}

/**
 * Citation style descriptions
 */
export const CITATION_STYLE_INFO: Record<CitationStyle, { name: string; description: string }> = {
  simple: {
    name: "Simple",
    description: "Basic numbered citations [1], [2], etc.",
  },
  apa: {
    name: "APA (7th Edition)",
    description: "American Psychological Association style (Author, Year)",
  },
  mla: {
    name: "MLA (9th Edition)",
    description: "Modern Language Association style (Author)",
  },
  chicago: {
    name: "Chicago",
    description: "Chicago Manual of Style with numbered citations",
  },
  harvard: {
    name: "Harvard",
    description: "Harvard referencing system (Author Year)",
  },
  ieee: {
    name: "IEEE",
    description: "Institute of Electrical and Electronics Engineers style [1]",
  },
}

/**
 * Get available citation styles
 */
export function getAvailableCitationStyles(): CitationStyle[] {
  return ["simple", "apa", "mla", "chicago", "harvard", "ieee"]
}
