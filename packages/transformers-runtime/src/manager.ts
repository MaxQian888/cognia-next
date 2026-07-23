/**
 * Lazy browser model runtime backed by Transformers.js in a Web Worker.
 * Importing or constructing this manager does not create a worker or load ONNX.
 */

import type {
  TransformersBatchEmbeddingResult,
  TransformersCachePolicy,
  TransformersDevice,
  TransformersEmbeddingOptions,
  TransformersEmbeddingResult,
  TransformersErrorCode,
  TransformersInferenceOptions,
  TransformersInferenceResult,
  TransformersLoadedModel,
  TransformersRequestOptions,
  TransformersRuntimeStatus,
  TransformersTask,
  TransformersWorkerRequest,
  TransformersWorkerResponse,
} from "./types"

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_BATCH_SIZE = 16
const DEFAULT_MAX_CACHED_MODELS = 2
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000

type CompletedResponse = Exclude<TransformersWorkerResponse, { type: "progress" | "error" }>
type RequestWithoutId = TransformersWorkerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never

interface PendingRequest {
  resolve: (response: CompletedResponse) => void
  reject: (error: unknown) => void
  onProgress?: TransformersRequestOptions["onProgress"]
  timeout: ReturnType<typeof setTimeout>
}

export class TransformersManagerError extends Error {
  readonly code: TransformersErrorCode
  readonly cause?: unknown

  constructor(message: string, code: TransformersErrorCode, cause?: unknown) {
    super(message)
    this.name = "TransformersManagerError"
    this.code = code
    this.cause = cause
  }
}

export class TransformersManager {
  private worker: Worker | null = null
  private pending = new Map<string, PendingRequest>()
  private requestCounter = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  get isWorkerAlive(): boolean {
    return this.worker !== null
  }

  async loadModel(
    task: TransformersTask,
    modelId: string,
    options?: TransformersRequestOptions
  ): Promise<TransformersLoadedModel> {
    assertTaskAndModel(task, modelId)
    const response = await this.send(
      { type: "load", payload: { task, modelId, ...runtimeConfig(options) } },
      options
    )
    if (response.type !== "loaded") throw unexpectedResponse("loaded", response.type)
    return response.model
  }

  async infer<T = unknown>(
    task: TransformersTask,
    modelId: string,
    input: unknown,
    options?: TransformersInferenceOptions
  ): Promise<TransformersInferenceResult<T>> {
    assertTaskAndModel(task, modelId)
    if (input === undefined || input === null) {
      throw new TransformersManagerError("Inference input is required", "invalid_request")
    }
    const response = await this.send(
      {
        type: "infer",
        payload: {
          task,
          modelId,
          input,
          inferenceOptions: normalizeInferenceOptions(options),
          ...runtimeConfig(options),
        },
      },
      options
    )
    if (response.type !== "inference-result") {
      throw unexpectedResponse("inference-result", response.type)
    }
    return response as TransformersInferenceResult<T>
  }

  async generateEmbedding(
    text: string,
    modelId: string,
    options?: TransformersEmbeddingOptions
  ): Promise<TransformersEmbeddingResult> {
    const result = await this.generateEmbeddings([text], modelId, { ...options, batchSize: 1 })
    const embedding = result.embeddings[0]
    if (!embedding) {
      throw new TransformersManagerError(
        "Transformers.js returned no embedding for the input",
        "worker_runtime_error"
      )
    }
    return { embedding, modelId, dimension: embedding.length, duration: result.duration }
  }

  async generateEmbeddings(
    texts: string[],
    modelId: string,
    options?: TransformersEmbeddingOptions
  ): Promise<TransformersBatchEmbeddingResult> {
    if (texts.length === 0) return { embeddings: [], modelId, dimension: 0, duration: 0 }
    assertTaskAndModel("feature-extraction", modelId)

    const batchSize = Math.max(1, Math.floor(options?.batchSize ?? DEFAULT_BATCH_SIZE))
    const embeddings: number[][] = []
    let duration = 0

    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize)
      const response = await this.send(
        {
          type: "embed",
          payload: {
            texts: batch,
            modelId,
            pooling: options?.pooling ?? "mean",
            normalize: options?.normalize ?? true,
            ...runtimeConfig(options),
          },
        },
        options
      )
      if (response.type !== "embedding-result" || response.embeddings.length !== batch.length) {
        const received = response.type === "embedding-result" ? response.embeddings.length : 0
        throw new TransformersManagerError(
          `Transformers.js returned ${received} embeddings for ${batch.length} inputs`,
          "worker_runtime_error"
        )
      }
      embeddings.push(...response.embeddings)
      duration += response.duration
    }

    return { embeddings, modelId, dimension: embeddings[0]?.length ?? 0, duration }
  }

  async getStatus(): Promise<TransformersRuntimeStatus> {
    if (!this.worker) return { workerAlive: false, models: [] }
    const response = await this.send({ type: "status", payload: {} })
    if (response.type !== "status") throw unexpectedResponse("status", response.type)
    return { workerAlive: true, models: response.models }
  }

  async disposeModel(task: TransformersTask, modelId: string): Promise<void> {
    if (!this.worker) return
    const response = await this.send({ type: "dispose", payload: { task, modelId } })
    if (response.type !== "disposed") throw unexpectedResponse("disposed", response.type)
  }

  async dispose(): Promise<void> {
    if (!this.worker) return
    const response = await this.send({ type: "dispose", payload: {} })
    if (response.type !== "disposed") throw unexpectedResponse("disposed", response.type)
    this.terminateWorker()
  }

  /** Release runtime memory while keeping this manager reusable. */
  reset(): void {
    this.terminateWorker(
      new TransformersManagerError("Transformers.js manager reset", "manager_disposed")
    )
  }

  private send(
    request: RequestWithoutId,
    options?: Pick<TransformersRequestOptions, "timeoutMs" | "onProgress">
  ): Promise<CompletedResponse> {
    const id = `transformers_${++this.requestCounter}_${Date.now()}`
    const worker = this.ensureWorker()
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new TransformersManagerError(
            `Transformers.js request timed out after ${timeoutMs}ms`,
            "request_timeout"
          )
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, onProgress: options?.onProgress, timeout })
      worker.postMessage({ ...request, id })
    })
  }

  private ensureWorker(): Worker {
    if (typeof Worker === "undefined") {
      throw new TransformersManagerError(
        "Transformers.js requires a browser with Web Worker support",
        "worker_unavailable"
      )
    }
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
      this.worker.addEventListener("message", this.handleMessage)
      this.worker.addEventListener("error", this.handleWorkerError)
    }
    this.resetIdleTimer()
    return this.worker
  }

  private handleMessage = (event: MessageEvent<TransformersWorkerResponse>): void => {
    const response = event.data
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.resetIdleTimer()
    if (response.type === "progress") {
      pending.onProgress?.(response.progress)
      return
    }
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    if (response.type === "error") {
      pending.reject(new TransformersManagerError(response.error, response.errorCode))
      return
    }
    pending.resolve(response)
  }

  private handleWorkerError = (event: ErrorEvent): void => {
    this.terminateWorker(
      new TransformersManagerError(
        `Transformers.js worker failed: ${event.message}`,
        "worker_runtime_error",
        event
      )
    )
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.terminateWorker()
    }, WORKER_IDLE_TIMEOUT_MS)
  }

  private terminateWorker(error?: TransformersManagerError): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.worker?.terminate()
    this.worker = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(
        error ??
          new TransformersManagerError("Transformers.js worker terminated", "manager_disposed")
      )
    }
    this.pending.clear()
  }
}

function runtimeConfig(options?: TransformersRequestOptions): {
  device: TransformersDevice
  dtype: "fp32" | "fp16" | "q8" | "q4"
  cache: Required<TransformersCachePolicy>
} {
  return {
    device: options?.device ?? getDefaultDevice(),
    dtype: options?.dtype ?? "q8",
    cache: {
      enabled: options?.cache?.enabled ?? true,
      maxCachedModels: Math.max(
        1,
        Math.floor(options?.cache?.maxCachedModels ?? DEFAULT_MAX_CACHED_MODELS)
      ),
    },
  }
}

function normalizeInferenceOptions(
  options?: TransformersInferenceOptions
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  if (options?.topK !== undefined) normalized.top_k = options.topK
  if (options?.temperature !== undefined) normalized.temperature = options.temperature
  if (options?.maxNewTokens !== undefined) normalized.max_new_tokens = options.maxNewTokens
  if (options?.maxLength !== undefined) normalized.max_length = options.maxLength
  if (options?.language !== undefined) normalized.language = options.language
  if (options?.returnTimestamps !== undefined) {
    normalized.return_timestamps = options.returnTimestamps
  }
  if (options?.candidateLabels !== undefined) normalized.candidate_labels = options.candidateLabels
  if (options?.hypothesisTemplate !== undefined) {
    normalized.hypothesis_template = options.hypothesisTemplate
  }
  return normalized
}

function assertTaskAndModel(task: TransformersTask, modelId: string): void {
  if (!task || !modelId.trim()) {
    throw new TransformersManagerError("A task and model ID are required", "invalid_request")
  }
}

function unexpectedResponse(expected: string, received: string): TransformersManagerError {
  return new TransformersManagerError(
    `Expected Transformers.js ${expected} response, received ${received}`,
    "worker_runtime_error"
  )
}

function getDefaultDevice(): TransformersDevice {
  return typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm"
}

let instance: TransformersManager | null = null

export function getTransformersManager(): TransformersManager {
  instance ??= new TransformersManager()
  return instance
}

/** Test-only escape hatch. */
export function __resetTransformersManagerForTest(): void {
  instance?.reset()
  instance = null
}
