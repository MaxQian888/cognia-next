import type { Format } from "@firecrawl/anydoc-wasm"

import type { ParseDiagnostic } from "../types"
import type {
  AnyDocEngineCode,
  AnyDocWorkerRequest,
  AnyDocWorkerResponse,
  LegacyOfficeFormat,
} from "./anydoc-worker"

export const ANYDOC_VERSION = "0.1.9"
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 60_000
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_RETAINED_INPUT_BYTES = 20 * 1024 * 1024

export interface AnyDocParseResult {
  markdown: string
  format: LegacyOfficeFormat
  engineVersion: typeof ANYDOC_VERSION
}

export interface AnyDocParseOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface ParseJob {
  requestId: string
  input: ArrayBuffer
  format: LegacyOfficeFormat
  signal?: AbortSignal
  timeoutMs: number
  resolve: (result: AnyDocParseResult) => void
  reject: (error: unknown) => void
  abortHandler?: () => void
}

interface ActiveJob {
  job: ParseJob
  worker: Worker
  timeout: ReturnType<typeof setTimeout>
}

type WorkerFactory = () => Worker

function diagnosticForCode(code: AnyDocEngineCode, message: string): ParseDiagnostic {
  if (code === "encrypted") {
    return { code: "password_protected", severity: "error", message }
  }
  if (code === "unsupported" || code === "initFailed" || code === "assetUnavailable") {
    return { code: "unsupported_feature", severity: "error", message }
  }
  return { code: "parse_failed", severity: "error", message }
}

export class AnyDocParseError extends Error {
  readonly diagnostic: ParseDiagnostic

  constructor(
    message: string,
    readonly engineCode: AnyDocEngineCode,
    readonly detectedFormat?: Format,
    cause?: unknown
  ) {
    super(message)
    this.name = "AnyDocParseError"
    this.diagnostic = diagnosticForCode(engineCode, message)
    if (cause !== undefined) this.cause = cause
  }
}

function createAbortError(reason?: unknown): DOMException {
  const message = reason instanceof Error ? reason.message : "The operation was aborted"
  return new DOMException(message, "AbortError")
}

function createWorker(): Worker {
  if (typeof Worker === "undefined") {
    throw new AnyDocParseError("AnyDoc requires a browser with Web Worker support", "initFailed")
  }
  return new Worker(new URL("./anydoc-worker.ts", import.meta.url), { type: "module" })
}

export class AnyDocParser {
  private readonly queue: ParseJob[] = []
  private active: ActiveJob | null = null
  private requestCounter = 0

  constructor(private readonly workerFactory: WorkerFactory = createWorker) {}

  parse(
    input: ArrayBuffer,
    format: LegacyOfficeFormat,
    options: AnyDocParseOptions = {}
  ): Promise<AnyDocParseResult> {
    if (input.byteLength > MAX_INPUT_BYTES) {
      return Promise.reject(
        new AnyDocParseError(
          `AnyDoc input exceeds the ${MAX_INPUT_BYTES / (1024 * 1024)} MiB admission limit`,
          "resourceLimit"
        )
      )
    }
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError(options.signal.reason))
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (
      !Number.isFinite(timeoutMs) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      return Promise.reject(
        new AnyDocParseError(
          `AnyDoc timeout must be a positive integer no greater than ${MAX_TIMEOUT_MS}ms`,
          "resourceLimit"
        )
      )
    }
    const retainedInputBytes =
      (this.active?.job.input.byteLength ?? 0) +
      this.queue.reduce((total, job) => total + job.input.byteLength, 0)
    if (retainedInputBytes + input.byteLength > MAX_RETAINED_INPUT_BYTES) {
      return Promise.reject(
        new AnyDocParseError(
          `AnyDoc queued input exceeds the ${MAX_RETAINED_INPUT_BYTES / (1024 * 1024)} MiB memory budget`,
          "resourceLimit"
        )
      )
    }

    return new Promise((resolve, reject) => {
      const job: ParseJob = {
        requestId: `anydoc_${++this.requestCounter}`,
        input,
        format,
        signal: options.signal,
        timeoutMs,
        resolve,
        reject,
      }
      if (job.signal) {
        job.abortHandler = () => this.cancel(job, createAbortError(job.signal?.reason))
        job.signal.addEventListener("abort", job.abortHandler, { once: true })
      }
      this.queue.push(job)
      this.startNext()
    })
  }

  private startNext(): void {
    if (this.active) return
    const job = this.queue.shift()
    if (!job) return

    let worker: Worker
    try {
      worker = this.workerFactory()
    } catch (error) {
      this.cleanupJob(job)
      job.reject(
        error instanceof AnyDocParseError
          ? error
          : new AnyDocParseError(
              "Failed to create the AnyDoc worker",
              "initFailed",
              undefined,
              error
            )
      )
      this.startNext()
      return
    }

    const timeout = setTimeout(() => {
      this.finish(
        job,
        new AnyDocParseError(`AnyDoc parse timed out after ${job.timeoutMs}ms`, "timeout")
      )
    }, job.timeoutMs)
    this.active = { job, worker, timeout }

    worker.addEventListener("message", (event: MessageEvent<AnyDocWorkerResponse>) => {
      if (event.data.requestId !== job.requestId) return
      if (event.data.type === "failure") {
        this.finish(
          job,
          new AnyDocParseError(event.data.message, event.data.engineCode, event.data.detectedFormat)
        )
        return
      }
      this.finish(job, undefined, {
        markdown: event.data.markdown,
        format: event.data.detectedFormat,
        engineVersion: ANYDOC_VERSION,
      })
    })
    worker.addEventListener("error", (event: ErrorEvent) => {
      this.finish(
        job,
        new AnyDocParseError(
          event.message || "AnyDoc worker crashed",
          "workerCrashed",
          undefined,
          event
        )
      )
    })

    try {
      const ownedInput = inputCopy(job.input)
      const request: AnyDocWorkerRequest = {
        type: "parse",
        requestId: job.requestId,
        bytes: ownedInput,
        format: job.format,
      }
      worker.postMessage(request, [ownedInput])
    } catch (error) {
      this.finish(
        job,
        new AnyDocParseError(
          "Failed to send the document to the AnyDoc worker",
          "workerCrashed",
          undefined,
          error
        )
      )
    }
  }

  private cancel(job: ParseJob, error: DOMException): void {
    if (this.active?.job === job) {
      this.finish(job, error)
      return
    }
    const queuedIndex = this.queue.indexOf(job)
    if (queuedIndex === -1) return
    this.queue.splice(queuedIndex, 1)
    this.cleanupJob(job)
    job.reject(error)
  }

  private finish(job: ParseJob, error?: unknown, result?: AnyDocParseResult): void {
    if (this.active?.job !== job) return
    const active = this.active
    this.active = null
    clearTimeout(active.timeout)
    active.worker.terminate()
    this.cleanupJob(job)
    if (error !== undefined) job.reject(error)
    else job.resolve(result!)
    this.startNext()
  }

  private cleanupJob(job: ParseJob): void {
    if (job.signal && job.abortHandler) {
      job.signal.removeEventListener("abort", job.abortHandler)
    }
  }
}

function inputCopy(input: ArrayBuffer): ArrayBuffer {
  return input.slice(0)
}

const anyDocParser = new AnyDocParser()

export function parseLegacyOfficeWithAnyDoc(
  input: ArrayBuffer,
  format: LegacyOfficeFormat,
  options?: AnyDocParseOptions
): Promise<AnyDocParseResult> {
  return anyDocParser.parse(input, format, options)
}
