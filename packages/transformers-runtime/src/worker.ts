/** Dedicated worker for the optional Transformers.js browser runtime. */

import type {
  TransformersDevice,
  TransformersDtype,
  TransformersErrorCode,
  TransformersLoadedModel,
  TransformersModelProgress,
  TransformersTask,
  TransformersWorkerRequest,
  TransformersWorkerResponse,
} from "./types"

interface TensorLike {
  tolist(): unknown
}

interface RuntimePipeline {
  (...args: unknown[]): Promise<unknown>
  dispose?: () => void | Promise<void>
}

type PipelineFactory = (
  task: TransformersTask,
  modelId: string,
  options: {
    device: TransformersDevice
    dtype: TransformersDtype
    progress_callback: (progress: RuntimeProgress) => void
  }
) => Promise<RuntimePipeline>

interface RuntimeProgress {
  status?: string
  progress?: number
  loaded?: number
  total?: number
  file?: string
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TransformersWorkerRequest>) => void | Promise<void>
  ): void
  postMessage(response: TransformersWorkerResponse): void
}

interface CachedPipeline {
  promise: Promise<RuntimePipeline>
  model: TransformersLoadedModel
}

class WorkerRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: TransformersErrorCode
  ) {
    super(message)
  }
}

const scope = self as unknown as WorkerScope
const pipelines = new Map<string, CachedPipeline>()

function cacheKey(
  task: TransformersTask,
  modelId: string,
  device: TransformersDevice,
  dtype: TransformersDtype
): string {
  return `${task}::${modelId}::${device}::${dtype}`
}

function post(response: TransformersWorkerResponse): void {
  scope.postMessage(response)
}

function normalizeProgress(
  task: TransformersTask,
  modelId: string,
  progress: RuntimeProgress
): TransformersModelProgress {
  const status =
    progress.status === "ready" || progress.status === "done"
      ? "ready"
      : progress.status === "loading"
        ? "loading"
        : progress.status === "initiate" || progress.status === "initiating"
          ? "initiating"
          : "downloading"

  return {
    task,
    modelId,
    status,
    progress: progress.progress ?? (status === "ready" ? 100 : 0),
    loaded: progress.loaded,
    total: progress.total,
    file: progress.file,
  }
}

async function getPipeline(
  requestId: string,
  task: TransformersTask,
  modelId: string,
  device: TransformersDevice,
  dtype: TransformersDtype,
  maxCachedModels: number
): Promise<{ pipeline: RuntimePipeline; model: TransformersLoadedModel; key: string }> {
  const key = cacheKey(task, modelId, device, dtype)
  const cached = pipelines.get(key)
  if (cached) {
    cached.model.lastUsedAt = Date.now()
    return { pipeline: await cached.promise, model: cached.model, key }
  }

  await evictToFit(maxCachedModels - 1)
  const now = Date.now()
  const model: TransformersLoadedModel = {
    task,
    modelId,
    device,
    dtype,
    loadedAt: now,
    lastUsedAt: now,
  }
  const loading = (async () => {
    try {
      // This is the only heavy runtime import. It runs after an explicit request,
      // never when the app, package, manager, or worker module starts.
      const runtime = await import("@huggingface/transformers")
      const pipeline = runtime.pipeline as unknown as PipelineFactory
      return await pipeline(task, modelId, {
        device,
        dtype,
        progress_callback: (progress) => {
          post({
            id: requestId,
            type: "progress",
            progress: normalizeProgress(task, modelId, progress),
          })
        },
      })
    } catch (error) {
      throw new WorkerRuntimeError(
        error instanceof Error ? error.message : String(error),
        "model_load_failed"
      )
    }
  })()

  pipelines.set(key, { promise: loading, model })
  try {
    return { pipeline: await loading, model, key }
  } catch (error) {
    pipelines.delete(key)
    throw error
  }
}

async function evictToFit(targetSize: number): Promise<void> {
  while (pipelines.size > Math.max(0, targetSize)) {
    const oldest = [...pipelines.entries()].sort(
      ([, a], [, b]) => a.model.lastUsedAt - b.model.lastUsedAt
    )[0]
    if (!oldest) return
    pipelines.delete(oldest[0])
    const pipeline = await oldest[1].promise.catch(() => undefined)
    await pipeline?.dispose?.()
  }
}

function parseEmbeddings(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value)) {
    throw new WorkerRuntimeError(
      "Transformers.js returned a non-array tensor",
      "worker_runtime_error"
    )
  }
  const rows = value.length > 0 && typeof value[0] === "number" ? [value] : value
  if (
    rows.length !== expectedCount ||
    !rows.every(
      (row) => Array.isArray(row) && row.length > 0 && row.every((item) => typeof item === "number")
    )
  ) {
    throw new WorkerRuntimeError(
      "Transformers.js returned an invalid embedding tensor",
      "worker_runtime_error"
    )
  }
  return rows as number[][]
}

function toTransferableOutput(output: unknown): unknown {
  if (isTensorLike(output)) return output.tolist()
  if (Array.isArray(output)) return output.map(toTransferableOutput)
  if (output && typeof output === "object") {
    return Object.fromEntries(
      Object.entries(output).map(([key, value]) => [key, toTransferableOutput(value)])
    )
  }
  return output
}

function isTensorLike(value: unknown): value is TensorLike {
  return Boolean(
    value &&
    typeof value === "object" &&
    "tolist" in value &&
    typeof (value as TensorLike).tolist === "function"
  )
}

const REMOTE_MEDIA_TASKS = new Set<TransformersTask>([
  "automatic-speech-recognition",
  "depth-estimation",
  "image-classification",
  "image-segmentation",
  "image-to-text",
  "object-detection",
])

function containsRemoteUrl(value: unknown): boolean {
  if (typeof value === "string") return /^https?:\/\//i.test(value.trim())
  if (Array.isArray(value)) return value.some(containsRemoteUrl)
  if (value && typeof value === "object") return Object.values(value).some(containsRemoteUrl)
  return false
}

async function disposePipelines(task?: TransformersTask, modelId?: string): Promise<void> {
  const selected = [...pipelines.entries()].filter(([, entry]) => {
    return (!task || entry.model.task === task) && (!modelId || entry.model.modelId === modelId)
  })
  for (const [key] of selected) pipelines.delete(key)
  await Promise.all(
    selected.map(async ([, entry]) => {
      const pipeline = await entry.promise.catch(() => undefined)
      await pipeline?.dispose?.()
    })
  )
}

scope.addEventListener("message", async (event) => {
  const request = event.data
  const requestId = request?.id ?? ""

  try {
    if (!requestId || !request.type) {
      throw new WorkerRuntimeError("Invalid Transformers.js worker request", "invalid_request")
    }

    if (request.type === "status") {
      post({
        id: requestId,
        type: "status",
        models: [...pipelines.values()].map(({ model }) => model),
      })
      return
    }

    if (request.type === "dispose") {
      await disposePipelines(request.payload.task, request.payload.modelId)
      post({ id: requestId, type: "disposed" })
      return
    }

    const { modelId, device, dtype } = request.payload
    const cache = request.payload.cache ?? { enabled: true, maxCachedModels: 2 }
    const task = request.type === "embed" ? "feature-extraction" : request.payload.task
    if (!modelId) {
      throw new WorkerRuntimeError("A model ID is required", "invalid_request")
    }
    if (
      request.type === "infer" &&
      REMOTE_MEDIA_TASKS.has(task) &&
      containsRemoteUrl(request.payload.input)
    ) {
      throw new WorkerRuntimeError(
        "Remote media URLs are disabled; pass local bytes, a Blob, or a data URL",
        "invalid_request"
      )
    }

    const loaded = await getPipeline(requestId, task, modelId, device, dtype, cache.maxCachedModels)

    if (request.type === "load") {
      post({ id: requestId, type: "loaded", model: loaded.model })
      return
    }

    const start = performance.now()
    if (request.type === "embed") {
      if (request.payload.texts.length === 0) {
        throw new WorkerRuntimeError("Embedding text is required", "invalid_request")
      }
      const output = await loaded.pipeline(request.payload.texts, {
        pooling: request.payload.pooling,
        normalize: request.payload.normalize,
      })
      if (!isTensorLike(output)) {
        throw new WorkerRuntimeError(
          "Transformers.js returned a non-tensor embedding",
          "worker_runtime_error"
        )
      }
      post({
        id: requestId,
        type: "embedding-result",
        embeddings: parseEmbeddings(output.tolist(), request.payload.texts.length),
        duration: performance.now() - start,
      })
    } else {
      const { candidate_labels: candidateLabels, ...inferenceOptions } =
        request.payload.inferenceOptions
      const args = candidateLabels
        ? [request.payload.input, candidateLabels, inferenceOptions]
        : [request.payload.input, inferenceOptions]
      const output = await loaded.pipeline(...args)
      post({
        id: requestId,
        type: "inference-result",
        task,
        modelId,
        output: toTransferableOutput(output),
        duration: performance.now() - start,
      })
    }

    if (!cache.enabled) await disposePipelines(task, modelId)
  } catch (error) {
    const runtimeError =
      error instanceof WorkerRuntimeError
        ? error
        : new WorkerRuntimeError(
            error instanceof Error ? error.message : String(error),
            "worker_runtime_error"
          )
    post({
      id: requestId,
      type: "error",
      error: runtimeError.message,
      errorCode: runtimeError.code,
    })
  }
})

export {}
