/**
 * Stub for `@/lib/ai/transformers/transformers-manager`.
 *
 * In Cognia, this is a 795-LOC singleton that runs Transformers.js inference
 * inside Web Workers (ONNX WASM runtime). cognia-next does not yet ship the
 * worker pool / model cache infrastructure — when the twin pipeline needs
 * embeddings it goes through the cloud providers in `lib/ai/embedding/embedding.ts`.
 *
 * The stub keeps `lib/vector/embedding.ts` typecheck-clean and surfaces a
 * clear error if a code path actually tries to invoke the local runtime.
 */

import { TRANSFORMERS_RUNTIME_ERROR_MESSAGE } from "@/lib/vector/embedding"

export interface TransformersEmbeddingOptions {
  pooling?: "mean" | "cls" | "max"
  normalize?: boolean
}

export interface TransformersEmbeddingResult {
  embedding: number[]
  modelId: string
  dimension: number
  duration: number
}

export interface TransformersBatchEmbeddingResult {
  embeddings: number[][]
  modelId: string
  dimension: number
  duration: number
}

export class TransformersManager {
  async generateEmbedding(
    _text: string,
    _modelId: string,
    _options?: TransformersEmbeddingOptions
  ): Promise<TransformersEmbeddingResult> {
    throw new Error(TRANSFORMERS_RUNTIME_ERROR_MESSAGE)
  }

  async generateEmbeddings(
    _texts: string[],
    _modelId: string,
    _options?: TransformersEmbeddingOptions
  ): Promise<TransformersBatchEmbeddingResult> {
    throw new Error(TRANSFORMERS_RUNTIME_ERROR_MESSAGE)
  }
}

let _instance: TransformersManager | null = null

export function getTransformersManager(): TransformersManager {
  if (!_instance) _instance = new TransformersManager()
  return _instance
}
