import { z } from "zod"

/**
 * Provider Profile Store document types (ADR-0090 Phase 1).
 *
 * Separates three concerns the legacy `providerSettings` row conflates:
 *  - `ProviderProfile`   — the vendor ("who" — zhipu, moonshot, a custom org);
 *  - `DeploymentProfile` — one reachable endpoint of that vendor ("where" —
 *    incl. the `*-anthropic` relays, which are deployments, not vendors);
 *  - `TransportProfile`  — wire behavior ("how" — protocol, auth scheme,
 *    static headers, semantic header forwarding).
 *
 * Documents are secret-free by contract: credentials appear only as
 * `CredentialReference`s into existing secret storage. The same JSON shapes
 * are mirrored by the Rust store (`src-tauri/src/provider_profiles/`) and the
 * Gateway snapshot projection — serde uses camelCase to match.
 */

/** Bump when a document shape changes incompatibly. Readers refuse newer. */
declare const PROFILE_STORE_SCHEMA_VERSION = 2
/**
 * Where a deployment's credential actually lives. Never a value.
 *  - `legacy-provider-settings`: the AppSettings providerSettings row (desktop).
 *  - `subscription-vault`: the subscription keyring entry (ccswitch et al.).
 *  - `secret-store`: the cognia-secrets encrypted store (headless + desktop).
 *  - `env`: an environment variable on the executing host (headless bootstrap).
 */
declare const credentialReferenceSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        kind: z.ZodLiteral<"legacy-provider-settings">
        providerId: z.ZodString
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        kind: z.ZodLiteral<"subscription-vault">
        providerId: z.ZodString
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        kind: z.ZodLiteral<"secret-store">
        secretId: z.ZodString
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        kind: z.ZodLiteral<"env">
        var: z.ZodString
      },
      z.core.$strip
    >,
  ],
  "kind"
>
type CredentialReference = z.infer<typeof credentialReferenceSchema>
declare const transportAuthSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        scheme: z.ZodLiteral<"x-api-key">
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        scheme: z.ZodLiteral<"bearer">
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        scheme: z.ZodLiteral<"custom-header">
        name: z.ZodString
      },
      z.core.$strip
    >,
  ],
  "scheme"
>
type TransportAuth = z.infer<typeof transportAuthSchema>
declare const transportProfileSchema: z.ZodObject<
  {
    id: z.ZodString
    protocol: z.ZodString
    auth: z.ZodDiscriminatedUnion<
      [
        z.ZodObject<
          {
            scheme: z.ZodLiteral<"x-api-key">
          },
          z.core.$strip
        >,
        z.ZodObject<
          {
            scheme: z.ZodLiteral<"bearer">
          },
          z.core.$strip
        >,
        z.ZodObject<
          {
            scheme: z.ZodLiteral<"custom-header">
            name: z.ZodString
          },
          z.core.$strip
        >,
      ],
      "scheme"
    >
    staticHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    forwardedSemanticHeaders: z.ZodOptional<z.ZodArray<z.ZodString>>
  },
  z.core.$strip
>
type TransportProfile = z.infer<typeof transportProfileSchema>
declare const deploymentModelSchema: z.ZodObject<
  {
    id: z.ZodString
    displayName: z.ZodOptional<z.ZodString>
    upstreamId: z.ZodOptional<z.ZodString>
    offeringRef: z.ZodOptional<z.ZodString>
    canonicalModelRef: z.ZodOptional<z.ZodString>
    userOverride: z.ZodOptional<
      z.ZodObject<
        {
          displayName: z.ZodOptional<z.ZodString>
          enabled: z.ZodOptional<z.ZodBoolean>
          limits: z.ZodOptional<
            z.ZodObject<
              {
                context: z.ZodOptional<z.ZodNumber>
                output: z.ZodOptional<z.ZodNumber>
                dimensions: z.ZodOptional<z.ZodNumber>
              },
              z.core.$strip
            >
          >
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
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type DeploymentModel = z.infer<typeof deploymentModelSchema>
/**
 * Role bindings consumed by Agent SDK model selectors (primary/fast/powerful)
 * and frozen into Gateway route tickets (Phase 2). Declared now so ticket
 * minting never forces a document schema bump.
 */
declare const deploymentModelRolesSchema: z.ZodObject<
  {
    primary: z.ZodOptional<z.ZodString>
    fast: z.ZodOptional<z.ZodString>
    powerful: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type DeploymentModelRoles = z.infer<typeof deploymentModelRolesSchema>
declare const deploymentProfileSchema: z.ZodObject<
  {
    id: z.ZodString
    providerRef: z.ZodString
    endpoint: z.ZodString
    region: z.ZodOptional<z.ZodString>
    transportProfileRef: z.ZodString
    credentialProfileRef: z.ZodOptional<
      z.ZodDiscriminatedUnion<
        [
          z.ZodObject<
            {
              kind: z.ZodLiteral<"legacy-provider-settings">
              providerId: z.ZodString
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              kind: z.ZodLiteral<"subscription-vault">
              providerId: z.ZodString
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              kind: z.ZodLiteral<"secret-store">
              secretId: z.ZodString
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              kind: z.ZodLiteral<"env">
              var: z.ZodString
            },
            z.core.$strip
          >,
        ],
        "kind"
      >
    >
    models: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString
          displayName: z.ZodOptional<z.ZodString>
          upstreamId: z.ZodOptional<z.ZodString>
          offeringRef: z.ZodOptional<z.ZodString>
          canonicalModelRef: z.ZodOptional<z.ZodString>
          userOverride: z.ZodOptional<
            z.ZodObject<
              {
                displayName: z.ZodOptional<z.ZodString>
                enabled: z.ZodOptional<z.ZodBoolean>
                limits: z.ZodOptional<
                  z.ZodObject<
                    {
                      context: z.ZodOptional<z.ZodNumber>
                      output: z.ZodOptional<z.ZodNumber>
                      dimensions: z.ZodOptional<z.ZodNumber>
                    },
                    z.core.$strip
                  >
                >
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
              },
              z.core.$strip
            >
          >
        },
        z.core.$strip
      >
    >
    modelRoles: z.ZodOptional<
      z.ZodObject<
        {
          primary: z.ZodOptional<z.ZodString>
          fast: z.ZodOptional<z.ZodString>
          powerful: z.ZodOptional<z.ZodString>
        },
        z.core.$strip
      >
    >
    legacyProviderId: z.ZodOptional<z.ZodString>
    enabled: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
type DeploymentProfile = z.infer<typeof deploymentProfileSchema>
declare const providerProfileSchema: z.ZodObject<
  {
    id: z.ZodString
    displayName: z.ZodString
    deploymentRefs: z.ZodArray<z.ZodString>
  },
  z.core.$strip
>
type ProviderProfile = z.infer<typeof providerProfileSchema>
declare const profileStoreMetaSchema: z.ZodObject<
  {
    profileVersion: z.ZodNumber
    schemaVersion: z.ZodNumber
    migratedAt: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type ProfileStoreMeta = z.infer<typeof profileStoreMetaSchema>
/** Deep-scan a document for embedded secret-shaped FIELD NAMES. */
declare function findSecretMaterialPaths(value: unknown, path?: string): string[]
interface ProfileParseFailure {
  ok: false
  errors: string[]
}
type ProfileParseResult<T> =
  | {
      ok: true
      value: T
    }
  | ProfileParseFailure
declare function parseProviderProfile(value: unknown): ProfileParseResult<ProviderProfile>
declare function parseDeploymentProfile(value: unknown): ProfileParseResult<DeploymentProfile>
declare function parseTransportProfile(value: unknown): ProfileParseResult<TransportProfile>
declare function parseProfileStoreMeta(value: unknown): ProfileParseResult<ProfileStoreMeta>

export {
  type CredentialReference,
  type DeploymentModel,
  type DeploymentModelRoles,
  type DeploymentProfile,
  PROFILE_STORE_SCHEMA_VERSION,
  type ProfileParseFailure,
  type ProfileParseResult,
  type ProfileStoreMeta,
  type ProviderProfile,
  type TransportAuth,
  type TransportProfile,
  credentialReferenceSchema,
  deploymentModelRolesSchema,
  deploymentModelSchema,
  deploymentProfileSchema,
  findSecretMaterialPaths,
  parseDeploymentProfile,
  parseProfileStoreMeta,
  parseProviderProfile,
  parseTransportProfile,
  profileStoreMetaSchema,
  providerProfileSchema,
  transportAuthSchema,
  transportProfileSchema,
}
