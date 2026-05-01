/**
 * Stub for `@/lib/storage/persistence/backend-verifier`.
 *
 * Cognia ships a verifier that probes a backend's `config → reach → operate`
 * stages. cognia-next's vector backends are remote HTTP services; the ported
 * code only needs the type contract and a diagnostic factory.
 */

import type {
  StorageBackendDiagnostic,
  StorageBackendId,
  StorageBackendReadinessRecord,
} from "./types"

export interface StorageBackendVerificationOptions {
  checkedAt?: string
  probeOperational?: boolean
}

export interface StorageBackendVerifier<TConfig = unknown> {
  readonly backendId: StorageBackendId
  verifyReadiness(
    config: TConfig,
    options?: StorageBackendVerificationOptions
  ): Promise<StorageBackendReadinessRecord>
}

export function createStorageBackendDiagnostic(
  code: string,
  message: string,
  at: string = new Date().toISOString(),
  details?: Record<string, unknown>,
  stage?: StorageBackendDiagnostic["stage"]
): StorageBackendDiagnostic {
  return { code, message, at, details, stage }
}
