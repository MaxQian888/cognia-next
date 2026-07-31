/**
 * `lib/error/classify-error` → {@link DiagnosticCode}.
 *
 * The route-boundary classifier stays exactly as it is — `components/error/
 * error-page.tsx` depends on its `RecoveryKind` and the auto-retry-on-reconnect
 * behaviour keyed off `isConnectivityCategory`. This adapter only renames its
 * five categories so a boundary crash can be described in the same terms as a
 * failed agent turn.
 *
 * `RecoveryKind` maps onto the action vocabulary rather than being re-derived:
 * a stale chunk genuinely needs a full reload (a boundary reset just re-imports
 * the missing chunk and throws again), which is a distinction the registry
 * would otherwise have to duplicate.
 */

import type { DiagnosticAction, DiagnosticCode } from "@cognia/diagnostics"
import type { ErrorCategory, RecoveryKind } from "@/lib/error/classify-error"

export const BOUNDARY_CATEGORY_TO_CODE: Readonly<Record<ErrorCategory, DiagnosticCode>> = {
  "chunk-load": "chunkLoad",
  network: "fetchFailed",
  offline: "offline",
  render: "renderCrash",
  unknown: "unknown",
}

const RECOVERY_TO_ACTION: Readonly<Record<RecoveryKind, DiagnosticAction>> = {
  reload: { kind: "reload-app" },
  "retry-online": { kind: "retry-when-online" },
  reset: { kind: "reset-boundary" },
}

export interface BoundaryDiagnosis {
  code: DiagnosticCode
  /** The recovery the classifier chose, as an action the card can render. */
  actions: readonly DiagnosticAction[]
}

/** Structural subset of `ErrorClassification`. */
export interface ErrorClassificationLike {
  category: ErrorCategory
  recoveryKind: RecoveryKind
}

export function diagnoseBoundaryError(classification: ErrorClassificationLike): BoundaryDiagnosis {
  return {
    code: BOUNDARY_CATEGORY_TO_CODE[classification.category],
    actions: [RECOVERY_TO_ACTION[classification.recoveryKind]],
  }
}
