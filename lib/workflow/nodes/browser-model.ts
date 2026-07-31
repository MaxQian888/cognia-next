import type {
  TransformersInferenceOptions,
  TransformersRequestOptions,
  TransformersTask,
} from "@cognia/transformers-runtime/types"
import { hasNoLeakingPii } from "@cognia/redact"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "./registry"

type BrowserModelOperation = "infer" | "preload" | "status" | "disposeModel" | "disposeAll"

interface BrowserModelParams {
  operation?: BrowserModelOperation
  task?: TransformersTask
  modelId?: string
  input?: string
  inputJson?: string
  device?: "wasm" | "webgpu"
  dtype?: "fp32" | "fp16" | "q8" | "q4"
  cacheEnabled?: boolean
  maxCachedModels?: number
  timeoutMs?: number
  topK?: number
  temperature?: number
  maxNewTokens?: number
  maxLength?: number
  language?: string
  returnTimestamps?: boolean | "word"
  candidateLabels?: string[]
  hypothesisTemplate?: string
}

function runtimeOptions(params: BrowserModelParams): TransformersRequestOptions {
  return {
    device: params.device,
    dtype: params.dtype,
    timeoutMs: params.timeoutMs,
    cache: {
      enabled: params.cacheEnabled ?? true,
      maxCachedModels: params.maxCachedModels ?? 2,
    },
  }
}

function inferenceOptions(params: BrowserModelParams): TransformersInferenceOptions {
  return {
    ...runtimeOptions(params),
    topK: params.topK,
    temperature: params.temperature,
    maxNewTokens: params.maxNewTokens,
    maxLength: params.maxLength,
    language: params.language,
    returnTimestamps: params.returnTimestamps,
    candidateLabels: params.candidateLabels,
    hypothesisTemplate: params.hypothesisTemplate,
  }
}

function requireModel(params: BrowserModelParams): {
  task: TransformersTask
  modelId: string
} {
  if (!params.task || !params.modelId?.trim()) {
    throw new Error("ai.browserModel requires 'task' and 'modelId' for this operation")
  }
  const modelId = params.modelId.trim()
  if (
    modelId.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(modelId) ||
    !hasNoLeakingPii(modelId)
  ) {
    throw new Error("ai.browserModel requires a safe Hugging Face model ID")
  }
  return { task: params.task, modelId }
}

function resolveInput(params: BrowserModelParams): unknown {
  if (params.inputJson?.trim()) {
    try {
      return JSON.parse(params.inputJson)
    } catch (error) {
      throw new Error(
        `ai.browserModel inputJson must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (params.input === undefined || params.input === "") {
    throw new Error("ai.browserModel requires 'input' or 'inputJson' for inference")
  }
  return params.input
}

const MEDIA_TASKS = new Set<TransformersTask>([
  "automatic-speech-recognition",
  "depth-estimation",
  "image-classification",
  "image-segmentation",
  "image-to-text",
  "object-detection",
])

function assertLocalMediaInput(task: TransformersTask, input: unknown): void {
  if (MEDIA_TASKS.has(task) && containsRemoteUrl(input)) {
    throw new Error(
      "ai.browserModel remote media URLs are disabled; use local bytes, a Blob, or a data URL"
    )
  }
}

function containsRemoteUrl(value: unknown): boolean {
  if (typeof value === "string") return /^https?:\/\//i.test(value.trim())
  if (Array.isArray(value)) return value.some(containsRemoteUrl)
  if (value && typeof value === "object" && !(value instanceof Blob)) {
    return Object.values(value).some(containsRemoteUrl)
  }
  return false
}

registerNodeExecutor({
  kind: "ai.browserModel",
  typeVersion: 1,
  retryable: false,
  execute: async (context: StepExecutionContext) => {
    const params = context.params as BrowserModelParams
    const operation = params.operation ?? "infer"
    const { getTransformersManager } = await import("@cognia/transformers-runtime")
    const manager = getTransformersManager()

    if (operation === "status") {
      return { output: { operation, ...(await manager.getStatus()) } }
    }
    if (operation === "disposeAll") {
      await manager.dispose()
      return { output: { operation, disposed: true } }
    }

    const { task, modelId } = requireModel(params)
    if (operation === "preload") {
      return {
        output: {
          operation,
          model: await manager.loadModel(task, modelId, runtimeOptions(params)),
        },
      }
    }
    if (operation === "disposeModel") {
      await manager.disposeModel(task, modelId)
      return { output: { operation, disposed: true, task, modelId } }
    }

    const input = resolveInput(params)
    assertLocalMediaInput(task, input)
    const result = await manager.infer(task, modelId, input, inferenceOptions(params))
    return { output: { operation, ...result } }
  },
})
