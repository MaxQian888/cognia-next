// Compatibility facade for the v1 import surface. Delegates to
// `migrateEnvelope` (handles v1 → v3 + integrity) followed by
// `applyBackupPackage` (the merge engine). Removed in Phase 8.

import { migrateEnvelope } from "./migrate"
import { applyBackupPackage } from "./apply-package"
import type { BackupPackageV3, ImportOptions, ImportSummary } from "./types"

/**
 * Old call sites parsed JSON, then handed the raw object here. Keep that
 * shape: validate-or-migrate, then apply.
 */
export async function validateEnvelope(input: unknown): Promise<BackupPackageV3> {
  return migrateEnvelope(input)
}

export async function importEnvelope(
  envelope: unknown,
  opts: ImportOptions
): Promise<ImportSummary> {
  const pkg = await migrateEnvelope(envelope)
  return applyBackupPackage(pkg, opts)
}

export { applyBackupPackage, migrateEnvelope }
