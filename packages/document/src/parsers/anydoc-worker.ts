import type { ConvertErrorCode, Format } from "@firecrawl/anydoc-wasm"

export type LegacyOfficeFormat = "doc" | "ppt"

export type AnyDocEngineCode =
  | ConvertErrorCode
  | "formatMismatch"
  | "initFailed"
  | "assetUnavailable"
  | "timeout"
  | "workerCrashed"

export interface AnyDocWorkerRequest {
  type: "parse"
  requestId: string
  bytes: ArrayBuffer
  format: LegacyOfficeFormat
}

export type AnyDocWorkerResponse =
  | {
      type: "success"
      requestId: string
      markdown: string
      detectedFormat: LegacyOfficeFormat
    }
  | {
      type: "failure"
      requestId: string
      engineCode: AnyDocEngineCode
      message: string
      detectedFormat?: Format
    }

interface AnyDocRuntime {
  default: (typeof import("@firecrawl/anydoc-wasm"))["default"]
  formatFromBytes: (typeof import("@firecrawl/anydoc-wasm"))["formatFromBytes"]
  toMarkdownBytes: (typeof import("@firecrawl/anydoc-wasm"))["toMarkdownBytes"]
}

export type AnyDocRuntimeLoader = () => Promise<AnyDocRuntime>

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<AnyDocWorkerRequest>) => void | Promise<void>
  ): void
  postMessage(response: AnyDocWorkerResponse): void
}

const CONVERT_ERROR_CODES = new Set<ConvertErrorCode>([
  "unsupported",
  "malformed",
  "encrypted",
  "resourceLimit",
  "missingPart",
])

class AnyDocRuntimeLoadError extends Error {
  constructor(
    message: string,
    readonly engineCode: "initFailed" | "assetUnavailable",
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "AnyDocRuntimeLoadError"
  }
}

const loadAnyDocRuntime: AnyDocRuntimeLoader = async () => {
  if (typeof WebAssembly === "undefined") {
    throw new AnyDocRuntimeLoadError("WebAssembly is unavailable in this worker", "initFailed")
  }
  try {
    const runtime = await import("@firecrawl/anydoc-wasm")
    await runtime.default()
    return runtime
  } catch (error) {
    throw new AnyDocRuntimeLoadError("Failed to load the AnyDoc WASM asset", "assetUnavailable", {
      cause: error,
    })
  }
}

function failure(
  requestId: string,
  engineCode: AnyDocEngineCode,
  message: string,
  detectedFormat?: Format
): AnyDocWorkerResponse {
  return {
    type: "failure",
    requestId,
    engineCode,
    message,
    ...(detectedFormat ? { detectedFormat } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function convertErrorCode(error: unknown): ConvertErrorCode | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && CONVERT_ERROR_CODES.has(code as ConvertErrorCode)
    ? (code as ConvertErrorCode)
    : undefined
}

export async function handleAnyDocWorkerRequest(
  request: AnyDocWorkerRequest,
  loadRuntime: AnyDocRuntimeLoader = loadAnyDocRuntime
): Promise<AnyDocWorkerResponse> {
  if (
    request?.type !== "parse" ||
    !request.requestId ||
    !(request.bytes instanceof ArrayBuffer) ||
    (request.format !== "doc" && request.format !== "ppt")
  ) {
    return failure(request?.requestId ?? "", "malformed", "Invalid AnyDoc worker request")
  }

  let runtime: AnyDocRuntime
  try {
    runtime = await loadRuntime()
  } catch (error) {
    return failure(
      request.requestId,
      error instanceof AnyDocRuntimeLoadError ? error.engineCode : "initFailed",
      errorMessage(error)
    )
  }

  try {
    const bytes = new Uint8Array(request.bytes)
    const detectedFormat = runtime.formatFromBytes(bytes)
    if (detectedFormat !== request.format) {
      return failure(
        request.requestId,
        "formatMismatch",
        detectedFormat
          ? `File content is ${detectedFormat}, but the filename declares ${request.format}`
          : `File content does not match the declared ${request.format} format`,
        detectedFormat
      )
    }

    return {
      type: "success",
      requestId: request.requestId,
      markdown: runtime.toMarkdownBytes(bytes, detectedFormat),
      detectedFormat,
    }
  } catch (error) {
    return failure(
      request.requestId,
      convertErrorCode(error) ?? "workerCrashed",
      errorMessage(error)
    )
  }
}

export function registerAnyDocWorker(
  scope: WorkerScope,
  loadRuntime: AnyDocRuntimeLoader = loadAnyDocRuntime
): void {
  scope.addEventListener("message", async (event) => {
    scope.postMessage(await handleAnyDocWorkerRequest(event.data, loadRuntime))
  })
}

const globalScope = globalThis as unknown as Partial<WorkerScope>
if (
  !("document" in globalThis) &&
  typeof globalScope.addEventListener === "function" &&
  typeof globalScope.postMessage === "function"
) {
  registerAnyDocWorker(globalScope as WorkerScope)
}
