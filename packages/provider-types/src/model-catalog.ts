/**
 * Versioned, provider-neutral model catalog contracts.
 *
 * Connections remain owned by ProviderProfile / DeploymentProfile /
 * TransportProfile. This catalog describes vendors, canonical models, and the
 * M:N offerings that make a model reachable through a provider.
 */

import { z } from "zod"

import { findSecretMaterialPaths, type ProfileParseResult } from "./provider-profile"

/**
 * Bumped when the enums below widen. Readers accept any snapshot whose
 * `schemaVersion` is at or below this number: the guard in
 * `parseCatalogSnapshot` only rejects NEWER snapshots, so a v1 snapshot still
 * parses under v2. Indexes are unaffected (the multi-entry modality index
 * indexes values, and `endpointType` is not indexed).
 *
 * v2 (ADR-0163): `video`, `transcription`, `moderation` modalities and the
 * `transcription`, `moderation`, `video`, `batch`, `files`, `fine-tuning`,
 * `vector-store` endpoint types, so the operation contract can map every
 * operation to an offering.
 */
export const CATALOG_SCHEMA_VERSION = 2

export const catalogTierSchema = z.enum(["certified", "verified", "experimental"])
export type CatalogTier = z.infer<typeof catalogTierSchema>

export const modelLifecycleSchema = z.enum(["preview", "active", "deprecated", "retired"])
export type ModelLifecycle = z.infer<typeof modelLifecycleSchema>

export type ModelSelectionPurpose = "new" | "auto" | "pinned" | "historical"

export interface ModelLifecycleInfo {
  lifecycle: ModelLifecycle
  replacementModelId?: string
  retiredAt?: string
  source?: CatalogSource
}

/** One eligibility rule for pickers, routing and runtime catalog resolution. */
export function isModelLifecycleAllowed(
  lifecycle: ModelLifecycle,
  purpose: ModelSelectionPurpose
): boolean {
  if (purpose === "historical") return true
  if (purpose === "auto") return lifecycle === "active"
  if (purpose === "pinned") return lifecycle !== "retired"
  return lifecycle === "active" || lifecycle === "preview"
}

function normalizeLifecycle(status: string | undefined): ModelLifecycle {
  switch (status?.toLowerCase()) {
    case "retired":
      return "retired"
    case "deprecated":
    case "legacy":
    case "sunset":
      return "deprecated"
    case "preview":
    case "beta":
    case "alpha":
    case "experimental":
      return "preview"
    default:
      return "active"
  }
}

/**
 * Provider-scoped official notices, checked 2026-10-19. Retain tombstones even
 * after upstream catalogs remove the IDs: absence must not reactivate an old
 * saved choice. An aggregator or user relay has its own availability policy.
 */
const LIFECYCLE_NOTICES: Readonly<
  Record<string, Readonly<Record<string, Omit<ModelLifecycleInfo, "source">>>>
> = {
  anthropic: {
    "claude-sonnet-4-20250514": {
      lifecycle: "retired",
      retiredAt: "2026-06-15",
      replacementModelId: "claude-sonnet-5-5",
    },
    "claude-sonnet-4": {
      lifecycle: "retired",
      retiredAt: "2026-06-15",
      replacementModelId: "claude-sonnet-5-5",
    },
    "claude-opus-4-20250514": {
      lifecycle: "retired",
      retiredAt: "2026-06-15",
      replacementModelId: "claude-opus-5-5",
    },
    "claude-opus-4": {
      lifecycle: "retired",
      retiredAt: "2026-06-15",
      replacementModelId: "claude-opus-5-5",
    },
    "claude-opus-4-1-20250805": {
      lifecycle: "retired",
      retiredAt: "2026-08-05",
      replacementModelId: "claude-opus-5-5",
    },
    "claude-3-haiku-20240307": {
      lifecycle: "retired",
      retiredAt: "2026-04-20",
      replacementModelId: "claude-haiku-5-5",
    },
    "claude-3-5-haiku-20241022": {
      lifecycle: "retired",
      retiredAt: "2026-02-19",
      replacementModelId: "claude-haiku-5-5",
    },
    "claude-3-7-sonnet-20250219": {
      lifecycle: "retired",
      retiredAt: "2026-02-19",
      replacementModelId: "claude-sonnet-5-5",
    },
    "claude-sonnet-4-5": {
      lifecycle: "deprecated",
      retiredAt: "2026-11-30",
      replacementModelId: "claude-sonnet-5-5",
    },
    "claude-sonnet-4-5-20250929": {
      lifecycle: "deprecated",
      retiredAt: "2026-11-30",
      replacementModelId: "claude-sonnet-5-5",
    },
  },
  google: {
    "gemini-3.1-flash-image-preview": {
      lifecycle: "retired",
      retiredAt: "2026-06-25",
      replacementModelId: "gemini-nano-banana-2.1",
    },
    "gemini-3-pro-image-preview": {
      lifecycle: "retired",
      retiredAt: "2026-06-25",
      replacementModelId: "gemini-3-pro-image",
    },
    "imagen-4.0-generate-001": {
      lifecycle: "retired",
      retiredAt: "2026-08-17",
      replacementModelId: "gemini-nano-banana-2.1",
    },
    "imagen-4.0-ultra-generate-001": {
      lifecycle: "retired",
      retiredAt: "2026-08-17",
      replacementModelId: "gemini-nano-banana-2.1",
    },
    "imagen-4.0-fast-generate-001": {
      lifecycle: "retired",
      retiredAt: "2026-08-17",
      replacementModelId: "gemini-nano-banana-2.1",
    },
    "veo-3.0-generate-001": {
      lifecycle: "retired",
      retiredAt: "2026-06-30",
      replacementModelId: "veo-3.1-generate-preview",
    },
    "veo-3.0-fast-generate-001": {
      lifecycle: "retired",
      retiredAt: "2026-06-30",
      replacementModelId: "veo-3.1-fast-generate-preview",
    },
    "veo-2.0-generate-001": {
      lifecycle: "retired",
      retiredAt: "2026-06-30",
      replacementModelId: "veo-3.1-generate-preview",
    },
    "gemini-2.0-flash": {
      lifecycle: "retired",
      retiredAt: "2026-06-01",
      replacementModelId: "gemini-3.8-flash",
    },
    "gemini-2.0-flash-001": {
      lifecycle: "retired",
      retiredAt: "2026-06-01",
      replacementModelId: "gemini-3.8-flash",
    },
    "gemini-2.0-flash-lite": {
      lifecycle: "retired",
      retiredAt: "2026-06-01",
      replacementModelId: "gemini-3.5-flash-lite",
    },
    "gemini-2.0-flash-lite-001": {
      lifecycle: "retired",
      retiredAt: "2026-06-01",
      replacementModelId: "gemini-3.5-flash-lite",
    },
    "gemini-3.1-flash-lite-preview": {
      lifecycle: "retired",
      retiredAt: "2026-05-25",
      replacementModelId: "gemini-3.5-flash-lite",
    },
  },
  xai: {
    "grok-4-1-fast-reasoning": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-4.7",
    },
    "grok-4-1-fast-non-reasoning": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-4.7",
    },
    "grok-4-fast-reasoning": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-4.7",
    },
    "grok-4-fast-non-reasoning": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-4.7",
    },
    "grok-4-0709": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-4.7",
    },
    "grok-code-fast-1": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-build-0.1",
    },
    "grok-3": { lifecycle: "retired", retiredAt: "2026-05-15", replacementModelId: "grok-4.7" },
    "grok-imagine-image-pro": {
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-imagine-image-2.0",
    },
  },
  siliconflow: {
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      lifecycle: "retired",
      retiredAt: "2026-04-22",
      replacementModelId: "zai-org/GLM-5.3",
    },
  },
  perplexity: {
    sonar: { lifecycle: "deprecated", replacementModelId: "preset/fast" },
    "sonar-pro": { lifecycle: "deprecated", replacementModelId: "preset/fast" },
    "sonar-reasoning": { lifecycle: "deprecated", replacementModelId: "preset/fast" },
    "sonar-reasoning-pro": { lifecycle: "deprecated", replacementModelId: "preset/fast" },
    "sonar-deep-research": { lifecycle: "deprecated", replacementModelId: "preset/fast" },
  },
  deepseek: {
    "deepseek-chat": {
      lifecycle: "retired",
      retiredAt: "2026-07-24",
      replacementModelId: "deepseek-flash",
    },
    "deepseek-reasoner": {
      lifecycle: "retired",
      retiredAt: "2026-07-24",
      replacementModelId: "deepseek-flash",
    },
  },
  openrouter: {
    "anthropic/claude-sonnet-4": {
      lifecycle: "retired",
      replacementModelId: "anthropic/claude-sonnet-5.5",
    },
    "google/gemini-2.0-flash-exp:free": {
      lifecycle: "retired",
      replacementModelId: "google/gemini-3.8-flash",
    },
  },
}

const LIFECYCLE_NOTICE_URLS: Readonly<Record<string, string>> = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  google: "https://ai.google.dev/gemini-api/docs/deprecations",
  deepseek: "https://api-docs.deepseek.com/updates/",
  openrouter: "https://openrouter.ai/api/v1/models",
  xai: "https://docs.x.ai/developers/migration/may-15-retirement",
  siliconflow: "https://docs.siliconflow.cn/docs/release-notes/overview",
  perplexity: "https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview",
}

/** IDs retained as tombstones even when a live catalog no longer lists them. */
export function knownModelLifecycleIds(providerId: string): string[] {
  return Object.keys(LIFECYCLE_NOTICES[providerId] ?? {})
}

/** A stale upstream `active` record cannot override an official retirement. */
export function resolveModelLifecycle(
  providerId: string,
  modelId: string,
  status?: string,
  ...otherStatuses: (string | undefined)[]
): ModelLifecycleInfo {
  const states = [status, ...otherStatuses].map(normalizeLifecycle)
  const lifecycle = (["retired", "deprecated", "preview", "active"] as const).find((candidate) =>
    states.includes(candidate)
  )!
  const notice = LIFECYCLE_NOTICES[providerId]?.[modelId]
  if (!notice) return { lifecycle }
  return {
    ...notice,
    lifecycle: lifecycle === "retired" ? lifecycle : notice.lifecycle,
    source: {
      kind: "official",
      id: `${providerId}:lifecycle:2026-10-19`,
      url: LIFECYCLE_NOTICE_URLS[providerId],
      observedAt: "2026-10-19T00:00:00.000Z",
    },
  }
}

export const catalogModalitySchema = z.enum([
  "language",
  "embedding",
  "rerank",
  "image",
  "speech",
  "video",
  "transcription",
  "moderation",
])
export type CatalogModality = z.infer<typeof catalogModalitySchema>

export const modelDataModalitySchema = z.enum(["text", "image", "audio", "video"])
export type ModelDataModality = z.infer<typeof modelDataModalitySchema>

export const adapterFamilySchema = z.enum([
  "openai-compatible",
  "anthropic",
  "gemini",
  "bedrock",
  "azure-openai",
  "vertex-ai",
  "openrouter",
  "local-openai-compatible",
])
export type AdapterFamily = z.infer<typeof adapterFamilySchema>

export const catalogSourceSchema = z.object({
  kind: z.enum(["official", "manual", "models-dev", "bundled", "plugin"]),
  id: z.string().min(1),
  url: z.string().url().optional(),
  observedAt: z.string().datetime().optional(),
})
export type CatalogSource = z.infer<typeof catalogSourceSchema>

export const connectionFieldSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["endpoint", "region", "account", "credential-ref", "select", "boolean"]),
  required: z.boolean().optional(),
  advanced: z.boolean().optional(),
  options: z.array(z.string().min(1)).optional(),
})
export type ConnectionField = z.infer<typeof connectionFieldSchema>

export const providerDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  brand: z
    .object({
      website: z.string().url().optional(),
      docsUrl: z.string().url().optional(),
      icon: z.string().min(1).optional(),
    })
    .optional(),
  tier: catalogTierSchema,
  source: catalogSourceSchema,
  modalities: z.array(catalogModalitySchema).min(1),
  adapterFamilies: z.array(adapterFamilySchema).min(1),
  connectionSchema: z.object({
    fields: z.array(connectionFieldSchema),
  }),
})
export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>

export const modelCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  attachments: z.boolean().optional(),
  temperature: z.boolean().optional(),
  openWeights: z.boolean().optional(),
  embeddings: z.boolean().optional(),
  rerank: z.boolean().optional(),
  imageGeneration: z.boolean().optional(),
  speechGeneration: z.boolean().optional(),
})
export type CatalogModelCapabilities = z.infer<typeof modelCapabilitiesSchema>
export type ModelCapability = keyof CatalogModelCapabilities

export const modelLimitsSchema = z.object({
  context: z.number().int().positive().optional(),
  input: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
  dimensions: z.number().int().positive().optional(),
})
export type ModelLimits = z.infer<typeof modelLimitsSchema>

export const modelDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  creator: z.string().min(1),
  family: z.string().min(1).optional(),
  modalities: z.object({
    input: z.array(modelDataModalitySchema),
    output: z.array(modelDataModalitySchema),
  }),
  capabilities: modelCapabilitiesSchema,
  limits: modelLimitsSchema.optional(),
  lifecycle: modelLifecycleSchema,
  releasedAt: z.string().optional(),
  retiredAt: z.string().optional(),
  provenance: z.record(z.string(), catalogSourceSchema),
})
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>

export const offeringPricingSchema = z.object({
  currency: z.enum(["USD", "CNY"]),
  inputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
  cachedInputPer1M: z.number().nonnegative().optional(),
  cacheWritePer1M: z.number().nonnegative().optional(),
  perImage: z.number().nonnegative().optional(),
  perMinute: z.number().nonnegative().optional(),
})
export type OfferingPricing = z.infer<typeof offeringPricingSchema>

export const providerOfferingSchema = z.object({
  id: z.string().min(1),
  providerRef: z.string().min(1),
  /** Deployment id when the offering is bound to a specific endpoint profile. */
  deploymentRef: z.string().min(1).optional(),
  modelRef: z.string().min(1),
  upstreamId: z.string().min(1),
  endpointType: z.enum([
    "chat-completions",
    "responses",
    "messages",
    "generate-content",
    "embedding",
    "rerank",
    "images",
    "speech",
    "realtime",
    "bedrock-runtime",
    "local",
    "transcription",
    "moderation",
    "video",
    "batch",
    "files",
    "fine-tuning",
    "vector-store",
  ]),
  lifecycle: modelLifecycleSchema,
  available: z.boolean(),
  capabilities: modelCapabilitiesSchema.optional(),
  limits: modelLimitsSchema.optional(),
  pricing: offeringPricingSchema.optional(),
  source: catalogSourceSchema,
})
export type ProviderOffering = z.infer<typeof providerOfferingSchema>

export const modelAliasSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["legacy", "friendly", "role"]),
  target: z.object({
    type: z.enum(["model", "offering", "alias"]),
    ref: z.string().min(1),
  }),
  replacementRef: z.string().min(1).optional(),
})
export type ModelAlias = z.infer<typeof modelAliasSchema>

export const catalogRevisionSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  sources: z.array(catalogSourceSchema).min(1),
  checksum: z.string().min(1),
  integrity: z.enum(["pending", "verified", "invalid"]),
})
export type CatalogRevision = z.infer<typeof catalogRevisionSchema>

export const catalogSnapshotSchema = z.object({
  revision: catalogRevisionSchema,
  providers: z.array(providerDefinitionSchema),
  models: z.array(modelDefinitionSchema),
  offerings: z.array(providerOfferingSchema),
  aliases: z.array(modelAliasSchema),
})
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>

/** Installed-plugin overlay applied to the active catalog in memory. */
export interface CatalogContribution {
  providers: ProviderDefinition[]
  models: ModelDefinition[]
  offerings: ProviderOffering[]
  aliases?: ModelAlias[]
}

function duplicateIds<T extends { id: string }>(values: readonly T[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id)
    seen.add(value.id)
  }
  return [...duplicates].sort()
}

function validateAliasGraph(aliases: readonly ModelAlias[]): string[] {
  const byId = new Map(aliases.map((alias) => [alias.id, alias]))
  const errors: string[] = []

  for (const alias of aliases) {
    const path = new Set<string>()
    let current: ModelAlias | undefined = alias
    while (current?.target.type === "alias") {
      if (path.has(current.id)) {
        errors.push(`alias cycle detected at "${current.id}"`)
        break
      }
      path.add(current.id)
      const next = byId.get(current.target.ref)
      if (!next) {
        errors.push(`alias "${current.id}" references missing alias "${current.target.ref}"`)
        break
      }
      current = next
    }
  }

  return [...new Set(errors)].sort()
}

/** Parse and validate a complete revision before it can enter staging. */
export function parseCatalogSnapshot(value: unknown): ProfileParseResult<CatalogSnapshot> {
  const errors = findSecretMaterialPaths(value).map(
    (path) => `catalogSnapshot: secret material is not allowed at "${path}"`
  )
  const parsed = catalogSnapshotSchema.safeParse(value)
  if (!parsed.success) {
    errors.push(
      ...parsed.error.issues.map(
        (issue) => `catalogSnapshot.${issue.path.join(".")}: ${issue.message}`
      )
    )
    return { ok: false, errors }
  }

  const snapshot = parsed.data
  if (snapshot.revision.schemaVersion > CATALOG_SCHEMA_VERSION) {
    errors.push(
      `catalog schemaVersion ${snapshot.revision.schemaVersion} is newer than supported ${CATALOG_SCHEMA_VERSION}`
    )
  }

  for (const id of duplicateIds(snapshot.providers)) errors.push(`duplicate provider id "${id}"`)
  for (const id of duplicateIds(snapshot.models)) errors.push(`duplicate model id "${id}"`)
  for (const id of duplicateIds(snapshot.offerings)) errors.push(`duplicate offering id "${id}"`)
  for (const id of duplicateIds(snapshot.aliases)) errors.push(`duplicate alias id "${id}"`)

  const providerIds = new Set(snapshot.providers.map((provider) => provider.id))
  const modelIds = new Set(snapshot.models.map((model) => model.id))
  const offeringIds = new Set(snapshot.offerings.map((offering) => offering.id))

  for (const offering of snapshot.offerings) {
    if (!providerIds.has(offering.providerRef)) {
      errors.push(`offering "${offering.id}" references missing provider "${offering.providerRef}"`)
    }
    if (!modelIds.has(offering.modelRef)) {
      errors.push(`offering "${offering.id}" references missing model "${offering.modelRef}"`)
    }
  }

  for (const alias of snapshot.aliases) {
    if (alias.target.type === "model" && !modelIds.has(alias.target.ref)) {
      errors.push(`alias "${alias.id}" references missing model "${alias.target.ref}"`)
    }
    if (alias.target.type === "offering" && !offeringIds.has(alias.target.ref)) {
      errors.push(`alias "${alias.id}" references missing offering "${alias.target.ref}"`)
    }
  }
  errors.push(...validateAliasGraph(snapshot.aliases))

  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)].sort() }
    : {
        ok: true,
        value: snapshot,
      }
}
