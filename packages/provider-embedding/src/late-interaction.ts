/**
 * Late Interaction (ColBERT-style) scoring utilities.
 * Uses deterministic hashing to approximate token embeddings.
 */

export interface LateInteractionConfig {
  dimension?: number
  maxTokens?: number
}

export interface TokenEmbedding {
  token: string
  vector: number[]
}

const DEFAULT_DIMENSION = 128
const DEFAULT_MAX_TOKENS = 128

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function hashToken(token: string): number {
  let hash = 0
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0
  }
  return hash
}

function tokenToVector(token: string, dimension: number): number[] {
  const vector = new Array(dimension).fill(0)
  const hash = hashToken(token)
  const index = hash % dimension
  vector[index] = 1
  return vector
}

function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i]
  }
  return sum
}

export function embedTokens(text: string, config: LateInteractionConfig = {}): TokenEmbedding[] {
  const dimension = config.dimension ?? DEFAULT_DIMENSION
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const tokens = tokenize(text).slice(0, maxTokens)

  return tokens.map((token) => ({
    token,
    vector: tokenToVector(token, dimension),
  }))
}

export function scoreLateInteraction(
  query: string,
  document: string,
  config: LateInteractionConfig = {}
): number {
  const queryTokens = embedTokens(query, config)
  const docTokens = embedTokens(document, config)
  if (queryTokens.length === 0 || docTokens.length === 0) return 0

  let score = 0
  for (const q of queryTokens) {
    let maxSim = 0
    for (const d of docTokens) {
      const sim = dot(q.vector, d.vector)
      if (sim > maxSim) maxSim = sim
    }
    score += maxSim
  }

  return score / queryTokens.length
}
