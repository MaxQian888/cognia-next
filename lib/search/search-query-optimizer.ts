/**
 * Search Query Optimizer
 * Extracts focused search queries from user messages for better search results
 */

const MAX_QUERY_LENGTH = 300

const FILLER_PATTERNS = [
  /^(please|can you|could you|would you|help me|I want to|I need to|I'd like to|tell me about|explain|describe|what is|what are)\s+/i,
  /^(请|帮我|我想|我需要|告诉我|解释一下|说明|介绍)\s*/,
  /\s*(thanks|thank you|please|谢谢|拜托)\s*$/i,
]

const SEARCH_INTENT_PATTERNS = [
  /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should)\b/i,
  /\?$/,
  /^(什么|谁|哪里|哪个|何时|为什么|怎么|如何|是否)/,
  /？$/,
]

export function optimizeSearchQuery(message: string): string {
  if (!message || message.trim().length === 0) {
    return ""
  }

  const query = message.trim()

  if (query.length <= MAX_QUERY_LENGTH) {
    return cleanQuery(query)
  }

  const extracted = extractCoreQuery(query)
  if (extracted && extracted.length > 10 && extracted.length <= MAX_QUERY_LENGTH) {
    return cleanQuery(extracted)
  }

  const firstSentence = extractFirstSentence(query)
  if (firstSentence && firstSentence.length <= MAX_QUERY_LENGTH) {
    return cleanQuery(firstSentence)
  }

  return cleanQuery(truncateAtWordBoundary(query, MAX_QUERY_LENGTH))
}

function cleanQuery(query: string): string {
  let cleaned = query

  for (const pattern of FILLER_PATTERNS) {
    cleaned = cleaned.replace(pattern, "")
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim()
  cleaned = cleaned.replace(/[.。!！]+$/, "").trim()

  return cleaned || query.trim()
}

function extractCoreQuery(message: string): string | null {
  const sentences = message.split(/(?<=[.。!！?？\n])\s*/)

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (trimmed.length < 5) continue

    for (const pattern of SEARCH_INTENT_PATTERNS) {
      if (pattern.test(trimmed)) {
        return trimmed
      }
    }
  }

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (trimmed.length >= 10) {
      return trimmed
    }
  }

  return null
}

function extractFirstSentence(text: string): string | null {
  const match = text.match(/^[^.。!！?？\n]+[.。!！?？]?/)
  return match ? match[0].trim() : null
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text

  const truncated = text.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(" ")

  if (lastSpace > maxLength * 0.5) {
    return truncated.slice(0, lastSpace)
  }

  return truncated
}

export function isSearchRelevantQuery(message: string): boolean {
  if (!message || message.length < 5) return false

  const lower = message.toLowerCase()

  const webSearchPatterns = [
    /\b(latest|recent|current|today|now|new|updated?|breaking)\b/i,
    /(最新|最近|当前|今天|现在|更新|新闻)/,
    /\b(price|stock|weather|score|result|release|version)\b/i,
    /(价格|股票|天气|比分|结果|发布|版本)/,
    /\b(20\d{2})\b/,
    /\b(how to|tutorial|guide|example|documentation)\b/i,
    /(教程|指南|示例|文档|怎么)/,
    /\b(vs|versus|compare|comparison|difference|alternative)\b/i,
    /(对比|比较|区别|替代)/,
    /\b(news|event|announcement|update)\b/i,
  ]

  return webSearchPatterns.some((pattern) => pattern.test(lower))
}
