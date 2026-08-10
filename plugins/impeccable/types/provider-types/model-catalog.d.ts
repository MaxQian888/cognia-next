import { z } from "zod"
import { ProfileParseResult } from "./provider-profile.js"

/**
 * Versioned, provider-neutral model catalog contracts.
 *
 * Connections remain owned by ProviderProfile / DeploymentProfile /
 * TransportProfile. This catalog describes vendors, canonical models, and the
 * M:N offerings that make a model reachable through a provider.
 */

declare const CATALOG_SCHEMA_VERSION = 1
declare const catalogTierSchema: z.ZodEnum<{
  verified: "verified"
  certified: "certified"
  experimental: "experimental"
}>
type CatalogTier = z.infer<typeof catalogTierSchema>
declare const modelLifecycleSchema: z.ZodEnum<{
  deprecated: "deprecated"
  preview: "preview"
  active: "active"
  retired: "retired"
}>
type ModelLifecycle = z.infer<typeof modelLifecycleSchema>
declare const catalogModalitySchema: z.ZodEnum<{
  image: "image"
  rerank: "rerank"
  language: "language"
  embedding: "embedding"
  speech: "speech"
}>
type CatalogModality = z.infer<typeof catalogModalitySchema>
declare const modelDataModalitySchema: z.ZodEnum<{
  text: "text"
  image: "image"
  audio: "audio"
  video: "video"
}>
type ModelDataModality = z.infer<typeof modelDataModalitySchema>
declare const adapterFamilySchema: z.ZodEnum<{
  anthropic: "anthropic"
  gemini: "gemini"
  bedrock: "bedrock"
  "openai-compatible": "openai-compatible"
  openrouter: "openrouter"
  "local-openai-compatible": "local-openai-compatible"
  "azure-openai": "azure-openai"
  "vertex-ai": "vertex-ai"
}>
type AdapterFamily = z.infer<typeof adapterFamilySchema>
declare const catalogSourceSchema: z.ZodObject<
  {
    kind: z.ZodEnum<{
      plugin: "plugin"
      manual: "manual"
      official: "official"
      "models-dev": "models-dev"
      bundled: "bundled"
    }>
    id: z.ZodString
    url: z.ZodOptional<z.ZodString>
    observedAt: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type CatalogSource = z.infer<typeof catalogSourceSchema>
declare const connectionFieldSchema: z.ZodObject<
  {
    id: z.ZodString
    kind: z.ZodEnum<{
      boolean: "boolean"
      region: "region"
      select: "select"
      endpoint: "endpoint"
      account: "account"
      "credential-ref": "credential-ref"
    }>
    required: z.ZodOptional<z.ZodBoolean>
    advanced: z.ZodOptional<z.ZodBoolean>
    options: z.ZodOptional<z.ZodArray<z.ZodString>>
  },
  z.core.$strip
>
type ConnectionField = z.infer<typeof connectionFieldSchema>
declare const providerDefinitionSchema: z.ZodObject<
  {
    id: z.ZodString
    name: z.ZodString
    brand: z.ZodOptional<
      z.ZodObject<
        {
          website: z.ZodOptional<z.ZodString>
          docsUrl: z.ZodOptional<z.ZodString>
          icon: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
    tier: z.ZodEnum<{
      verified: "verified"
      certified: "certified"
      experimental: "experimental"
    }>
    source: z.ZodObject<
      {
        kind: z.ZodEnum<{
          plugin: "plugin"
          manual: "manual"
          official: "official"
          "models-dev": "models-dev"
          bundled: "bundled"
        }>
        id: z.ZodString
        url: z.ZodOptional<z.ZodString>
        observedAt: z.ZodOptional<z.ZodString>
      },
      z.core.$strip
    >
    modalities: z.ZodArray<
      z.ZodEnum<{
        image: "image"
        rerank: "rerank"
        language: "language"
        embedding: "embedding"
        speech: "speech"
      }>
    >
    adapterFamilies: z.ZodArray<
      z.ZodEnum<{
        anthropic: "anthropic"
        gemini: "gemini"
        bedrock: "bedrock"
        "openai-compatible": "openai-compatible"
        openrouter: "openrouter"
        "local-openai-compatible": "local-openai-compatible"
        "azure-openai": "azure-openai"
        "vertex-ai": "vertex-ai"
      }>
    >
    connectionSchema: z.ZodObject<
      {
        fields: z.ZodArray<
          z.ZodObject<
            {
              id: z.ZodString
              kind: z.ZodEnum<{
                boolean: "boolean"
                region: "region"
                select: "select"
                endpoint: "endpoint"
                account: "account"
                "credential-ref": "credential-ref"
              }>
              required: z.ZodOptional<z.ZodBoolean>
              advanced: z.ZodOptional<z.ZodBoolean>
              options: z.ZodOptional<z.ZodArray<z.ZodString>>
            },
            z.core.$strip
          >
        >
      },
      z.core.$strip
    >
  },
  z.core.$strip
>
type ProviderDefinition = z.infer<typeof providerDefinitionSchema>
declare const modelCapabilitiesSchema: z.ZodObject<
  {
    streaming: z.ZodOptional<z.ZodBoolean>
    tools: z.ZodOptional<z.ZodBoolean>
    structuredOutput: z.ZodOptional<z.ZodBoolean>
    reasoning: z.ZodOptional<z.ZodBoolean>
    attachments: z.ZodOptional<z.ZodBoolean>
    temperature: z.ZodOptional<z.ZodBoolean>
    openWeights: z.ZodOptional<z.ZodBoolean>
    embeddings: z.ZodOptional<z.ZodBoolean>
    rerank: z.ZodOptional<z.ZodBoolean>
    imageGeneration: z.ZodOptional<z.ZodBoolean>
    speechGeneration: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
type CatalogModelCapabilities = z.infer<typeof modelCapabilitiesSchema>
type ModelCapability = keyof CatalogModelCapabilities
declare const modelLimitsSchema: z.ZodObject<
  {
    context: z.ZodOptional<z.ZodNumber>
    input: z.ZodOptional<z.ZodNumber>
    output: z.ZodOptional<z.ZodNumber>
    dimensions: z.ZodOptional<z.ZodNumber>
  },
  z.core.$strip
>
type ModelLimits = z.infer<typeof modelLimitsSchema>
declare const modelDefinitionSchema: z.ZodObject<
  {
    id: z.ZodString
    name: z.ZodString
    creator: z.ZodString
    family: z.ZodOptional<z.ZodString>
    modalities: z.ZodObject<
      {
        input: z.ZodArray<
          z.ZodEnum<{
            text: "text"
            image: "image"
            audio: "audio"
            video: "video"
          }>
        >
        output: z.ZodArray<
          z.ZodEnum<{
            text: "text"
            image: "image"
            audio: "audio"
            video: "video"
          }>
        >
      },
      z.core.$strip
    >
    capabilities: z.ZodObject<
      {
        streaming: z.ZodOptional<z.ZodBoolean>
        tools: z.ZodOptional<z.ZodBoolean>
        structuredOutput: z.ZodOptional<z.ZodBoolean>
        reasoning: z.ZodOptional<z.ZodBoolean>
        attachments: z.ZodOptional<z.ZodBoolean>
        temperature: z.ZodOptional<z.ZodBoolean>
        openWeights: z.ZodOptional<z.ZodBoolean>
        embeddings: z.ZodOptional<z.ZodBoolean>
        rerank: z.ZodOptional<z.ZodBoolean>
        imageGeneration: z.ZodOptional<z.ZodBoolean>
        speechGeneration: z.ZodOptional<z.ZodBoolean>
      },
      z.core.$strip
    >
    limits: z.ZodOptional<
      z.ZodObject<
        {
          context: z.ZodOptional<z.ZodNumber>
          input: z.ZodOptional<z.ZodNumber>
          output: z.ZodOptional<z.ZodNumber>
          dimensions: z.ZodOptional<z.ZodNumber>
        },
        z.core.$strip
      >
    >
    lifecycle: z.ZodEnum<{
      deprecated: "deprecated"
      preview: "preview"
      active: "active"
      retired: "retired"
    }>
    releasedAt: z.ZodOptional<z.ZodString>
    retiredAt: z.ZodOptional<z.ZodString>
    provenance: z.ZodRecord<
      z.ZodString,
      z.ZodObject<
        {
          kind: z.ZodEnum<{
            plugin: "plugin"
            manual: "manual"
            official: "official"
            "models-dev": "models-dev"
            bundled: "bundled"
          }>
          id: z.ZodString
          url: z.ZodOptional<z.ZodString>
          observedAt: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type ModelDefinition = z.infer<typeof modelDefinitionSchema>
declare const offeringPricingSchema: z.ZodObject<
  {
    currency: z.ZodEnum<{
      USD: "USD"
      CNY: "CNY"
    }>
    inputPer1M: z.ZodOptional<z.ZodNumber>
    outputPer1M: z.ZodOptional<z.ZodNumber>
    cachedInputPer1M: z.ZodOptional<z.ZodNumber>
    cacheWritePer1M: z.ZodOptional<z.ZodNumber>
    perImage: z.ZodOptional<z.ZodNumber>
    perMinute: z.ZodOptional<z.ZodNumber>
  },
  z.core.$strip
>
type OfferingPricing = z.infer<typeof offeringPricingSchema>
declare const providerOfferingSchema: z.ZodObject<
  {
    id: z.ZodString
    providerRef: z.ZodString
    deploymentRef: z.ZodOptional<z.ZodString>
    modelRef: z.ZodString
    upstreamId: z.ZodString
    endpointType: z.ZodEnum<{
      local: "local"
      responses: "responses"
      rerank: "rerank"
      embedding: "embedding"
      speech: "speech"
      "chat-completions": "chat-completions"
      messages: "messages"
      "generate-content": "generate-content"
      images: "images"
      realtime: "realtime"
      "bedrock-runtime": "bedrock-runtime"
    }>
    lifecycle: z.ZodEnum<{
      deprecated: "deprecated"
      preview: "preview"
      active: "active"
      retired: "retired"
    }>
    available: z.ZodBoolean
    capabilities: z.ZodOptional<
      z.ZodObject<
        {
          streaming: z.ZodOptional<z.ZodBoolean>
          tools: z.ZodOptional<z.ZodBoolean>
          structuredOutput: z.ZodOptional<z.ZodBoolean>
          reasoning: z.ZodOptional<z.ZodBoolean>
          attachments: z.ZodOptional<z.ZodBoolean>
          temperature: z.ZodOptional<z.ZodBoolean>
          openWeights: z.ZodOptional<z.ZodBoolean>
          embeddings: z.ZodOptional<z.ZodBoolean>
          rerank: z.ZodOptional<z.ZodBoolean>
          imageGeneration: z.ZodOptional<z.ZodBoolean>
          speechGeneration: z.ZodOptional<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
    limits: z.ZodOptional<
      z.ZodObject<
        {
          context: z.ZodOptional<z.ZodNumber>
          input: z.ZodOptional<z.ZodNumber>
          output: z.ZodOptional<z.ZodNumber>
          dimensions: z.ZodOptional<z.ZodNumber>
        },
        z.core.$strip
      >
    >
    pricing: z.ZodOptional<
      z.ZodObject<
        {
          currency: z.ZodEnum<{
            USD: "USD"
            CNY: "CNY"
          }>
          inputPer1M: z.ZodOptional<z.ZodNumber>
          outputPer1M: z.ZodOptional<z.ZodNumber>
          cachedInputPer1M: z.ZodOptional<z.ZodNumber>
          cacheWritePer1M: z.ZodOptional<z.ZodNumber>
          perImage: z.ZodOptional<z.ZodNumber>
          perMinute: z.ZodOptional<z.ZodNumber>
        },
        z.core.$strip
      >
    >
    source: z.ZodObject<
      {
        kind: z.ZodEnum<{
          plugin: "plugin"
          manual: "manual"
          official: "official"
          "models-dev": "models-dev"
          bundled: "bundled"
        }>
        id: z.ZodString
        url: z.ZodOptional<z.ZodString>
        observedAt: z.ZodOptional<z.ZodString>
      },
      z.core.$strip
    >
  },
  z.core.$strip
>
type ProviderOffering = z.infer<typeof providerOfferingSchema>
declare const modelAliasSchema: z.ZodObject<
  {
    id: z.ZodString
    kind: z.ZodEnum<{
      legacy: "legacy"
      friendly: "friendly"
      role: "role"
    }>
    target: z.ZodObject<
      {
        type: z.ZodEnum<{
          alias: "alias"
          model: "model"
          offering: "offering"
        }>
        ref: z.ZodString
      },
      z.core.$strip
    >
    replacementRef: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type ModelAlias = z.infer<typeof modelAliasSchema>
declare const catalogRevisionSchema: z.ZodObject<
  {
    id: z.ZodString
    schemaVersion: z.ZodNumber
    generatedAt: z.ZodString
    sources: z.ZodArray<
      z.ZodObject<
        {
          kind: z.ZodEnum<{
            plugin: "plugin"
            manual: "manual"
            official: "official"
            "models-dev": "models-dev"
            bundled: "bundled"
          }>
          id: z.ZodString
          url: z.ZodOptional<z.ZodString>
          observedAt: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
    checksum: z.ZodString
    integrity: z.ZodEnum<{
      verified: "verified"
      invalid: "invalid"
      pending: "pending"
    }>
  },
  z.core.$strip
>
type CatalogRevision = z.infer<typeof catalogRevisionSchema>
declare const catalogSnapshotSchema: z.ZodObject<
  {
    revision: z.ZodObject<
      {
        id: z.ZodString
        schemaVersion: z.ZodNumber
        generatedAt: z.ZodString
        sources: z.ZodArray<
          z.ZodObject<
            {
              kind: z.ZodEnum<{
                plugin: "plugin"
                manual: "manual"
                official: "official"
                "models-dev": "models-dev"
                bundled: "bundled"
              }>
              id: z.ZodString
              url: z.ZodOptional<z.ZodString>
              observedAt: z.ZodOptional<z.ZodString>
            },
            z.core.$strip
          >
        >
        checksum: z.ZodString
        integrity: z.ZodEnum<{
          verified: "verified"
          invalid: "invalid"
          pending: "pending"
        }>
      },
      z.core.$strip
    >
    providers: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString
          name: z.ZodString
          brand: z.ZodOptional<
            z.ZodObject<
              {
                website: z.ZodOptional<z.ZodString>
                docsUrl: z.ZodOptional<z.ZodString>
                icon: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >
          >
          tier: z.ZodEnum<{
            verified: "verified"
            certified: "certified"
            experimental: "experimental"
          }>
          source: z.ZodObject<
            {
              kind: z.ZodEnum<{
                plugin: "plugin"
                manual: "manual"
                official: "official"
                "models-dev": "models-dev"
                bundled: "bundled"
              }>
              id: z.ZodString
              url: z.ZodOptional<z.ZodString>
              observedAt: z.ZodOptional<z.ZodString>
            },
            z.core.$strip
          >
          modalities: z.ZodArray<
            z.ZodEnum<{
              image: "image"
              rerank: "rerank"
              language: "language"
              embedding: "embedding"
              speech: "speech"
            }>
          >
          adapterFamilies: z.ZodArray<
            z.ZodEnum<{
              anthropic: "anthropic"
              gemini: "gemini"
              bedrock: "bedrock"
              "openai-compatible": "openai-compatible"
              openrouter: "openrouter"
              "local-openai-compatible": "local-openai-compatible"
              "azure-openai": "azure-openai"
              "vertex-ai": "vertex-ai"
            }>
          >
          connectionSchema: z.ZodObject<
            {
              fields: z.ZodArray<
                z.ZodObject<
                  {
                    id: z.ZodString
                    kind: z.ZodEnum<{
                      boolean: "boolean"
                      region: "region"
                      select: "select"
                      endpoint: "endpoint"
                      account: "account"
                      "credential-ref": "credential-ref"
                    }>
                    required: z.ZodOptional<z.ZodBoolean>
                    advanced: z.ZodOptional<z.ZodBoolean>
                    options: z.ZodOptional<z.ZodArray<z.ZodString>>
                  },
                  z.core.$strip
                >
              >
            },
            z.core.$strip
          >
        },
        z.core.$strip
      >
    >
    models: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString
          name: z.ZodString
          creator: z.ZodString
          family: z.ZodOptional<z.ZodString>
          modalities: z.ZodObject<
            {
              input: z.ZodArray<
                z.ZodEnum<{
                  text: "text"
                  image: "image"
                  audio: "audio"
                  video: "video"
                }>
              >
              output: z.ZodArray<
                z.ZodEnum<{
                  text: "text"
                  image: "image"
                  audio: "audio"
                  video: "video"
                }>
              >
            },
            z.core.$strip
          >
          capabilities: z.ZodObject<
            {
              streaming: z.ZodOptional<z.ZodBoolean>
              tools: z.ZodOptional<z.ZodBoolean>
              structuredOutput: z.ZodOptional<z.ZodBoolean>
              reasoning: z.ZodOptional<z.ZodBoolean>
              attachments: z.ZodOptional<z.ZodBoolean>
              temperature: z.ZodOptional<z.ZodBoolean>
              openWeights: z.ZodOptional<z.ZodBoolean>
              embeddings: z.ZodOptional<z.ZodBoolean>
              rerank: z.ZodOptional<z.ZodBoolean>
              imageGeneration: z.ZodOptional<z.ZodBoolean>
              speechGeneration: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strip
          >
          limits: z.ZodOptional<
            z.ZodObject<
              {
                context: z.ZodOptional<z.ZodNumber>
                input: z.ZodOptional<z.ZodNumber>
                output: z.ZodOptional<z.ZodNumber>
                dimensions: z.ZodOptional<z.ZodNumber>
              },
              z.core.$strip
            >
          >
          lifecycle: z.ZodEnum<{
            deprecated: "deprecated"
            preview: "preview"
            active: "active"
            retired: "retired"
          }>
          releasedAt: z.ZodOptional<z.ZodString>
          retiredAt: z.ZodOptional<z.ZodString>
          provenance: z.ZodRecord<
            z.ZodString,
            z.ZodObject<
              {
                kind: z.ZodEnum<{
                  plugin: "plugin"
                  manual: "manual"
                  official: "official"
                  "models-dev": "models-dev"
                  bundled: "bundled"
                }>
                id: z.ZodString
                url: z.ZodOptional<z.ZodString>
                observedAt: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >
          >
        },
        z.core.$strip
      >
    >
    offerings: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString
          providerRef: z.ZodString
          deploymentRef: z.ZodOptional<z.ZodString>
          modelRef: z.ZodString
          upstreamId: z.ZodString
          endpointType: z.ZodEnum<{
            local: "local"
            responses: "responses"
            rerank: "rerank"
            embedding: "embedding"
            speech: "speech"
            "chat-completions": "chat-completions"
            messages: "messages"
            "generate-content": "generate-content"
            images: "images"
            realtime: "realtime"
            "bedrock-runtime": "bedrock-runtime"
          }>
          lifecycle: z.ZodEnum<{
            deprecated: "deprecated"
            preview: "preview"
            active: "active"
            retired: "retired"
          }>
          available: z.ZodBoolean
          capabilities: z.ZodOptional<
            z.ZodObject<
              {
                streaming: z.ZodOptional<z.ZodBoolean>
                tools: z.ZodOptional<z.ZodBoolean>
                structuredOutput: z.ZodOptional<z.ZodBoolean>
                reasoning: z.ZodOptional<z.ZodBoolean>
                attachments: z.ZodOptional<z.ZodBoolean>
                temperature: z.ZodOptional<z.ZodBoolean>
                openWeights: z.ZodOptional<z.ZodBoolean>
                embeddings: z.ZodOptional<z.ZodBoolean>
                rerank: z.ZodOptional<z.ZodBoolean>
                imageGeneration: z.ZodOptional<z.ZodBoolean>
                speechGeneration: z.ZodOptional<z.ZodBoolean>
              },
              z.core.$strip
            >
          >
          limits: z.ZodOptional<
            z.ZodObject<
              {
                context: z.ZodOptional<z.ZodNumber>
                input: z.ZodOptional<z.ZodNumber>
                output: z.ZodOptional<z.ZodNumber>
                dimensions: z.ZodOptional<z.ZodNumber>
              },
              z.core.$strip
            >
          >
          pricing: z.ZodOptional<
            z.ZodObject<
              {
                currency: z.ZodEnum<{
                  USD: "USD"
                  CNY: "CNY"
                }>
                inputPer1M: z.ZodOptional<z.ZodNumber>
                outputPer1M: z.ZodOptional<z.ZodNumber>
                cachedInputPer1M: z.ZodOptional<z.ZodNumber>
                cacheWritePer1M: z.ZodOptional<z.ZodNumber>
                perImage: z.ZodOptional<z.ZodNumber>
                perMinute: z.ZodOptional<z.ZodNumber>
              },
              z.core.$strip
            >
          >
          source: z.ZodObject<
            {
              kind: z.ZodEnum<{
                plugin: "plugin"
                manual: "manual"
                official: "official"
                "models-dev": "models-dev"
                bundled: "bundled"
              }>
              id: z.ZodString
              url: z.ZodOptional<z.ZodString>
              observedAt: z.ZodOptional<z.ZodString>
            },
            z.core.$strip
          >
        },
        z.core.$strip
      >
    >
    aliases: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString
          kind: z.ZodEnum<{
            legacy: "legacy"
            friendly: "friendly"
            role: "role"
          }>
          target: z.ZodObject<
            {
              type: z.ZodEnum<{
                alias: "alias"
                model: "model"
                offering: "offering"
              }>
              ref: z.ZodString
            },
            z.core.$strip
          >
          replacementRef: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>
/** Installed-plugin overlay applied to the active catalog in memory. */
interface CatalogContribution {
  providers: ProviderDefinition[]
  models: ModelDefinition[]
  offerings: ProviderOffering[]
  aliases?: ModelAlias[]
}
/** Parse and validate a complete revision before it can enter staging. */
declare function parseCatalogSnapshot(value: unknown): ProfileParseResult<CatalogSnapshot>

export {
  type AdapterFamily,
  CATALOG_SCHEMA_VERSION,
  type CatalogContribution,
  type CatalogModality,
  type CatalogModelCapabilities,
  type CatalogRevision,
  type CatalogSnapshot,
  type CatalogSource,
  type CatalogTier,
  type ConnectionField,
  type ModelAlias,
  type ModelCapability,
  type ModelDataModality,
  type ModelDefinition,
  type ModelLifecycle,
  type ModelLimits,
  type OfferingPricing,
  type ProviderDefinition,
  type ProviderOffering,
  adapterFamilySchema,
  catalogModalitySchema,
  catalogRevisionSchema,
  catalogSnapshotSchema,
  catalogSourceSchema,
  catalogTierSchema,
  connectionFieldSchema,
  modelAliasSchema,
  modelCapabilitiesSchema,
  modelDataModalitySchema,
  modelDefinitionSchema,
  modelLifecycleSchema,
  modelLimitsSchema,
  offeringPricingSchema,
  parseCatalogSnapshot,
  providerDefinitionSchema,
  providerOfferingSchema,
}
