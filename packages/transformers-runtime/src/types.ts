/** Browser-only Transformers.js runtime contracts. This module has no runtime imports. */

export type TransformersDevice = "wasm" | "webgpu"
export type TransformersDtype = "fp32" | "fp16" | "q8" | "q4"

export type TransformersTask =
  | "automatic-speech-recognition"
  | "depth-estimation"
  | "feature-extraction"
  | "fill-mask"
  | "image-classification"
  | "image-segmentation"
  | "image-to-text"
  | "object-detection"
  | "question-answering"
  | "sentence-similarity"
  | "summarization"
  | "text-classification"
  | "text-generation"
  | "text-to-speech"
  | "text2text-generation"
  | "token-classification"
  | "translation"
  | "zero-shot-classification"

export type TransformersErrorCode =
  | "runtime_unavailable"
  | "worker_unavailable"
  | "worker_runtime_error"
  | "request_timeout"
  | "manager_disposed"
  | "invalid_request"
  | "model_load_failed"
  | "out_of_memory"
  | (string & {})

export interface TransformersCachePolicy {
  enabled?: boolean
  maxCachedModels?: number
}

export interface TransformersRequestOptions {
  device?: TransformersDevice
  dtype?: TransformersDtype
  timeoutMs?: number
  cache?: TransformersCachePolicy
  onProgress?: (progress: TransformersModelProgress) => void
}

export interface TransformersInferenceOptions extends TransformersRequestOptions {
  topK?: number
  temperature?: number
  maxNewTokens?: number
  maxLength?: number
  language?: string
  returnTimestamps?: boolean | "word"
  candidateLabels?: string[]
  hypothesisTemplate?: string
}

export interface TransformersEmbeddingOptions extends TransformersRequestOptions {
  pooling?: "mean" | "cls" | "max"
  normalize?: boolean
  batchSize?: number
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

export interface TransformersInferenceResult<T = unknown> {
  task: TransformersTask
  modelId: string
  output: T
  duration: number
}

export interface TransformersLoadedModel {
  task: TransformersTask
  modelId: string
  device: TransformersDevice
  dtype: TransformersDtype
  loadedAt: number
  lastUsedAt: number
}

export interface TransformersRuntimeStatus {
  workerAlive: boolean
  models: TransformersLoadedModel[]
}

export interface TransformersCapabilities {
  available: boolean
  worker: boolean
  webgpu: boolean
  wasm: true
  recommendedDevice: TransformersDevice
}

export interface TransformersModelProgress {
  task?: TransformersTask
  modelId: string
  status: "initiating" | "downloading" | "loading" | "ready"
  progress: number
  loaded?: number
  total?: number
  file?: string
}

interface WorkerRuntimeConfig {
  task: TransformersTask
  modelId: string
  device: TransformersDevice
  dtype: TransformersDtype
  cache: Required<TransformersCachePolicy>
}

export interface TransformersWorkerEmbedRequest {
  id: string
  type: "embed"
  payload: Omit<WorkerRuntimeConfig, "task"> & {
    texts: string[]
    pooling: "mean" | "cls" | "max"
    normalize: boolean
  }
}

export interface TransformersWorkerLoadRequest {
  id: string
  type: "load"
  payload: WorkerRuntimeConfig
}

export interface TransformersWorkerInferRequest {
  id: string
  type: "infer"
  payload: WorkerRuntimeConfig & {
    input: unknown
    inferenceOptions: Record<string, unknown>
  }
}

export interface TransformersWorkerDisposeRequest {
  id: string
  type: "dispose"
  payload: { task?: TransformersTask; modelId?: string }
}

export interface TransformersWorkerStatusRequest {
  id: string
  type: "status"
  payload: Record<string, never>
}

export type TransformersWorkerRequest =
  | TransformersWorkerEmbedRequest
  | TransformersWorkerLoadRequest
  | TransformersWorkerInferRequest
  | TransformersWorkerDisposeRequest
  | TransformersWorkerStatusRequest

export type TransformersWorkerResponse =
  | { id: string; type: "progress"; progress: TransformersModelProgress }
  | { id: string; type: "embedding-result"; embeddings: number[][]; duration: number }
  | { id: string; type: "loaded"; model: TransformersLoadedModel }
  | ({ id: string; type: "inference-result" } & TransformersInferenceResult)
  | { id: string; type: "status"; models: TransformersLoadedModel[] }
  | { id: string; type: "disposed" }
  | { id: string; type: "error"; error: string; errorCode: TransformersErrorCode }
