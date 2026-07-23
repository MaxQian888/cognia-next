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

import { z } from "zod"

/** Bump when a document shape changes incompatibly. Readers refuse newer. */
export const PROFILE_STORE_SCHEMA_VERSION = 1

// ---- Credential references --------------------------------------------------

/**
 * Where a deployment's credential actually lives. Never a value.
 *  - `legacy-provider-settings`: the AppSettings providerSettings row (desktop).
 *  - `subscription-vault`: the subscription keyring entry (ccswitch et al.).
 *  - `secret-store`: the cognia-secrets encrypted store (headless + desktop).
 *  - `env`: an environment variable on the executing host (headless bootstrap).
 */
export const credentialReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy-provider-settings"), providerId: z.string().min(1) }),
  z.object({ kind: z.literal("subscription-vault"), providerId: z.string().min(1) }),
  z.object({ kind: z.literal("secret-store"), secretId: z.string().min(1) }),
  z.object({ kind: z.literal("env"), var: z.string().min(1) }),
])
export type CredentialReference = z.infer<typeof credentialReferenceSchema>

// ---- Transport --------------------------------------------------------------

export const transportAuthSchema = z.discriminatedUnion("scheme", [
  z.object({ scheme: z.literal("x-api-key") }),
  z.object({ scheme: z.literal("bearer") }),
  z.object({ scheme: z.literal("custom-header"), name: z.string().min(1) }),
])
export type TransportAuth = z.infer<typeof transportAuthSchema>

export const transportProfileSchema = z.object({
  id: z.string().min(1),
  /** Wire protocol family: "anthropic" | "openai" | forward-compatible ids. */
  protocol: z.string().min(1),
  auth: transportAuthSchema,
  /**
   * Extra headers stamped on every upstream request. Names/values must pass
   * the shared header policy (`transport-header-policy.ts`) — the store
   * validators reject documents that don't.
   */
  staticHeaders: z.record(z.string(), z.string()).optional(),
  /**
   * Inbound semantic headers forwarded upstream on same-protocol routes,
   * in addition to the policy's built-in semantic allowlist.
   */
  forwardedSemanticHeaders: z.array(z.string().min(1)).optional(),
})
export type TransportProfile = z.infer<typeof transportProfileSchema>

// ---- Deployment -------------------------------------------------------------

export const deploymentModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  /** Upstream model id when it differs from the catalog id. */
  upstreamId: z.string().optional(),
})
export type DeploymentModel = z.infer<typeof deploymentModelSchema>

/**
 * Role bindings consumed by Agent SDK model selectors (primary/fast/powerful)
 * and frozen into Gateway route tickets (Phase 2). Declared now so ticket
 * minting never forces a document schema bump.
 */
export const deploymentModelRolesSchema = z.object({
  primary: z.string().min(1).optional(),
  fast: z.string().min(1).optional(),
  powerful: z.string().min(1).optional(),
})
export type DeploymentModelRoles = z.infer<typeof deploymentModelRolesSchema>

export const deploymentProfileSchema = z.object({
  id: z.string().min(1),
  providerRef: z.string().min(1),
  endpoint: z.string().min(1),
  region: z.string().optional(),
  transportProfileRef: z.string().min(1),
  credentialProfileRef: credentialReferenceSchema.optional(),
  models: z.array(deploymentModelSchema),
  modelRoles: deploymentModelRolesSchema.optional(),
  /**
   * The pre-Phase-1 provider id this deployment was derived from. Identity-
   * preserving: `id === legacyProviderId` for migrated rows so history,
   * telemetry keys and preset templates keep resolving.
   */
  legacyProviderId: z.string().optional(),
  enabled: z.boolean().optional(),
})
export type DeploymentProfile = z.infer<typeof deploymentProfileSchema>

// ---- Provider ---------------------------------------------------------------

export const providerProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  deploymentRefs: z.array(z.string().min(1)),
})
export type ProviderProfile = z.infer<typeof providerProfileSchema>

// ---- Store meta -------------------------------------------------------------

export const profileStoreMetaSchema = z.object({
  /** Monotonic CAS counter bumped on every derived-profile write. */
  profileVersion: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  /** ISO timestamp of the last migration/derivation run. */
  migratedAt: z.string().optional(),
})
export type ProfileStoreMeta = z.infer<typeof profileStoreMetaSchema>

// ---- Secret hygiene ---------------------------------------------------------

const SECRET_FIELD_NAMES = /^(apiKey|api_key|secret|token|password|bearerToken|authorization)$/i

/** Deep-scan a document for embedded secret-shaped FIELD NAMES. */
export function findSecretMaterialPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecretMaterialPaths(item, `${path}[${index}]`))
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key
      const own = SECRET_FIELD_NAMES.test(key) ? [childPath] : []
      return [...own, ...findSecretMaterialPaths(child, childPath)]
    })
  }
  return []
}

// ---- Parse helpers ----------------------------------------------------------

export interface ProfileParseFailure {
  ok: false
  errors: string[]
}
export type ProfileParseResult<T> = { ok: true; value: T } | ProfileParseFailure

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): ProfileParseResult<T> {
  const secretPaths = findSecretMaterialPaths(value)
  if (secretPaths.length > 0) {
    return {
      ok: false,
      errors: secretPaths.map((p) => `${label}: secret material is not allowed at "${p}"`),
    }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${label}.${issue.path.join(".")}: ${issue.message}`
      ),
    }
  }
  return { ok: true, value: parsed.data }
}

export function parseProviderProfile(value: unknown): ProfileParseResult<ProviderProfile> {
  return parseWith(providerProfileSchema, value, "providerProfile")
}

export function parseDeploymentProfile(value: unknown): ProfileParseResult<DeploymentProfile> {
  return parseWith(deploymentProfileSchema, value, "deploymentProfile")
}

export function parseTransportProfile(value: unknown): ProfileParseResult<TransportProfile> {
  return parseWith(transportProfileSchema, value, "transportProfile")
}

export function parseProfileStoreMeta(value: unknown): ProfileParseResult<ProfileStoreMeta> {
  const parsed = parseWith(profileStoreMetaSchema, value, "profileStoreMeta")
  if (!parsed.ok) return parsed
  if (parsed.value.schemaVersion > PROFILE_STORE_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `profileStoreMeta.schemaVersion ${parsed.value.schemaVersion} is newer than supported ${PROFILE_STORE_SCHEMA_VERSION}`,
      ],
    }
  }
  return parsed
}
