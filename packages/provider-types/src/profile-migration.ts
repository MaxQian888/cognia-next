/**
 * Legacy provider settings → Provider Profile Store derivation
 * (ADR-0090 Phase 1).
 *
 * Pure, deterministic and idempotent: the same inputs always derive the same
 * documents (stable ids, sorted output), so the settings dual-write hook can
 * hash-compare before writing and the Dexie v-upgrade can safely re-run.
 *
 * Identity rules:
 *  - Relay catalog entries (`relayOf`) fold under one vendor ProviderProfile;
 *    the DEPLOYMENT id equals the legacy provider id, so history, telemetry
 *    keys and preset templates keep resolving (`legacyAliases` is identity-
 *    preserving).
 *  - Secrets never enter the output: credentials become
 *    `{ kind: "legacy-provider-settings", providerId }` references into the
 *    row that already holds them.
 */

import type { BuiltInProviderCatalogEntry } from "./built-in-provider-catalog"
import {
  findSecretMaterialPaths,
  parseDeploymentProfile,
  parseProviderProfile,
  parseTransportProfile,
  PROFILE_STORE_SCHEMA_VERSION,
  type CredentialReference,
  type DeploymentProfile,
  type ProviderProfile,
  type TransportProfile,
} from "./provider-profile"
import { validateStaticHeaders } from "./transport-header-policy"

// Loose input shapes: real rows are widely optional / legacy-shaped, so the
// deriver is defensive rather than schema-strict about its INPUTS.
export interface LegacyProviderSettingsRow {
  providerId?: string
  enabled?: boolean
  baseURL?: string
  defaultModel?: string
  customHeaders?: Record<string, string>
  apiKey?: string
  apiKeys?: string[]
}

export interface LegacyCustomProviderRow {
  id?: string
  name?: string
  enabled?: boolean
  protocol?: string
  baseURL?: string
  defaultModel?: string
  models?: Array<{ id?: string; name?: string } | string>
  customHeaders?: Record<string, string>
}

export interface DeriveProfilesInput {
  providerSettings?: Record<string, LegacyProviderSettingsRow | undefined>
  customProviders?: LegacyCustomProviderRow[]
  catalog: readonly BuiltInProviderCatalogEntry[]
}

export interface DerivedProfiles {
  providerProfiles: ProviderProfile[]
  deploymentProfiles: DeploymentProfile[]
  transportProfiles: TransportProfile[]
  /** oldProviderId → deploymentId. Identity-preserving for migrated rows. */
  legacyAliases: Record<string, string>
}

/**
 * Endpoint sentinel for deployments whose runtime resolves the vendor's SDK
 * default URL (no baseURL configured anywhere). Consumers treat
 * `builtin:<id>` as "use the built-in default for this provider id".
 */
export function builtinEndpointSentinel(providerId: string): string {
  return `builtin:${providerId}`
}

function transportAuthFor(protocol: string): TransportProfile["auth"] {
  return protocol === "anthropic" ? { scheme: "x-api-key" } : { scheme: "bearer" }
}

function sharedTransportId(protocol: string): string {
  const auth = transportAuthFor(protocol).scheme
  return `tp-${protocol}-${auth}`
}

function sanitizedStaticHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined
  const violations = new Set(validateStaticHeaders(headers).map((v) => v.name))
  const clean = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !violations.has(name))
  )
  return Object.keys(clean).length > 0 ? clean : undefined
}

function normalizedModels(
  entry: BuiltInProviderCatalogEntry | undefined,
  row: LegacyProviderSettingsRow | undefined
): DeploymentProfile["models"] {
  const ids = new Set<string>()
  for (const model of entry?.models ?? []) ids.add(model.id)
  if (row?.defaultModel) ids.add(row.defaultModel)
  if (entry?.defaultModel) ids.add(entry.defaultModel)
  return [...ids].sort().map((id) => ({ id }))
}

interface VendorAccumulator {
  id: string
  displayName: string
  deploymentRefs: string[]
}

/** Derive the full profile document set from legacy settings + catalog. */
export function deriveProfiles(input: DeriveProfilesInput): DerivedProfiles {
  const catalogById = new Map(input.catalog.map((entry) => [entry.id, entry]))
  const vendors = new Map<string, VendorAccumulator>()
  const deployments: DeploymentProfile[] = []
  const transports = new Map<string, TransportProfile>()
  const legacyAliases: Record<string, string> = {}

  const ensureVendor = (id: string, displayName?: string): VendorAccumulator => {
    let vendor = vendors.get(id)
    if (!vendor) {
      const entry = catalogById.get(id)
      vendor = { id, displayName: displayName ?? entry?.name ?? id, deploymentRefs: [] }
      vendors.set(id, vendor)
    }
    return vendor
  }

  const ensureTransport = (
    deploymentId: string,
    protocol: string,
    customHeaders: Record<string, string> | undefined
  ): string => {
    const staticHeaders = sanitizedStaticHeaders(customHeaders)
    if (!staticHeaders) {
      const id = sharedTransportId(protocol)
      if (!transports.has(id)) {
        transports.set(id, { id, protocol, auth: transportAuthFor(protocol) })
      }
      return id
    }
    // Per-deployment headers get a dedicated transport so shared ones stay
    // header-free.
    const id = `tp-${deploymentId}`
    transports.set(id, { id, protocol, auth: transportAuthFor(protocol), staticHeaders })
    return id
  }

  // ---- Built-in provider rows ----------------------------------------------
  const settingsEntries = Object.entries(input.providerSettings ?? {})
    .filter((pair): pair is [string, LegacyProviderSettingsRow] => Boolean(pair[1]))
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [providerId, row] of settingsEntries) {
    const entry = catalogById.get(providerId)
    const protocol = entry?.protocol ?? "openai"
    const vendorId = entry?.relayOf ?? providerId
    const vendor = ensureVendor(vendorId)

    const endpoint =
      row.baseURL?.trim() || entry?.defaultBaseURL || builtinEndpointSentinel(providerId)
    const credential: CredentialReference = {
      kind: "legacy-provider-settings",
      providerId,
    }
    const primary = row.defaultModel || entry?.defaultModel

    const deployment: DeploymentProfile = {
      id: providerId,
      providerRef: vendorId,
      endpoint,
      transportProfileRef: ensureTransport(providerId, protocol, row.customHeaders),
      credentialProfileRef: credential,
      models: normalizedModels(entry, row),
      ...(primary ? { modelRoles: { primary } } : {}),
      legacyProviderId: providerId,
      enabled: row.enabled !== false,
    }
    deployments.push(deployment)
    vendor.deploymentRefs.push(providerId)
    legacyAliases[providerId] = providerId
  }

  // ---- Custom providers -----------------------------------------------------
  const customRows = [...(input.customProviders ?? [])]
    .filter((row): row is LegacyCustomProviderRow & { id: string } => Boolean(row?.id))
    .sort((a, b) => a.id.localeCompare(b.id))

  for (const row of customRows) {
    const protocol = row.protocol === "anthropic" ? "anthropic" : (row.protocol ?? "openai")
    const vendor = ensureVendor(row.id, row.name ?? row.id)
    const modelIds = new Set<string>()
    for (const model of row.models ?? []) {
      const id = typeof model === "string" ? model : model?.id
      if (id) modelIds.add(id)
    }
    if (row.defaultModel) modelIds.add(row.defaultModel)

    const deployment: DeploymentProfile = {
      id: row.id,
      providerRef: row.id,
      endpoint: row.baseURL?.trim() || builtinEndpointSentinel(row.id),
      transportProfileRef: ensureTransport(row.id, protocol, row.customHeaders),
      credentialProfileRef: { kind: "legacy-provider-settings", providerId: row.id },
      models: [...modelIds].sort().map((id) => ({ id })),
      ...(row.defaultModel ? { modelRoles: { primary: row.defaultModel } } : {}),
      legacyProviderId: row.id,
      enabled: row.enabled !== false,
    }
    deployments.push(deployment)
    vendor.deploymentRefs.push(row.id)
    legacyAliases[row.id] = row.id
  }

  const providerProfiles = [...vendors.values()]
    .map((vendor) => ({
      id: vendor.id,
      displayName: vendor.displayName,
      deploymentRefs: [...vendor.deploymentRefs].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    providerProfiles,
    deploymentProfiles: deployments.sort((a, b) => a.id.localeCompare(b.id)),
    transportProfiles: [...transports.values()].sort((a, b) => a.id.localeCompare(b.id)),
    legacyAliases,
  }
}

// ---- Redacted export / import ----------------------------------------------

export interface ProfilesExport {
  schemaVersion: number
  profileVersion: number
  providerProfiles: ProviderProfile[]
  deploymentProfiles: DeploymentProfile[]
  transportProfiles: TransportProfile[]
  legacyAliases: Record<string, string>
}

/** Serialize derived profiles for admin export. Secret-free by construction. */
export function exportProfilesRedacted(
  derived: DerivedProfiles,
  profileVersion: number
): ProfilesExport {
  return {
    schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
    profileVersion,
    providerProfiles: derived.providerProfiles,
    deploymentProfiles: derived.deploymentProfiles,
    transportProfiles: derived.transportProfiles,
    legacyAliases: derived.legacyAliases,
  }
}

export type ImportProfilesResult =
  { ok: true; value: ProfilesExport } | { ok: false; errors: string[] }

/** Validate an export payload for import: schema, doc shapes, secret scan. */
export function importProfiles(value: unknown): ImportProfilesResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["import payload must be an object"] }
  }
  const payload = value as Record<string, unknown>
  const errors: string[] = []

  const schemaVersion = payload.schemaVersion
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    errors.push("schemaVersion must be an integer")
  } else if (schemaVersion > PROFILE_STORE_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion ${schemaVersion} is newer than supported ${PROFILE_STORE_SCHEMA_VERSION}`
    )
  }
  const profileVersion = payload.profileVersion
  if (
    typeof profileVersion !== "number" ||
    !Number.isInteger(profileVersion) ||
    profileVersion < 0
  ) {
    errors.push("profileVersion must be a non-negative integer")
  }

  const secretPaths = findSecretMaterialPaths(payload)
  if (secretPaths.length > 0) {
    errors.push(...secretPaths.map((p) => `secret material is not allowed at "${p}"`))
  }

  const collect = <T>(
    key: "providerProfiles" | "deploymentProfiles" | "transportProfiles",
    parse: (v: unknown) => { ok: true; value: T } | { ok: false; errors: string[] }
  ): T[] => {
    const raw = payload[key]
    if (!Array.isArray(raw)) {
      errors.push(`${key} must be an array`)
      return []
    }
    const out: T[] = []
    raw.forEach((doc, index) => {
      const parsed = parse(doc)
      if (parsed.ok) out.push(parsed.value)
      else errors.push(...parsed.errors.map((e) => `${key}[${index}]: ${e}`))
    })
    return out
  }

  const providerProfiles = collect("providerProfiles", parseProviderProfile)
  const deploymentProfiles = collect("deploymentProfiles", parseDeploymentProfile)
  const transportProfiles = collect("transportProfiles", parseTransportProfile)

  const legacyAliases = payload.legacyAliases
  const aliasesValid =
    typeof legacyAliases === "object" &&
    legacyAliases !== null &&
    !Array.isArray(legacyAliases) &&
    Object.values(legacyAliases as Record<string, unknown>).every((v) => typeof v === "string")
  if (!aliasesValid) errors.push("legacyAliases must be a string→string record")

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      schemaVersion: schemaVersion as number,
      profileVersion: profileVersion as number,
      providerProfiles,
      deploymentProfiles,
      transportProfiles,
      legacyAliases: legacyAliases as Record<string, string>,
    },
  }
}
