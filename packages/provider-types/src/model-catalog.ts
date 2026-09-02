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
