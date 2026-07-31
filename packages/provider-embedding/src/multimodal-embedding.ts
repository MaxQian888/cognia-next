/**
 * Multimodal Embedding Utilities
 * Deterministic hashing-based embeddings for text/image placeholders.
 */

export interface MultimodalEmbeddingConfig {
  dimension?: number
}

export interface MultimodalEmbeddingInput {
  text?: string
  image?: string | ArrayBuffer
}

const DEFAULT_DIMENSION = 512

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

function hashToVector(seed: string, dimension: number): number[] {
  const vector = new Array(dimension).fill(0)
  const hash = hashString(seed)
  const idx = hash % dimension
  vector[idx] = 1
  return vector
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) || 1
  return vector.map((v) => v / norm)
}

export function generateTextEmbedding(
  text: string,
  config: MultimodalEmbeddingConfig = {}
): number[] {
  const dimension = config.dimension ?? DEFAULT_DIMENSION
  return normalize(hashToVector(text, dimension))
}

export function generateImageEmbedding(
  image: string | ArrayBuffer,
  config: MultimodalEmbeddingConfig = {}
): number[] {
  const dimension = config.dimension ?? DEFAULT_DIMENSION
  const seed = typeof image === "string" ? image : String(image.byteLength || 0)
  return normalize(hashToVector(seed, dimension))
}

export function generateMultimodalEmbedding(
  input: MultimodalEmbeddingInput,
  config: MultimodalEmbeddingConfig = {}
): number[] {
  const dimension = config.dimension ?? DEFAULT_DIMENSION
  const components: number[][] = []

  if (input.text) {
    components.push(generateTextEmbedding(input.text, { dimension }))
  }
  if (input.image) {
    components.push(generateImageEmbedding(input.image, { dimension }))
  }

  if (components.length === 0) {
    return normalize(new Array(dimension).fill(0))
  }

  const blended = new Array(dimension).fill(0)
  for (const vector of components) {
    for (let i = 0; i < dimension; i++) {
      blended[i] += vector[i]
    }
  }

  return normalize(blended)
}
