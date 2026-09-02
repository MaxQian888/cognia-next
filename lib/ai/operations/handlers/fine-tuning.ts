/**
 * `fine-tuning.jobs.create`, `list`, `get`, `cancel`, `events.list` and
 * `checkpoints.list` (ADR-0163, Batch 15), in the contract shapes. Three
 * real wires:
 *   - the OpenAI fine-tuning API (`/fine_tuning/jobs`) on the openai and
 *     azure protocols, which the compatible vendors declaring the surface
 *     mirror,
 *   - Mistral's jobs (`/fine_tuning/jobs` with `training_files`, events and
 *     checkpoints inline on the job),
 *   - Together's jobs (`/fine-tunes`).
 * Vendors whose job APIs this host does not wire are `unsupported` in the
 * matrix with that reason (`HOST_GAPS`), and have no handler here.
 */

import type { z } from "zod"
import type {
  fineTuningCheckpointsListOutput,
  fineTuningEventsListInput,
  fineTuningEventsListOutput,
  fineTuningJobsCreateInput,
  fineTuningJobsCreateOutput,
  fineTuningJobsGetInput,
  fineTuningJobsListInput,
  fineTuningJobsListOutput,
  ProviderResourceHandle,
} from "@cognia/provider-types"

import type {
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "../registry"
import { epochMs, handleFor, requireHandle } from "../resource-handle"
import { providerRequest } from "./http"
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

export type FineTuningJobsCreateInput = z.infer<typeof fineTuningJobsCreateInput>
export type FineTuningJob = z.infer<typeof fineTuningJobsCreateOutput>
export type FineTuningJobsListInput = z.infer<typeof fineTuningJobsListInput>
export type FineTuningJobsListOutput = z.infer<typeof fineTuningJobsListOutput>
export type FineTuningJobsGetInput = z.infer<typeof fineTuningJobsGetInput>
export type FineTuningEventsListInput = z.infer<typeof fineTuningEventsListInput>
export type FineTuningEventsListOutput = z.infer<typeof fineTuningEventsListOutput>
export type FineTuningCheckpointsListOutput = z.infer<typeof fineTuningCheckpointsListOutput>

interface FineTuningWire {
  create(
    context: WireContext,
    input: FineTuningJobsCreateInput,
    training: ProviderResourceHandle,
    validation: ProviderResourceHandle | undefined
  ): Promise<FineTuningJob>
  list(context: WireContext, input: FineTuningJobsListInput): Promise<FineTuningJobsListOutput>
  get(context: WireContext, job: ProviderResourceHandle): Promise<FineTuningJob>
  cancel(context: WireContext, job: ProviderResourceHandle): Promise<FineTuningJob>
  events(
    context: WireContext,
    input: FineTuningEventsListInput
  ): Promise<FineTuningEventsListOutput>
  checkpoints(
    context: WireContext,
    input: FineTuningEventsListInput
  ): Promise<FineTuningCheckpointsListOutput>
}

function jobHandle(context: WireContext, id: string, createdAt?: number): ProviderResourceHandle {
  return handleFor({
    kind: "fine-tuning-job",
    id,
    owner: context.provider,
    deploymentRef: context.deploymentRef,
    createdAt,
  })
}

// ---- OpenAI wire ------------------------------------------------------------------

const OPENAI_STATUS: Record<string, JobStatus> = {
  validating_files: "queued",
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
}

interface OpenAiJob {
  id: string
  status?: string
  model?: string
  fine_tuned_model?: string | null
  created_at?: number
}

function openAiJob(context: WireContext, job: OpenAiJob): FineTuningJob {
  const createdAt = epochMs(job.created_at)
  return {
    handle: jobHandle(context, job.id, createdAt),
    status: jobStatusOf(job.status, OPENAI_STATUS),
    baseModel: job.model ?? "",
    fineTunedModel: job.fine_tuned_model ?? null,
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

function jobPath(id: string, suffix = ""): string {
  return `fine_tuning/jobs/${encodeURIComponent(id)}${suffix}`
}

export const openAiFineTuningWire: FineTuningWire = {
  async create(context, input, training, validation) {
    const { json } = await providerRequest<OpenAiJob>(context.provider, {
      path: "fine_tuning/jobs",
      body: {
        model: input.baseModel,
        training_file: training.id,
        ...(validation ? { validation_file: validation.id } : {}),
        ...(input.hyperparameters ? { hyperparameters: input.hyperparameters } : {}),
        ...(input.suffix ? { suffix: input.suffix } : {}),
      },
      signal: context.signal,
    })
    return openAiJob(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<OpenAiPage<OpenAiJob>>(context.provider, {
      path: `fine_tuning/jobs${query({ limit: input.limit, after: input.after })}`,
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((job) => openAiJob(context, job)),
      nextCursor: openAiCursor(json),
    }
  },
  async get(context, job) {
    const { json } = await providerRequest<OpenAiJob>(context.provider, {
      path: jobPath(job.id),
      signal: context.signal,
    })
    return openAiJob(context, json)
  },
  async cancel(context, job) {
    const { json } = await providerRequest<OpenAiJob>(context.provider, {
      method: "POST",
      path: jobPath(job.id, "/cancel"),
      body: {},
      signal: context.signal,
    })
    return openAiJob(context, json)
  },
  async events(context, input) {
    const { json } = await providerRequest<
      OpenAiPage<{ id: string; created_at?: number; level?: string; message?: string }>
    >(context.provider, {
      path: jobPath(input.handle.id, `/events${query({ limit: input.limit, after: input.after })}`),
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((event) => ({
        id: event.id,
        createdAt: epochMs(event.created_at) ?? 0,
        level: event.level ?? "info",
        message: event.message ?? "",
      })),
      nextCursor: openAiCursor(json),
    }
  },
  async checkpoints(context, input) {
    const { json } = await providerRequest<
      OpenAiPage<{
        id: string
        step_number?: number
        fine_tuned_model_checkpoint?: string
        created_at?: number
      }>
    >(context.provider, {
      path: jobPath(
        input.handle.id,
        `/checkpoints${query({ limit: input.limit, after: input.after })}`
      ),
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((checkpoint) => ({
        id: checkpoint.id,
        ...(checkpoint.step_number !== undefined ? { stepNumber: checkpoint.step_number } : {}),
        fineTunedModelCheckpoint: checkpoint.fine_tuned_model_checkpoint ?? checkpoint.id,
        ...(epochMs(checkpoint.created_at) !== undefined
          ? { createdAt: epochMs(checkpoint.created_at) }
          : {}),
      })),
      nextCursor: openAiCursor(json),
    }
  },
}

// ---- Mistral wire -----------------------------------------------------------------

const MISTRAL_STATUS: Record<string, JobStatus> = {
  queued: "queued",
  started: "running",
  validating: "running",
  validated: "running",
  running: "running",
  failed_validation: "failed",
  failed: "failed",
  success: "succeeded",
  cancelled: "cancelled",
  cancellation_requested: "cancelled",
}

interface MistralJob {
  id: string
  status?: string
  model?: string
  fine_tuned_model?: string | null
  created_at?: number
  events?: Array<{ name?: string; data?: Record<string, unknown>; created_at?: number }>
  checkpoints?: Array<{
    metrics?: Record<string, unknown>
    step_number?: number
    created_at?: number
  }>
}

function mistralJob(context: WireContext, job: MistralJob): FineTuningJob {
  const createdAt = epochMs(job.created_at)
  return {
    handle: jobHandle(context, job.id, createdAt),
    status: jobStatusOf(job.status, MISTRAL_STATUS),
    baseModel: job.model ?? "",
    fineTunedModel: job.fine_tuned_model ?? null,
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

async function mistralGet(context: WireContext, id: string): Promise<MistralJob> {
  const { json } = await providerRequest<MistralJob>(context.provider, {
    path: `fine_tuning/jobs/${encodeURIComponent(id)}`,
    signal: context.signal,
  })
  return json
}

export const mistralFineTuningWire: FineTuningWire = {
  async create(context, input, training, validation) {
    const { json } = await providerRequest<MistralJob>(context.provider, {
      path: "fine_tuning/jobs",
      body: {
        model: input.baseModel,
        training_files: [{ file_id: training.id }],
        ...(validation ? { validation_files: [validation.id] } : {}),
        ...(input.hyperparameters ? { hyperparameters: input.hyperparameters } : {}),
        ...(input.suffix ? { suffix: input.suffix } : {}),
        auto_start: true,
      },
      signal: context.signal,
    })
    return mistralJob(context, json)
  },
  async list(context, input) {
    const page = input.after ? Number(input.after) : 0
    const { json } = await providerRequest<{ data?: MistralJob[]; total?: number }>(
      context.provider,
      {
        path: `fine_tuning/jobs${query({ page, page_size: input.limit })}`,
        signal: context.signal,
      }
    )
    const items = (json.data ?? []).map((job) => mistralJob(context, job))
    const pageSize = input.limit ?? items.length
    return {
      items,
      nextCursor:
        json.total !== undefined && (page + 1) * pageSize < json.total ? String(page + 1) : null,
    }
  },
  async get(context, job) {
    return mistralJob(context, await mistralGet(context, job.id))
  },
  async cancel(context, job) {
    const { json } = await providerRequest<MistralJob>(context.provider, {
      method: "POST",
      path: `fine_tuning/jobs/${encodeURIComponent(job.id)}/cancel`,
      body: {},
      signal: context.signal,
    })
    return mistralJob(context, json)
  },
  async events(context, input) {
    const job = await mistralGet(context, input.handle.id)
    return {
      items: (job.events ?? []).map((event, index) => ({
        id: `${job.id}:event:${index}`,
        createdAt: epochMs(event.created_at) ?? 0,
        level: "info",
        message: event.name
          ? `${event.name}${event.data ? ` ${JSON.stringify(event.data)}` : ""}`
          : "",
      })),
      nextCursor: null,
    }
  },
  async checkpoints(context, input) {
    // Mistral checkpoints carry metrics and a step, never their own model
    // id: the fine-tuned model name is the only deployable identifier.
    const job = await mistralGet(context, input.handle.id)
    return {
      items: (job.checkpoints ?? []).map((checkpoint, index) => ({
        id: `${job.id}:checkpoint:${checkpoint.step_number ?? index}`,
        ...(checkpoint.step_number !== undefined ? { stepNumber: checkpoint.step_number } : {}),
        fineTunedModelCheckpoint: job.fine_tuned_model ?? job.id,
        ...(epochMs(checkpoint.created_at) !== undefined
          ? { createdAt: epochMs(checkpoint.created_at) }
          : {}),
      })),
      nextCursor: null,
    }
  },
}

// ---- Together wire ----------------------------------------------------------------

const TOGETHER_STATUS: Record<string, JobStatus> = {
  pending: "queued",
  queued: "queued",
  running: "running",
  compressing: "running",
  uploading: "running",
  cancel_requested: "cancelled",
  cancelled: "cancelled",
  error: "failed",
  completed: "succeeded",
}

interface TogetherJob {
  id: string
  status?: string
  model?: string
  model_output_name?: string | null
  created_at?: string
}

function togetherJob(context: WireContext, job: TogetherJob): FineTuningJob {
  const createdAt = isoMs(job.created_at)
  return {
    handle: jobHandle(context, job.id, createdAt),
    status: jobStatusOf(job.status, TOGETHER_STATUS),
    baseModel: job.model ?? "",
    fineTunedModel: job.model_output_name ?? null,
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export const togetherFineTuningWire: FineTuningWire = {
  async create(context, input, training, validation) {
    const { json } = await providerRequest<TogetherJob>(context.provider, {
      path: "fine-tunes",
      body: {
        model: input.baseModel,
        training_file: training.id,
        ...(validation ? { validation_file: validation.id } : {}),
        ...(input.hyperparameters ?? {}),
        ...(input.suffix ? { suffix: input.suffix } : {}),
      },
      signal: context.signal,
    })
    return togetherJob(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<{ data?: TogetherJob[] }>(context.provider, {
      path: `fine-tunes${query({ limit: input.limit })}`,
      signal: context.signal,
    })
    return { items: (json.data ?? []).map((job) => togetherJob(context, job)), nextCursor: null }
  },
  async get(context, job) {
    const { json } = await providerRequest<TogetherJob>(context.provider, {
      path: `fine-tunes/${encodeURIComponent(job.id)}`,
      signal: context.signal,
    })
    return togetherJob(context, json)
  },
  async cancel(context, job) {
    const { json } = await providerRequest<TogetherJob>(context.provider, {
      method: "POST",
      path: `fine-tunes/${encodeURIComponent(job.id)}/cancel`,
      body: {},
      signal: context.signal,
    })
    return togetherJob(context, json)
  },
  async events(context, input) {
    const { json } = await providerRequest<{
      data?: Array<{ created_at?: string; level?: string; message?: string; type?: string }>
    }>(context.provider, {
      path: `fine-tunes/${encodeURIComponent(input.handle.id)}/events`,
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((event, index) => ({
        id: `${input.handle.id}:event:${index}`,
        createdAt: isoMs(event.created_at) ?? 0,
        level: event.level ?? "info",
        message: event.message ?? event.type ?? "",
      })),
      nextCursor: null,
    }
  },
  async checkpoints(context, input) {
    const { json } = await providerRequest<{
      data?: Array<{ name?: string; step?: number; timestamp?: string }>
    }>(context.provider, {
      path: `fine-tunes/${encodeURIComponent(input.handle.id)}/checkpoints`,
      signal: context.signal,
    })
    return {
      items: (json.data ?? []).map((checkpoint, index) => ({
        id: checkpoint.name ?? `${input.handle.id}:checkpoint:${index}`,
        ...(checkpoint.step !== undefined ? { stepNumber: checkpoint.step } : {}),
        fineTunedModelCheckpoint: checkpoint.name ?? input.handle.id,
        ...(isoMs(checkpoint.timestamp) !== undefined
          ? { createdAt: isoMs(checkpoint.timestamp) }
          : {}),
      })),
      nextCursor: null,
    }
  },
}

// ---- registrations ----------------------------------------------------------------

const WIRES: Array<{ match: ProviderOperationProviderMatch; wire: FineTuningWire }> = [
  { match: { kind: "provider", providerId: "mistral" }, wire: mistralFineTuningWire },
  { match: { kind: "provider", providerId: "togetherai" }, wire: togetherFineTuningWire },
  { match: { kind: "protocol", protocol: "openai" }, wire: openAiFineTuningWire },
  { match: { kind: "protocol", protocol: "azure" }, wire: openAiFineTuningWire },
]

function registrationsFor(
  match: ProviderOperationProviderMatch,
  wire: FineTuningWire
): ProviderOperationHandlerRegistration[] {
  type Context = Parameters<ProviderOperationHandlerRegistration["handler"]>[0]
  const jobOf = (context: Context) =>
    requireHandle(
      context.request.input as FineTuningJobsGetInput,
      "fine-tuning-job",
      context.provider
    )
  const scopedInput = (context: Context): FineTuningEventsListInput => {
    const input = context.request.input as FineTuningEventsListInput
    return { ...input, handle: requireHandle(input, "fine-tuning-job", context.provider) }
  }
  return [
    {
      operationId: "fine-tuning.jobs.create",
      providerMatch: match,
      support: "native",
      handler: async (context) => {
        const input = context.request.input as FineTuningJobsCreateInput
        const training = requireHandle({ handle: input.trainingFile }, "file", context.provider)
        const validation = input.validationFile
          ? requireHandle({ handle: input.validationFile }, "file", context.provider)
          : undefined
        return wire.create(contextOf(context), input, training, validation)
      },
    },
    {
      operationId: "fine-tuning.jobs.list",
      providerMatch: match,
      support: "native",
      handler: async (context) =>
        wire.list(contextOf(context), (context.request.input ?? {}) as FineTuningJobsListInput),
    },
    {
      operationId: "fine-tuning.jobs.get",
      providerMatch: match,
      support: "native",
      handler: async (context) => wire.get(contextOf(context), jobOf(context)),
    },
    {
      operationId: "fine-tuning.jobs.cancel",
      providerMatch: match,
      support: "native",
      handler: async (context) => wire.cancel(contextOf(context), jobOf(context)),
    },
    {
      operationId: "fine-tuning.events.list",
      providerMatch: match,
      support: "native",
      handler: async (context) => wire.events(contextOf(context), scopedInput(context)),
    },
    {
      operationId: "fine-tuning.checkpoints.list",
      providerMatch: match,
      support: "native",
      handler: async (context) => wire.checkpoints(contextOf(context), scopedInput(context)),
    },
  ]
}

export const FINE_TUNING_HANDLERS: ProviderOperationHandlerRegistration[] = WIRES.flatMap(
  ({ match, wire }) => registrationsFor(match, wire)
)
