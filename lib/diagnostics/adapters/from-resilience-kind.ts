/**
 * `ResilienceErrorKind` → {@link DiagnosticCode}.
 *
 * The plugin retry loop only needs four outcomes, so its classifier is
 * deliberately coarse — "fatal" and "retryable" both cover a wide range of real
 * causes it cannot distinguish. That coarseness is preserved here rather than
 * papered over: both land on `unknown`, differing only in retryability, so the
 * user is told honestly that Cognia doesn't know what went wrong instead of
 * being shown a confidently wrong label.
 *
 * The retry loop's own behaviour is untouched; `isRetryableKind` still governs
 * whether an attempt happens.
 */

import type { DiagnosticCode } from "@cognia/diagnostics"
import type { ResilienceErrorKind } from "@/lib/plugin/resilience/error-classify"

export interface ResilienceDiagnosis {
  code: DiagnosticCode
  /** Overrides the registry default — the loop's verdict is authoritative. */
  retryable: boolean
}

const RESILIENCE_TO_DIAGNOSIS: Readonly<Record<ResilienceErrorKind, ResilienceDiagnosis>> = {
  timeout: { code: "timeout", retryable: true },
  // Caller-initiated: never the plugin's fault, and never rendered as a failure.
  aborted: { code: "aborted", retryable: false },
  fatal: { code: "unknown", retryable: false },
  retryable: { code: "unknown", retryable: true },
}

export function diagnoseResilienceKind(kind: ResilienceErrorKind): ResilienceDiagnosis {
  return RESILIENCE_TO_DIAGNOSIS[kind]
}
