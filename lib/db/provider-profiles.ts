// Provider Profile Store — Dexie accessors (ADR-0090 Phase 1).
//
// The four v121 tables hold DERIVED, secret-free projections of the legacy
// providerSettings/customProviders rows (see
// `@cognia/provider-types/profile-migration`). Writers go through
// `putDerivedProfiles`, which replaces the whole document set transactionally
// and bumps the CAS `profileVersion` — the version the Gateway snapshot
// authority check (Phase 2 / R3) keys off.

import type {
  DeploymentProfile,
  ProviderProfile,
  TransportProfile,
} from "@cognia/provider-types/provider-profile"
import { PROFILE_STORE_SCHEMA_VERSION } from "@cognia/provider-types/provider-profile"
import type { DerivedProfiles, ProfilesExport } from "@cognia/provider-types/profile-migration"
import {
  exportProfilesRedacted,
  importProfiles as validateProfilesImport,
} from "@cognia/provider-types/profile-migration"

import { getDb } from "./schema"

export interface ProfileStoreMetaRow {
  id: "singleton"
  /** Monotonic CAS counter bumped on every derived write. */
  profileVersion: number
  schemaVersion: number
  migratedAt?: string
}

const META_ID = "singleton" as const

export async function getProfileMeta(): Promise<ProfileStoreMetaRow | undefined> {
  return getDb().profileStoreMeta.get(META_ID)
}

export async function listProviderProfiles(): Promise<ProviderProfile[]> {
  return getDb().providerProfiles.toArray()
}

export async function listDeploymentProfiles(): Promise<DeploymentProfile[]> {
  return getDb().deploymentProfiles.toArray()
}

export async function listTransportProfiles(): Promise<TransportProfile[]> {
  return getDb().transportProfiles.toArray()
}

export async function getDeploymentProfile(id: string): Promise<DeploymentProfile | undefined> {
  return getDb().deploymentProfiles.get(id)
}

/** Deployments derived from a given legacy provider id (usually exactly one). */
export async function deploymentsForLegacyProvider(
  legacyProviderId: string
): Promise<DeploymentProfile[]> {
  return getDb().deploymentProfiles.where("legacyProviderId").equals(legacyProviderId).toArray()
}

/**
 * Transactionally replace the derived document set and bump `profileVersion`.
 * Returns the new version. The replace is whole-set (clear + bulkPut) because
 * derivation is authoritative: a row absent from `derived` was deleted at the
 * source.
 */
export async function putDerivedProfiles(derived: DerivedProfiles): Promise<number> {
  const db = getDb()
  return db.transaction(
    "rw",
    [db.providerProfiles, db.deploymentProfiles, db.transportProfiles, db.profileStoreMeta],
    async () => {
      const meta = await db.profileStoreMeta.get(META_ID)
      const nextVersion = (meta?.profileVersion ?? 0) + 1
      await db.providerProfiles.clear()
      await db.deploymentProfiles.clear()
      await db.transportProfiles.clear()
      await db.providerProfiles.bulkPut(derived.providerProfiles)
      await db.deploymentProfiles.bulkPut(derived.deploymentProfiles)
      await db.transportProfiles.bulkPut(derived.transportProfiles)
      await db.profileStoreMeta.put({
        id: META_ID,
        profileVersion: nextVersion,
        schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
        migratedAt: new Date().toISOString(),
      })
      return nextVersion
    }
  )
}

/** Redacted export of the current store (admin surface / debugging). */
export async function exportStoredProfilesRedacted(): Promise<ProfilesExport> {
  const db = getDb()
  const [providerProfiles, deploymentProfiles, transportProfiles, meta] = await Promise.all([
    db.providerProfiles.toArray(),
    db.deploymentProfiles.toArray(),
    db.transportProfiles.toArray(),
    db.profileStoreMeta.get(META_ID),
  ])
  const legacyAliases: Record<string, string> = {}
  for (const deployment of deploymentProfiles) {
    if (deployment.legacyProviderId) legacyAliases[deployment.legacyProviderId] = deployment.id
  }
  return exportProfilesRedacted(
    { providerProfiles, deploymentProfiles, transportProfiles, legacyAliases },
    meta?.profileVersion ?? 0
  )
}

export type ImportStoredProfilesResult =
  { ok: true; profileVersion: number } | { ok: false; errors: string[] }

/** Validate + apply an exported payload (schema-checked, secret-refused). */
export async function importStoredProfiles(value: unknown): Promise<ImportStoredProfilesResult> {
  const parsed = validateProfilesImport(value)
  if (!parsed.ok) return parsed
  const version = await putDerivedProfiles({
    providerProfiles: parsed.value.providerProfiles,
    deploymentProfiles: parsed.value.deploymentProfiles,
    transportProfiles: parsed.value.transportProfiles,
    legacyAliases: parsed.value.legacyAliases,
  })
  return { ok: true, profileVersion: version }
}
