// Compatibility facade: the original v1 export entry point now delegates to
// `buildBackupPackage` and serializes the result. Removed in Phase 8 once
// callers have switched to the v3 API directly.

import { buildBackupPackage, defaultExportFileName, serializePackage } from "./build-package"
import type { BackupPackageV3, ExportOptions } from "./types"

/** Returns the v3 package object (callers can serialize themselves if needed). */
export async function buildExportEnvelope(opts: ExportOptions): Promise<BackupPackageV3> {
  return buildBackupPackage(opts)
}

export { defaultExportFileName, serializePackage, buildBackupPackage }
export { buildBackupStream, buildBackupSections } from "./build-stream"
export { readBackupStream } from "./stream-format"
