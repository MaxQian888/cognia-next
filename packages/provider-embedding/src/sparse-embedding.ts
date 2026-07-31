/**
 * Sparse Embedding Utilities
 * Simple hashing-based sparse vectorization for retrieval.
 */

export interface SparseEmbeddingConfig {
  hashingBuckets?: number
  maxFeatures?: number
  minTermLength?: number
}

export interface SparseVector {
  indices: number[]
  values: number[]
  dimension: number
}

const DEFAULT_CONFIG: Required<SparseEmbeddingConfig> = {
  hashingBuckets: 2048,
  maxFeatures: 128,
  minTermLength: 2,
}

function tokenize(text: string, minTermLength: number): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= minTermLength)
}

function hashTerm(term: string): number {
  let hash = 0
  for (let i = 0; i < term.length; i++) {
    hash = (hash * 31 + term.charCodeAt(i)) >>> 0
  }
  return hash
}

function normalizeSparse(indices: number[], values: number[], dimension: number): SparseVector {
  const norm = Math.sqrt(values.reduce((acc, v) => acc + v * v, 0)) || 1
  return {
    indices,
    values: values.map((v) => v / norm),
    dimension,
  }
}

export function generateSparseEmbedding(
  text: string,
  config: SparseEmbeddingConfig = {}
): SparseVector {
  const settings = { ...DEFAULT_CONFIG, ...config }
  const terms = tokenize(text, settings.minTermLength)
  const termFreq = new Map<string, number>()

  for (const term of terms) {
    termFreq.set(term, (termFreq.get(term) || 0) + 1)
  }

  const buckets = new Map<number, number>()
  for (const [term, freq] of termFreq) {
    const hash = hashTerm(term)
    const index = hash % settings.hashingBuckets
    const weight = Math.log1p(freq)
    buckets.set(index, (buckets.get(index) || 0) + weight)
  }

  const entries = Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, settings.maxFeatures)

  const indices = entries.map(([index]) => index)
  const values = entries.map(([, value]) => value)

  return normalizeSparse(indices, values, settings.hashingBuckets)
}

export async function generateSparseEmbeddings(
  texts: string[],
  config: SparseEmbeddingConfig = {}
): Promise<SparseVector[]> {
  return texts.map((text) => generateSparseEmbedding(text, config))
}

export function sparseCosineSimilarity(a: SparseVector, b: SparseVector): number {
  if (a.indices.length === 0 || b.indices.length === 0) return 0

  let i = 0
  let j = 0
  let dot = 0

  while (i < a.indices.length && j < b.indices.length) {
    const idxA = a.indices[i]
    const idxB = b.indices[j]
    if (idxA === idxB) {
      dot += a.values[i] * b.values[j]
      i++
      j++
    } else if (idxA < idxB) {
      i++
    } else {
      j++
    }
  }

  return dot
}
