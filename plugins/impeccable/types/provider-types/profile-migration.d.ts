import { BuiltInProviderCatalogEntry } from "./built-in-provider-catalog.js"
import { ProviderProfile, DeploymentProfile, TransportProfile } from "./provider-profile.js"
import "zod"

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

interface LegacyProviderSettingsRow {
  providerId?: string
  enabled?: boolean
  baseURL?: string
  defaultModel?: string
  customHeaders?: Record<string, string>
  apiKey?: string
  apiKeys?: string[]
}
interface LegacyCustomProviderRow {
  id?: string
  name?: string
  enabled?: boolean
  protocol?: string
  baseURL?: string
  defaultModel?: string
  models?: Array<
    | {
        id?: string
        name?: string
      }
    | string
  >
  customHeaders?: Record<string, string>
}
interface DeriveProfilesInput {
  providerSettings?: Record<string, LegacyProviderSettingsRow | undefined>
  customProviders?: LegacyCustomProviderRow[]
  catalog: readonly BuiltInProviderCatalogEntry[]
}
interface DerivedProfiles {
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
declare function builtinEndpointSentinel(providerId: string): string
/** Idempotently upgrade one v1 deployment document to the v2 model links. */
declare function upgradeDeploymentProfileCatalogRefs(
  deployment: DeploymentProfile
): DeploymentProfile
/** Derive the full profile document set from legacy settings + catalog. */
declare function deriveProfiles(input: DeriveProfilesInput): DerivedProfiles
interface ProfilesExport {
  schemaVersion: number
  profileVersion: number
  providerProfiles: ProviderProfile[]
  deploymentProfiles: DeploymentProfile[]
  transportProfiles: TransportProfile[]
  legacyAliases: Record<string, string>
}
/** Serialize derived profiles for admin export. Secret-free by construction. */
declare function exportProfilesRedacted(
  derived: DerivedProfiles,
  profileVersion: number
): ProfilesExport
type ImportProfilesResult =
  | {
      ok: true
      value: ProfilesExport
    }
  | {
      ok: false
      errors: string[]
    }
/** Validate an export payload for import: schema, doc shapes, secret scan. */
declare function importProfiles(value: unknown): ImportProfilesResult

export {
  type DeriveProfilesInput,
  type DerivedProfiles,
  type ImportProfilesResult,
  type LegacyCustomProviderRow,
  type LegacyProviderSettingsRow,
  type ProfilesExport,
  builtinEndpointSentinel,
  deriveProfiles,
  exportProfilesRedacted,
  importProfiles,
  upgradeDeploymentProfileCatalogRefs,
}
