// Desktop projection of certification manifests (ADR-0090 Phase 5).
//
// The bundle DIRECTORY is the authority (`certification-store.ts`); this
// Dexie table only indexes manifests for the settings UI (list, staleness
// badges) and is rebuilt from the files at any time — losing it loses
// nothing.

import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import { compatibilityKeyId } from "@cognia/agent-config-types/compatibility-manifest"

import type { CertificationStore } from "@/lib/ai/agent/execution/certification-store"

import { getDb } from "./schema"

export interface AgentCompatibilityRecordRow {
  /** `compatibilityKeyId(manifest.key)` — the unique execution-path id. */
  keyId: string
  bundleId: string
  deploymentRef: string
  evidence: CompatibilityManifest["evidence"]
  level: CompatibilityManifest["level"]
  issuer: CompatibilityManifest["issuer"]
  issuedAt: string
  expiresAt?: string
  /** The full manifest for the detail panel (secret-free by schema). */
  manifest: CompatibilityManifest
}

export async function listCompatibilityRecords(): Promise<AgentCompatibilityRecordRow[]> {
  return getDb().agentCompatibilityRecords.toArray()
}

export async function recordsForDeployment(
  deploymentRef: string
): Promise<AgentCompatibilityRecordRow[]> {
  return getDb().agentCompatibilityRecords.where("deploymentRef").equals(deploymentRef).toArray()
}

/** Rebuild the projection from the bundle files (authority). */
export async function rebuildCompatibilityProjection(store: CertificationStore): Promise<number> {
  const rows: AgentCompatibilityRecordRow[] = []
  for (const bundleId of await store.listBundles()) {
    const manifest = await store.readManifest(bundleId)
    if (!manifest) continue
    rows.push({
      keyId: compatibilityKeyId(manifest.key),
      bundleId: manifest.bundleId,
      deploymentRef: manifest.key.deploymentRef,
      evidence: manifest.evidence,
      level: manifest.level,
      issuer: manifest.issuer,
      issuedAt: manifest.issuedAt,
      ...(manifest.expiresAt ? { expiresAt: manifest.expiresAt } : {}),
      manifest,
    })
  }
  const db = getDb()
  await db.transaction("rw", db.agentCompatibilityRecords, async () => {
    await db.agentCompatibilityRecords.clear()
    await db.agentCompatibilityRecords.bulkPut(rows)
  })
  return rows.length
}
