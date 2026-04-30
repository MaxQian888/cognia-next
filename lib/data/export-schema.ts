// Backwards-compat barrel. The contracts now live in `./types.ts`. New code
// should import from `@/lib/data/types` directly.

export {
  EXPORT_SCHEMA_VERSION,
  IsEncryptedError,
  UnsupportedSchemaVersionError,
  IntegrityCheckFailedError,
  emptySummary,
} from "./types"

export type {
  BackupManifestV3,
  BackupPackageV3,
  BackupPayloadV3,
  EncryptedEnvelopeV1,
  ExportOptions,
  ImportMergeStrategy,
  ImportOptions,
  ImportSummary,
} from "./types"

// v1 callers consumed `ExportEnvelope`. The shape is gone, but consumers can
// still rely on the v3 package — they'll see the same payload fields nested
// under `payload`. Provide a type alias for the few call sites that haven't
// been migrated yet (they get refactored in Phase 8).
export type { BackupPackageV3 as ExportEnvelope } from "./types"
