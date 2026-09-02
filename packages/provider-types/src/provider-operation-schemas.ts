/**
 * Per-operation zod input and output schemas for the provider operation
 * contract (ADR-0163). Every descriptor in `protocol/provider-operations.json`
 * names one `<id>Input` and one `<id>Output` export from this module by
 * name, and the manifest gate checks the export exists. This is what makes
 * the manifest validate something: a `$ref` string that every descriptor
 * points at the same way (the companion manifest's `RpcArgs` / `RpcResult`)
 * proves nothing.
 *
 * Shapes are provider-neutral. Provider-specific fields ride in `extra`
 * records so a handler can pass them through without widening the contract.
 */

import { z } from "zod"

// ---- shared fragments ---------------------------------------------------------

export const providerResourceHandleSchema = z.object({
  kind: z.enum(["file", "vector-store", "batch", "fine-tuning-job", "video", "realtime-session"]),
  id: z.string().min(1),
  providerId: z.string().min(1),
  deploymentRef: z.string().min(1),
  accountRef: z.string().min(1),
  credentialAffinity: z.string().min(1),
  createdAt: z.number().int().nonnegative().optional(),
})

const extra = z.record(z.string(), z.unknown()).optional()

const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    units: z.record(z.string(), z.number()).optional(),
  })
  .optional()

const modelRef = z.object({ model: z.string().min(1) })

const contentBlock = z.object({ type: z.string().min(1) }).catchall(z.unknown())

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentBlock)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
})

export const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
})

const languageRequestBase = modelRef.extend({
  messages: z.array(chatMessageSchema).min(1),
  system: z.string().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stopSequences: z.array(z.string()).optional(),
  extra,
})

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

const languageResponseBase = z.object({
  model: z.string(),
  text: z.string(),
  finishReason: z
    .enum(["stop", "length", "tool-calls", "content-filter", "error", "other"])
    .optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  usage: usageSchema,
  raw: z.unknown().optional(),
})

const listQuery = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  after: z.string().optional(),
  extra,
})

const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable().optional() })

const deleted = z.object({ id: z.string(), deleted: z.literal(true) })
const bytesRef = z.object({
  bytes: z.instanceof(Uint8Array).optional(),
  base64: z.string().optional(),
  dataUrl: z.string().optional(),
  url: z.string().url().optional(),
  mimeType: z.string().optional(),
})
const handleInput = z.object({ handle: providerResourceHandleSchema, extra })

// ---- discovery --------------------------------------------------------------

export const modelsListInput = z.object({
  refresh: z.boolean().optional(),
  extra,
})
export const modelCandidateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    contextLength: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
  })
  .catchall(z.unknown())
export const modelsListOutput = z.object({
  models: z.array(modelCandidateSchema),
  source: z.enum(["catalog-static", "models-dev", "remote-discovered", "user-curated"]),
  freshness: z.enum(["static", "fresh", "stale"]),
  fetchedAt: z.number().int().nonnegative(),
})

export const modelsGetInput = modelRef
export const modelsGetOutput = z.object({ model: modelCandidateSchema.nullable() })

export const capabilitiesReadInput = z.object({ deploymentRef: z.string().optional() })
export const capabilitiesReadOutput = z.object({
  providerId: z.string(),
  deploymentRef: z.string().optional(),
  computedAt: z.number().int().nonnegative(),
  cells: z.array(z.object({ operationId: z.string(), support: z.string() }).catchall(z.unknown())),
})

export const authStatusInput = z.object({ deploymentRef: z.string().optional() })
export const authStatusOutput = z.object({
  configured: z.boolean(),
  credentialFingerprint: z.string().optional(),
  method: z.enum(["api-key", "oauth", "subscription", "none", "other"]),
  expiresAt: z.number().int().optional(),
})

export const healthProbeInput = z.object({
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export const healthProbeOutput = z.object({
  reachable: z.boolean(),
  authenticated: z.boolean().optional(),
  capabilityVerified: z.boolean(),
  durationMs: z.number().nonnegative(),
  httpStatus: z.number().int().optional(),
})

// ---- language -----------------------------------------------------------------

export const languageGenerateInput = languageRequestBase
export const languageGenerateOutput = languageResponseBase

export const languageStreamInput = languageRequestBase
export const languageStreamOutput = z.object({
  streamId: z.string(),
  model: z.string(),
  /** Terminal aggregate, once the stream closes. */
  final: languageResponseBase.optional(),
})

export const languageToolsInput = languageRequestBase.extend({
  tools: z.array(toolDefinitionSchema).min(1),
  toolChoice: z.enum(["auto", "required", "none"]).optional(),
})
export const languageToolsOutput = languageResponseBase

export const languageStructuredOutputInput = languageRequestBase.extend({
  schema: z.record(z.string(), z.unknown()),
  schemaName: z.string().optional(),
})
export const languageStructuredOutputOutput = languageResponseBase.extend({
  object: z.unknown(),
})

export const tokensCountInput = modelRef.extend({
  messages: z.array(chatMessageSchema),
  system: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
})
export const tokensCountOutput = z.object({
  inputTokens: z.number().int().nonnegative(),
  method: z.enum(["provider", "estimate"]),
})

export const moderationCreateInput = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
})
export const moderationCreateOutput = z.object({
  results: z.array(
    z.object({
      flagged: z.boolean(),
      categories: z.record(z.string(), z.boolean()),
      scores: z.record(z.string(), z.number()).optional(),
    })
  ),
})

// ---- retrieval ----------------------------------------------------------------

export const embeddingsCreateInput = modelRef.extend({
  input: z.array(z.string()).min(1),
  dimensions: z.number().int().positive().optional(),
  extra,
})
export const embeddingsCreateOutput = z.object({
  embeddings: z.array(z.array(z.number())),
  usage: usageSchema,
})

export const rerankCreateInput = modelRef.extend({
  query: z.string().min(1),
  documents: z.array(z.string()).min(1),
  topN: z.number().int().positive().optional(),
})
export const rerankCreateOutput = z.object({
  ranking: z.array(z.object({ index: z.number().int().nonnegative(), score: z.number() })),
  usage: usageSchema,
})

// ---- media ----------------------------------------------------------------------

export const imagesGenerateInput = modelRef.extend({
  prompt: z.string().min(1),
  n: z.number().int().positive().max(10).optional(),
  size: z.string().optional(),
  aspectRatio: z.string().optional(),
  extra,
})
export const imagesGenerateOutput = z.object({ images: z.array(bytesRef).min(1) })

export const imagesEditInput = imagesGenerateInput.extend({
  image: bytesRef,
  mask: bytesRef.optional(),
})
export const imagesEditOutput = imagesGenerateOutput

export const videosGenerateInput = modelRef.extend({
  prompt: z.string().min(1),
  durationSeconds: z.number().positive().optional(),
  aspectRatio: z.string().optional(),
  extra,
})
const jobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"])
export const videosGenerateOutput = z.object({
  handle: providerResourceHandleSchema,
  status: jobStatus,
})
export const videosGetInput = handleInput
export const videosGetOutput = z.object({
  handle: providerResourceHandleSchema,
  status: jobStatus,
  progress: z.number().min(0).max(1).optional(),
  error: z.string().optional(),
})
export const videosCancelInput = handleInput
export const videosCancelOutput = videosGetOutput
export const videosContentInput = handleInput
export const videosContentOutput = z.object({ video: bytesRef })

export const speechGenerateInput = modelRef.extend({
  text: z.string().min(1),
  voice: z.string().optional(),
  format: z.string().optional(),
  extra,
})
export const speechGenerateOutput = z.object({ audio: bytesRef })

export const transcriptionCreateInput = modelRef.extend({
  audio: bytesRef,
  language: z.string().optional(),
  extra,
})
export const transcriptionCreateOutput = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
})

export const translationCreateInput = transcriptionCreateInput
export const translationCreateOutput = transcriptionCreateOutput

export const realtimeConnectInput = modelRef.extend({
  voice: z.string().optional(),
  instructions: z.string().optional(),
  extra,
})
export const realtimeConnectOutput = z.object({
  handle: providerResourceHandleSchema,
  transport: z.enum(["websocket", "webrtc"]),
  url: z.string().url(),
  /** Ephemeral credential for the media leg. Never persisted. */
  ephemeralToken: z.string().optional(),
  expiresAt: z.number().int().optional(),
})

// ---- files / jobs -------------------------------------------------------------

const fileObject = z.object({
  handle: providerResourceHandleSchema,
  filename: z.string(),
  bytes: z.number().int().nonnegative().optional(),
  purpose: z.string().optional(),
  createdAt: z.number().int().optional(),
})
export const filesUploadInput = z.object({
  filename: z.string().min(1),
  content: bytesRef,
  purpose: z.string().optional(),
  extra,
})
export const filesUploadOutput = fileObject
export const filesListInput = listQuery.extend({ purpose: z.string().optional() })
export const filesListOutput = pageOf(fileObject)
export const filesGetInput = handleInput
export const filesGetOutput = fileObject
export const filesContentInput = handleInput
export const filesContentOutput = z.object({ content: bytesRef })
export const filesDeleteInput = handleInput
export const filesDeleteOutput = deleted

const vectorStoreObject = z.object({
  handle: providerResourceHandleSchema,
  name: z.string().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
})
export const vectorStoresCreateInput = z.object({
  name: z.string().optional(),
  fileHandles: z.array(providerResourceHandleSchema).optional(),
  extra,
})
export const vectorStoresCreateOutput = vectorStoreObject
export const vectorStoresListInput = listQuery
export const vectorStoresListOutput = pageOf(vectorStoreObject)
export const vectorStoresGetInput = handleInput
export const vectorStoresGetOutput = vectorStoreObject
export const vectorStoresDeleteInput = handleInput
export const vectorStoresDeleteOutput = deleted
export const vectorStoresFilesAddInput = z.object({
  handle: providerResourceHandleSchema,
  file: providerResourceHandleSchema,
  extra,
})
export const vectorStoresFilesAddOutput = z.object({
  handle: providerResourceHandleSchema,
  file: providerResourceHandleSchema,
  status: z.string().optional(),
})
export const vectorStoresFilesRemoveInput = vectorStoresFilesAddInput
export const vectorStoresFilesRemoveOutput = deleted

const batchObject = z.object({
  handle: providerResourceHandleSchema,
  status: jobStatus,
  endpoint: z.string().optional(),
  counts: z
    .object({ total: z.number().int(), completed: z.number().int(), failed: z.number().int() })
    .optional(),
  createdAt: z.number().int().optional(),
})
export const batchesCreateInput = z.object({
  inputFile: providerResourceHandleSchema,
  endpoint: z.string().min(1),
  completionWindow: z.string().optional(),
  extra,
})
export const batchesCreateOutput = batchObject
export const batchesListInput = listQuery
export const batchesListOutput = pageOf(batchObject)
export const batchesGetInput = handleInput
export const batchesGetOutput = batchObject
export const batchesCancelInput = handleInput
export const batchesCancelOutput = batchObject
export const batchesResultsInput = handleInput
export const batchesResultsOutput = z.object({
  outputFile: providerResourceHandleSchema.optional(),
  errorFile: providerResourceHandleSchema.optional(),
  content: bytesRef.optional(),
})

const fineTuningJobObject = z.object({
  handle: providerResourceHandleSchema,
  status: jobStatus,
  baseModel: z.string(),
  fineTunedModel: z.string().nullable().optional(),
  createdAt: z.number().int().optional(),
})
export const fineTuningJobsCreateInput = z.object({
  baseModel: z.string().min(1),
  trainingFile: providerResourceHandleSchema,
  validationFile: providerResourceHandleSchema.optional(),
  hyperparameters: z.record(z.string(), z.unknown()).optional(),
  suffix: z.string().optional(),
  extra,
})
export const fineTuningJobsCreateOutput = fineTuningJobObject
export const fineTuningJobsListInput = listQuery
export const fineTuningJobsListOutput = pageOf(fineTuningJobObject)
export const fineTuningJobsGetInput = handleInput
export const fineTuningJobsGetOutput = fineTuningJobObject
export const fineTuningJobsCancelInput = handleInput
export const fineTuningJobsCancelOutput = fineTuningJobObject
export const fineTuningEventsListInput = handleInput.extend({
  limit: z.number().int().positive().optional(),
  after: z.string().optional(),
})
export const fineTuningEventsListOutput = pageOf(
  z.object({ id: z.string(), createdAt: z.number().int(), level: z.string(), message: z.string() })
)
export const fineTuningCheckpointsListInput = fineTuningEventsListInput
export const fineTuningCheckpointsListOutput = pageOf(
  z.object({
    id: z.string(),
    stepNumber: z.number().int().optional(),
    fineTunedModelCheckpoint: z.string(),
    createdAt: z.number().int().optional(),
  })
)

// ---- account ------------------------------------------------------------------

const accountInput = z.object({
  deploymentRef: z.string().optional(),
  live: z.boolean().optional(),
})
export const balanceReadInput = accountInput
export const balanceReadOutput = z.object({
  amount: z.number(),
  currency: z.string(),
  kind: z.enum(["prepaid", "postpaid", "credits"]),
  capturedAt: z.number().int().nonnegative(),
})
export const quotaReadInput = accountInput
export const quotaReadOutput = z.object({
  used: z.number().nonnegative(),
  limit: z.number().nonnegative().optional(),
  unit: z.string(),
  resetsAt: z.number().int().optional(),
  capturedAt: z.number().int().nonnegative(),
})
export const rateLimitsReadInput = accountInput
export const rateLimitsReadOutput = z.object({
  limits: z.array(
    z.object({
      name: z.string(),
      remaining: z.number().optional(),
      limit: z.number().optional(),
      resetsAt: z.number().int().optional(),
    })
  ),
  capturedAt: z.number().int().nonnegative(),
})
export const usageProviderReadInput = accountInput.extend({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
})
export const usageProviderReadOutput = z.object({
  rows: z.array(
    z.object({
      day: z.string(),
      model: z.string().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      costUsd: z.number().optional(),
    })
  ),
  capturedAt: z.number().int().nonnegative(),
})
export const usageLocalReadInput = z.object({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  providerId: z.string().optional(),
})
export const usageLocalReadOutput = z.object({
  rows: z.array(
    z.object({
      model: z.string(),
      providerId: z.string().optional(),
      /** Provider attribution comes from the catalog and is approximate for aliases. */
      attribution: z.enum(["exact", "catalog", "approximate"]),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
    })
  ),
})
