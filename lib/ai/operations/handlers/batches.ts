/**
 * `batches.create`, `list`, `get`, `cancel` and `results` (ADR-0163,
 * Batch 15), in the contract shapes. Four real wires:
 *   - the OpenAI batch API (`/batches`) on the openai and azure protocols,
 *     which the compatible vendors declaring a batch surface mirror,
 *   - Mistral's batch jobs (`/batch/jobs`), bound to the mistral provider,
 *   - Anthropic message batches, `translated`: the input file (JSONL) is read
 *     back through the Files API and posted inline, results stream from
 *     `/results`,
 *   - Gemini batches: the endpoint names the model resource, the input is a
 *     Files API file, results are the operation's responses file.
 * Neither gateway ever fabricates a synchronous result: every answer is
 * the vendor's own job state. Handles stay pinned to the account they were
 * created under.
 */

import type { z } from "zod"
import type {
  batchesCreateInput,
  batchesCreateOutput,
  batchesGetInput,
  batchesListInput,
  batchesListOutput,
  batchesResultsOutput,
  ProviderResourceHandle,
} from "@cognia/provider-types"

import { ProviderOperationFailureError } from "../failure"
import type {
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "../registry"
import { epochMs, handleFor, requireHandle } from "../resource-handle"
import { bytesRefOf, type BytesRef } from "./bytes"
import { geminiRootOf } from "./files"
import { providerDownload, providerRequest } from "./http"
import {
  contextOf,
  isoMs,
  jobStatusOf,
  openAiCursor,
  query,
  type JobStatus,
  type OpenAiPage,
  type WireContext,
} from "./jobs-shared"

export type BatchesCreateInput = z.infer<typeof batchesCreateInput>
export type BatchObject = z.infer<typeof batchesCreateOutput>
export type BatchesListInput = z.infer<typeof batchesListInput>
export type BatchesListOutput = z.infer<typeof batchesListOutput>
export type BatchesGetInput = z.infer<typeof batchesGetInput>
export type BatchesResultsOutput = z.infer<typeof batchesResultsOutput>

interface BatchesWire {
  support: "native" | "translated"
  create(
    context: WireContext,
    input: BatchesCreateInput,
    inputFile: ProviderResourceHandle
  ): Promise<BatchObject>
  list(context: WireContext, input: BatchesListInput): Promise<BatchesListOutput>
  get(context: WireContext, batch: ProviderResourceHandle): Promise<BatchObject>
  cancel(context: WireContext, batch: ProviderResourceHandle): Promise<BatchObject>
  results(context: WireContext, batch: ProviderResourceHandle): Promise<BatchesResultsOutput>
}

function batchHandle(context: WireContext, id: string, createdAt?: number): ProviderResourceHandle {
  return handleFor({
    kind: "batch",
    id,
    owner: context.provider,
    deploymentRef: context.deploymentRef,
    createdAt,
  })
}

function fileHandle(context: WireContext, id: string): ProviderResourceHandle {
  return handleFor({
    kind: "file",
    id,
    owner: context.provider,
    deploymentRef: context.deploymentRef,
  })
}

// ---- OpenAI wire ------------------------------------------------------------------

const OPENAI_STATUS: Record<string, JobStatus> = {
  validating: "running",
  in_progress: "running",
  finalizing: "running",
  completed: "succeeded",
  failed: "failed",
  expired: "failed",
  cancelling: "cancelled",
  cancelled: "cancelled",
}

interface OpenAiBatch {
  id: string
  status?: string
  endpoint?: string
  request_counts?: { total?: number; completed?: number; failed?: number }
  created_at?: number
  output_file_id?: string | null
  error_file_id?: string | null
}

function openAiBatch(context: WireContext, batch: OpenAiBatch): BatchObject {
  const createdAt = epochMs(batch.created_at)
  return {
    handle: batchHandle(context, batch.id, createdAt),
    status: jobStatusOf(batch.status, OPENAI_STATUS),
    ...(batch.endpoint ? { endpoint: batch.endpoint } : {}),
    ...(batch.request_counts
      ? {
          counts: {
            total: batch.request_counts.total ?? 0,
            completed: batch.request_counts.completed ?? 0,
            failed: batch.request_counts.failed ?? 0,
          },
        }
      : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

async function openAiFileBytes(context: WireContext, fileId: string): Promise<BytesRef> {
  const { bytes, mimeType } = await providerDownload(context.provider, {
    path: `files/${encodeURIComponent(fileId)}/content`,
    signal: context.signal,
  })
  return bytesRefOf(bytes, mimeType)
}

export const openAiBatchesWire: BatchesWire = {
  support: "native",
  async create(context, input, inputFile) {
    const { json } = await providerRequest<OpenAiBatch>(context.provider, {
      path: "batches",
      body: {
        input_file_id: inputFile.id,
        endpoint: input.endpoint,
        completion_window: input.completionWindow ?? "24h",
      },
      signal: context.signal,
    })
    return openAiBatch(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<OpenAiPage<OpenAiBatch>>(context.provider, {
      path: `batches${query({ limit: input.limit, after: input.after })}`,
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((batch) => openAiBatch(context, batch)),
      nextCursor: openAiCursor(json),
    }
  },
  async get(context, batch) {
    const { json } = await providerRequest<OpenAiBatch>(context.provider, {
      path: `batches/${encodeURIComponent(batch.id)}`,
      signal: context.signal,
    })
    return openAiBatch(context, json)
  },
  async cancel(context, batch) {
    const { json } = await providerRequest<OpenAiBatch>(context.provider, {
      method: "POST",
      path: `batches/${encodeURIComponent(batch.id)}/cancel`,
      body: {},
      signal: context.signal,
    })
    return openAiBatch(context, json)
  },
  async results(context, batch) {
    const { json } = await providerRequest<OpenAiBatch>(context.provider, {
      path: `batches/${encodeURIComponent(batch.id)}`,
      signal: context.signal,
    })
    const outputFile = json.output_file_id ? fileHandle(context, json.output_file_id) : undefined
    const errorFile = json.error_file_id ? fileHandle(context, json.error_file_id) : undefined
    return {
      ...(outputFile ? { outputFile } : {}),
      ...(errorFile ? { errorFile } : {}),
      ...(json.output_file_id
        ? { content: await openAiFileBytes(context, json.output_file_id) }
        : {}),
    }
  },
}

// ---- Mistral wire -----------------------------------------------------------------

const MISTRAL_STATUS: Record<string, JobStatus> = {
  queued: "queued",
  running: "running",
  success: "succeeded",
  failed: "failed",
  timeout_exceeded: "failed",
  cancellation_requested: "cancelled",
  cancelled: "cancelled",
}

interface MistralBatch {
  id: string
  status?: string
  endpoint?: string
  total_requests?: number
  completed_requests?: number
  failed_requests?: number
  created_at?: number
  output_file?: string | null
  error_file?: string | null
}

function mistralBatch(context: WireContext, batch: MistralBatch): BatchObject {
  const createdAt = epochMs(batch.created_at)
  return {
    handle: batchHandle(context, batch.id, createdAt),
    status: jobStatusOf(batch.status, MISTRAL_STATUS),
    ...(batch.endpoint ? { endpoint: batch.endpoint } : {}),
    counts: {
      total: batch.total_requests ?? 0,
      completed: batch.completed_requests ?? 0,
      failed: batch.failed_requests ?? 0,
    },
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export const mistralBatchesWire: BatchesWire = {
  support: "native",
  async create(context, input, inputFile) {
    const model = typeof input.extra?.model === "string" ? input.extra.model : undefined
    const { json } = await providerRequest<MistralBatch>(context.provider, {
      path: "batch/jobs",
      body: {
        input_files: [inputFile.id],
        endpoint: input.endpoint,
        ...(model ? { model } : {}),
      },
      signal: context.signal,
    })
    return mistralBatch(context, json)
  },
  async list(context, input) {
    const page = input.after ? Number(input.after) : 0
    const { json } = await providerRequest<{ data?: MistralBatch[]; total?: number }>(
      context.provider,
      {
        path: `batch/jobs${query({ page, page_size: input.limit })}`,
        signal: context.signal,
      }
    )
    const items = (json.data ?? []).map((batch) => mistralBatch(context, batch))
    const pageSize = input.limit ?? items.length
    const seen = (page + 1) * pageSize
    return {
      items,
      nextCursor: json.total !== undefined && seen < json.total ? String(page + 1) : null,
    }
  },
  async get(context, batch) {
    const { json } = await providerRequest<MistralBatch>(context.provider, {
      path: `batch/jobs/${encodeURIComponent(batch.id)}`,
      signal: context.signal,
    })
    return mistralBatch(context, json)
  },
  async cancel(context, batch) {
    const { json } = await providerRequest<MistralBatch>(context.provider, {
      method: "POST",
      path: `batch/jobs/${encodeURIComponent(batch.id)}/cancel`,
      body: {},
      signal: context.signal,
    })
    return mistralBatch(context, json)
  },
  async results(context, batch) {
    const { json } = await providerRequest<MistralBatch>(context.provider, {
      path: `batch/jobs/${encodeURIComponent(batch.id)}`,
      signal: context.signal,
    })
    return {
      ...(json.output_file ? { outputFile: fileHandle(context, json.output_file) } : {}),
      ...(json.error_file ? { errorFile: fileHandle(context, json.error_file) } : {}),
      ...(json.output_file ? { content: await openAiFileBytes(context, json.output_file) } : {}),
    }
  },
}

// ---- Anthropic wire (translated) --------------------------------------------------

const ANTHROPIC_FILES_BETA = { "anthropic-beta": "files-api-2025-04-14" }

interface AnthropicBatch {
  id: string
  processing_status?: string
  request_counts?: {
    processing?: number
    succeeded?: number
    errored?: number
    canceled?: number
    expired?: number
  }
  created_at?: string
}

function anthropicBatch(context: WireContext, batch: AnthropicBatch): BatchObject {
  const counts = batch.request_counts
  const processing = counts?.processing ?? 0
  const succeeded = counts?.succeeded ?? 0
  const failed = (counts?.errored ?? 0) + (counts?.expired ?? 0)
  const canceled = counts?.canceled ?? 0
  const createdAt = isoMs(batch.created_at)
  const status: JobStatus =
    batch.processing_status === "ended"
      ? processing === 0 && succeeded === 0 && failed === 0 && canceled > 0
        ? "cancelled"
        : failed > 0 && succeeded === 0
          ? "failed"
          : "succeeded"
      : batch.processing_status === "canceling"
        ? "cancelled"
        : "running"
  return {
    handle: batchHandle(context, batch.id, createdAt),
    status,
    endpoint: "/v1/messages",
    counts: { total: processing + succeeded + failed + canceled, completed: succeeded, failed },
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

/** One JSONL line of the input file, in Anthropic's or OpenAI's batch request shape. */
export function anthropicBatchRequest(line: string): {
  custom_id: string
  params: Record<string, unknown>
} {
  const parsed = JSON.parse(line) as Record<string, unknown>
  const customId = typeof parsed.custom_id === "string" ? parsed.custom_id : undefined
  if (!customId) throw new Error("batch request line has no custom_id")
  if (parsed.params && typeof parsed.params === "object") {
    return { custom_id: customId, params: parsed.params as Record<string, unknown> }
  }
  if (parsed.body && typeof parsed.body === "object") {
    return { custom_id: customId, params: parsed.body as Record<string, unknown> }
  }
  throw new Error(`batch request ${customId} has neither params nor body`)
}

export const anthropicBatchesWire: BatchesWire = {
  support: "translated",
  async create(context, _input, inputFile) {
    const { bytes } = await providerDownload(context.provider, {
      path: `files/${encodeURIComponent(inputFile.id)}/content`,
      headers: ANTHROPIC_FILES_BETA,
      signal: context.signal,
    })
    const lines = new TextDecoder()
      .decode(bytes)
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
    let requests: Array<{ custom_id: string; params: Record<string, unknown> }>
    try {
      requests = lines.map(anthropicBatchRequest)
    } catch (error) {
      throw new ProviderOperationFailureError({
        code: "schema",
        retryable: false,
        message: `input file is not a batch request JSONL: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    const { json } = await providerRequest<AnthropicBatch>(context.provider, {
      path: "messages/batches",
      body: { requests },
      signal: context.signal,
    })
    return anthropicBatch(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<OpenAiPage<AnthropicBatch>>(context.provider, {
      path: `messages/batches${query({ limit: input.limit, after_id: input.after })}`,
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((batch) => anthropicBatch(context, batch)),
      nextCursor: openAiCursor(json),
    }
  },
  async get(context, batch) {
    const { json } = await providerRequest<AnthropicBatch>(context.provider, {
      path: `messages/batches/${encodeURIComponent(batch.id)}`,
      signal: context.signal,
    })
    return anthropicBatch(context, json)
  },
  async cancel(context, batch) {
    const { json } = await providerRequest<AnthropicBatch>(context.provider, {
      method: "POST",
      path: `messages/batches/${encodeURIComponent(batch.id)}/cancel`,
      body: {},
      signal: context.signal,
    })
    return anthropicBatch(context, json)
  },
  async results(context, batch) {
    const { bytes, mimeType } = await providerDownload(context.provider, {
      path: `messages/batches/${encodeURIComponent(batch.id)}/results`,
      signal: context.signal,
    })
    return { content: bytesRefOf(bytes, mimeType ?? "application/x-ndjson") }
  },
}

// ---- Gemini wire ------------------------------------------------------------------

const GEMINI_STATUS: Record<string, JobStatus> = {
  batch_state_pending: "queued",
  batch_state_running: "running",
  batch_state_succeeded: "succeeded",
  batch_state_failed: "failed",
  batch_state_expired: "failed",
  batch_state_cancelled: "cancelled",
}

interface GeminiBatch {
  name: string
  done?: boolean
  metadata?: {
    state?: string
    createTime?: string
    model?: string
    batchStats?: {
      requestCount?: string | number
      successfulRequestCount?: string | number
      failedRequestCount?: string | number
    }
  }
  response?: { responsesFile?: string }
  error?: { message?: string }
}

function n(value: string | number | undefined): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function geminiBatch(context: WireContext, batch: GeminiBatch): BatchObject {
  const createdAt = isoMs(batch.metadata?.createTime)
  const stats = batch.metadata?.batchStats
  return {
    handle: batchHandle(context, batch.name, createdAt),
    status: batch.error ? "failed" : jobStatusOf(batch.metadata?.state, GEMINI_STATUS),
    ...(batch.metadata?.model ? { endpoint: batch.metadata.model } : {}),
    ...(stats
      ? {
          counts: {
            total: n(stats.requestCount),
            completed: n(stats.successfulRequestCount),
            failed: n(stats.failedRequestCount),
          },
        }
      : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export const geminiBatchesWire: BatchesWire = {
  support: "native",
  async create(context, input, inputFile) {
    // The contract's endpoint names the model resource here (models/<id>).
    const model = input.endpoint.replace(/^\/+/, "")
    const { json } = await providerRequest<GeminiBatch>(context.provider, {
      path: `${model}:batchGenerateContent`,
      body: {
        batch: {
          ...(typeof input.extra?.displayName === "string"
            ? { displayName: input.extra.displayName }
            : {}),
          inputConfig: { fileName: inputFile.id },
        },
      },
      signal: context.signal,
    })
    return geminiBatch(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<{ operations?: GeminiBatch[]; nextPageToken?: string }>(
      context.provider,
      {
        path: `batches${query({ pageSize: input.limit, pageToken: input.after })}`,
        signal: context.signal,
      }
    )
    return {
      items: (json.operations ?? []).map((batch) => geminiBatch(context, batch)),
      nextCursor: json.nextPageToken ?? null,
    }
  },
  async get(context, batch) {
    const { json } = await providerRequest<GeminiBatch>(context.provider, {
      path: batch.id,
      signal: context.signal,
    })
    return geminiBatch(context, json)
  },
  async cancel(context, batch) {
    await providerRequest(context.provider, {
      method: "POST",
      path: `${batch.id}:cancel`,
      body: {},
      signal: context.signal,
    })
    const { json } = await providerRequest<GeminiBatch>(context.provider, {
      path: batch.id,
      signal: context.signal,
    })
    return geminiBatch(context, json)
  },
  async results(context, batch) {
    const { json } = await providerRequest<GeminiBatch>(context.provider, {
      path: batch.id,
      signal: context.signal,
    })
    const file = json.response?.responsesFile
    if (!file) return {}
    const { bytes, mimeType } = await providerDownload(context.provider, {
      baseURL: geminiRootOf(context.provider),
      path: `download/v1beta/${file}:download?alt=media`,
      signal: context.signal,
    })
    return {
      outputFile: fileHandle(context, file),
      content: bytesRefOf(bytes, mimeType ?? "application/x-ndjson"),
    }
  },
}

// ---- registrations ----------------------------------------------------------------

const WIRES: Array<{ match: ProviderOperationProviderMatch; wire: BatchesWire }> = [
  { match: { kind: "provider", providerId: "mistral" }, wire: mistralBatchesWire },
  { match: { kind: "protocol", protocol: "openai" }, wire: openAiBatchesWire },
  { match: { kind: "protocol", protocol: "azure" }, wire: openAiBatchesWire },
  { match: { kind: "protocol", protocol: "anthropic" }, wire: anthropicBatchesWire },
  { match: { kind: "protocol", protocol: "google" }, wire: geminiBatchesWire },
]

function registrationsFor(
  match: ProviderOperationProviderMatch,
  wire: BatchesWire
): ProviderOperationHandlerRegistration[] {
  const batchOf = (context: Parameters<ProviderOperationHandlerRegistration["handler"]>[0]) =>
    requireHandle(context.request.input as BatchesGetInput, "batch", context.provider)
  return [
    {
      operationId: "batches.create",
      providerMatch: match,
      support: wire.support,
      handler: async (context) => {
        const input = context.request.input as BatchesCreateInput
        const inputFile = requireHandle({ handle: input.inputFile }, "file", context.provider)
        return wire.create(contextOf(context), input, inputFile)
      },
    },
    {
      operationId: "batches.list",
      providerMatch: match,
      support: wire.support,
      handler: async (context) =>
        wire.list(contextOf(context), (context.request.input ?? {}) as BatchesListInput),
    },
    {
      operationId: "batches.get",
      providerMatch: match,
      support: wire.support,
      handler: async (context) => wire.get(contextOf(context), batchOf(context)),
    },
    {
      operationId: "batches.cancel",
      providerMatch: match,
      support: wire.support,
      handler: async (context) => wire.cancel(contextOf(context), batchOf(context)),
    },
    {
      operationId: "batches.results",
      providerMatch: match,
      support: wire.support,
      handler: async (context) => wire.results(contextOf(context), batchOf(context)),
    },
  ]
}

export const BATCHES_HANDLERS: ProviderOperationHandlerRegistration[] = WIRES.flatMap(
  ({ match, wire }) => registrationsFor(match, wire)
)
