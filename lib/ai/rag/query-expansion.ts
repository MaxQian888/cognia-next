/**
 * Query Expansion Module
 *
 * Implements query enhancement strategies for better retrieval:
 * - Multi-query generation (HyDE, query variants)
 * - Synonym expansion
 * - Query rewriting
 * - Hypothetical Document Embedding (HyDE)
 */

import type { LanguageModel } from "ai"
import { loggers } from "@/lib/logger"

const log = loggers.ai

export interface QueryExpansionConfig {
  model?: LanguageModel
  maxVariants?: number
  includeSynonyms?: boolean
  includeHypotheticalAnswer?: boolean
  language?: string
}

export interface ExpandedQuery {
  original: string
  variants: string[]
  keywords: string[]
  hypotheticalAnswer?: string
  rewrittenQuery?: string
}

/**
 * Generate query variants using LLM
 */
export async function generateQueryVariants(
  query: string,
  model: LanguageModel,
  options: {
    count?: number
    context?: string
  } = {}
): Promise<string[]> {
  const { count = 3, context } = options
  const { generateText } = await import("ai")

  const contextSection = context ? `\nContext about the knowledge base: ${context}\n` : ""

  const prompt = `Generate ${count} alternative phrasings of this search query that would help find relevant information. Each variant should:
1. Preserve the core intent
2. Use different keywords or phrasing
3. Be self-contained search queries
${contextSection}
Original query: "${query}"

Return ONLY a JSON array of strings with the alternative queries. Example: ["query1", "query2", "query3"]`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.7,
    })

    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const variants = JSON.parse(jsonMatch[0]) as string[]
      return variants.filter((v) => typeof v === "string" && v.length > 0)
    }
    return []
  } catch (error) {
    log.warn("Failed to generate query variants", { error: String(error) })
    return []
  }
}

/**
 * Hypothetical Document Embedding (HyDE)
 * Generates a hypothetical answer that would contain the information being searched for
 */
export async function generateHypotheticalAnswer(
  query: string,
  model: LanguageModel,
  options: {
    domain?: string
    maxLength?: number
  } = {}
): Promise<string> {
  const { domain, maxLength = 300 } = options
  const { generateText } = await import("ai")

  const domainContext = domain ? `Domain: ${domain}\n` : ""

  const prompt = `${domainContext}Write a short passage (${maxLength} characters max) that would be a perfect answer to this question. Write as if you're excerpting from a document that directly answers the question.

Question: "${query}"

Write the hypothetical passage that answers this question:`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.3,
    })

    return result.text.trim().slice(0, maxLength)
  } catch (error) {
    log.warn("Failed to generate hypothetical answer", { error: String(error) })
    return ""
  }
}

/**
 * Rewrite query for better retrieval
 */
export async function rewriteQuery(
  query: string,
  model: LanguageModel,
  options: {
    style?: "concise" | "detailed" | "technical" | "simple"
    context?: string
  } = {}
): Promise<string> {
  const { style = "concise", context } = options
  const { generateText } = await import("ai")

  const styleInstructions = {
    concise: "Make it shorter and more focused on key terms",
    detailed: "Expand with more specific terms and context",
    technical: "Use more technical/domain-specific terminology",
    simple: "Simplify to basic, common terms",
  }

  const contextSection = context ? `\nRelevant context: ${context}\n` : ""

  const prompt = `Rewrite this search query to improve retrieval results.
${styleInstructions[style]}
${contextSection}
Original: "${query}"

Rewritten query (output ONLY the rewritten query, nothing else):`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.3,
    })

    return result.text.trim().replace(/^["']|["']$/g, "")
  } catch (error) {
    log.warn("Failed to rewrite query", { error: String(error) })
    return query
  }
}

/**
 * Extract keywords from query
 */
export function extractKeywords(query: string): string[] {
  // Common stop words to filter out
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "up",
    "about",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "s",
    "t",
    "just",
    "don",
    "now",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "these",
    "those",
    "am",
    "it",
    "its",
    "and",
    "but",
    "if",
    "or",
    "because",
    "as",
    "until",
    "while",
    "although",
    "though",
    "after",
    "before",
    "unless",
    "i",
    "me",
    "my",
    "myself",
    "we",
    "our",
    "ours",
    "ourselves",
    "you",
    "your",
    "yours",
    "yourself",
    "yourselves",
    "he",
    "him",
    "his",
    "himself",
    "she",
    "her",
    "hers",
    "herself",
    "they",
    "them",
    "their",
    "theirs",
  ])

  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))

  // Deduplicate
  return [...new Set(words)]
}

/**
 * Generate synonyms for keywords (lightweight, rule-based)
 */
export function generateSynonyms(keywords: string[]): Map<string, string[]> {
  // Common synonym mappings
  const synonymMap: Record<string, string[]> = {
    create: ["make", "build", "generate", "develop", "produce"],
    delete: ["remove", "erase", "clear", "destroy"],
    update: ["modify", "change", "edit", "revise", "alter"],
    get: ["retrieve", "fetch", "obtain", "acquire"],
    find: ["search", "locate", "discover", "look for"],
    show: ["display", "present", "reveal", "demonstrate"],
    use: ["utilize", "employ", "apply", "leverage"],
    add: ["insert", "include", "append", "attach"],
    start: ["begin", "initiate", "launch", "commence"],
    stop: ["end", "halt", "terminate", "cease"],
    error: ["bug", "issue", "problem", "fault", "defect"],
    fix: ["repair", "solve", "resolve", "correct"],
    fast: ["quick", "rapid", "speedy", "efficient"],
    slow: ["sluggish", "delayed", "laggy"],
    big: ["large", "huge", "massive", "enormous"],
    small: ["tiny", "little", "compact", "minimal"],
    new: ["recent", "latest", "fresh", "modern"],
    old: ["legacy", "outdated", "previous", "former"],
    good: ["excellent", "great", "best", "optimal"],
    bad: ["poor", "wrong", "incorrect", "invalid"],
    help: ["assist", "support", "guide", "aid"],
    config: ["configuration", "settings", "options", "preferences"],
    configure: ["setup", "set up", "customize"],
    install: ["setup", "deploy", "implement"],
    file: ["document", "data", "resource"],
    function: ["method", "procedure", "operation", "routine"],
    api: ["interface", "endpoint", "service"],
    database: ["db", "datastore", "storage"],
    user: ["account", "member", "client"],
    authentication: ["auth", "login", "signin", "credentials"],
    authorization: ["permission", "access", "rights"],
  }

  const result = new Map<string, string[]>()

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase()
    if (synonymMap[lowerKeyword]) {
      result.set(keyword, synonymMap[lowerKeyword])
    }
  }

  return result
}

/**
 * Expand query with synonyms
 */
export function expandWithSynonyms(query: string): string[] {
  const keywords = extractKeywords(query)
  const synonyms = generateSynonyms(keywords)
  const expansions: string[] = [query]

  for (const [keyword, syns] of synonyms) {
    // Generate a variant for the first synonym of each keyword
    if (syns.length > 0) {
      const variant = query.replace(new RegExp(`\\b${keyword}\\b`, "gi"), syns[0])
      if (variant !== query) {
        expansions.push(variant)
      }
    }
  }

  return expansions
}

/**
 * Full query expansion pipeline
 */
export async function expandQuery(
  query: string,
  config: QueryExpansionConfig = {}
): Promise<ExpandedQuery> {
  const {
    model,
    maxVariants = 3,
    includeSynonyms = true,
    includeHypotheticalAnswer = false,
  } = config

  const result: ExpandedQuery = {
    original: query,
    variants: [],
    keywords: extractKeywords(query),
  }

  // Add synonym expansions
  if (includeSynonyms) {
    const synonymExpansions = expandWithSynonyms(query)
    result.variants.push(...synonymExpansions.slice(1)) // Skip original
  }

  // Generate LLM-based variants if model available
  if (model) {
    const llmVariants = await generateQueryVariants(query, model, {
      count: maxVariants,
    })
    result.variants.push(...llmVariants)

    // Generate hypothetical answer for HyDE
    if (includeHypotheticalAnswer) {
      result.hypotheticalAnswer = await generateHypotheticalAnswer(query, model)
    }

    // Rewrite query
    result.rewrittenQuery = await rewriteQuery(query, model)
  }

  // Deduplicate variants
  result.variants = [...new Set(result.variants)].filter((v) => v !== query)

  return result
}

/**
 * Decompose complex query into sub-queries
 */
export async function decomposeQuery(query: string, model: LanguageModel): Promise<string[]> {
  const { generateText } = await import("ai")

  const prompt = `Decompose this complex question into simpler sub-questions that together would help answer the main question.

Main question: "${query}"

If the question is simple and doesn't need decomposition, return just the original question.
Return ONLY a JSON array of questions. Example: ["sub-question 1", "sub-question 2"]`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.3,
    })

    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const subQueries = JSON.parse(jsonMatch[0]) as string[]
      return subQueries.filter((q) => typeof q === "string" && q.length > 0)
    }
    return [query]
  } catch (error) {
    log.warn("Failed to decompose query", { error: String(error) })
    return [query]
  }
}

/**
 * Generate step-back query for broader context
 */
export async function generateStepBackQuery(query: string, model: LanguageModel): Promise<string> {
  const { generateText } = await import("ai")

  const prompt = `Generate a more general "step-back" question that would provide useful background context for answering the specific question below.

Specific question: "${query}"

The step-back question should ask about broader concepts, principles, or background knowledge that would help answer the specific question.

Step-back question (output ONLY the question):`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.3,
    })

    return result.text.trim().replace(/^["']|["']$/g, "")
  } catch (error) {
    log.warn("Failed to generate step-back query", { error: String(error) })
    return query
  }
}

/**
 * Combine results from multiple query variants
 */
export function mergeQueryResults<T extends { id: string; score?: number }>(
  resultSets: T[][],
  options: {
    dedup?: boolean
    maxResults?: number
    scoreAggregation?: "max" | "sum" | "avg"
  } = {}
): T[] {
  const { dedup = true, maxResults = 10, scoreAggregation = "max" } = options

  if (!dedup) {
    return resultSets.flat().slice(0, maxResults)
  }

  // Aggregate scores for duplicates
  const scoreMap = new Map<string, { item: T; scores: number[] }>()

  for (const results of resultSets) {
    for (const item of results) {
      const existing = scoreMap.get(item.id)
      if (existing) {
        existing.scores.push(item.score || 0)
      } else {
        scoreMap.set(item.id, { item, scores: [item.score || 0] })
      }
    }
  }

  // Calculate final scores
  const merged = Array.from(scoreMap.values()).map(({ item, scores }) => {
    let finalScore: number
    switch (scoreAggregation) {
      case "sum":
        finalScore = scores.reduce((a, b) => a + b, 0)
        break
      case "avg":
        finalScore = scores.reduce((a, b) => a + b, 0) / scores.length
        break
      case "max":
      default:
        finalScore = Math.max(...scores)
    }
    return { ...item, score: finalScore }
  })

  return merged.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, maxResults)
}
