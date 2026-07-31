/**
 * `ExternalAgentBranchReasonCode` → {@link DiagnosticCode}.
 *
 * The external-agent runtime has produced a perfectly good 18-member reason
 * vocabulary since ADR-0049, and the diagnostics panel rendered it *raw*: users
 * were shown the literal string `ecosystem_prerequisite_missing` in a badge.
 * The codes were never wrong, they were just never translated.
 *
 * This table is the bridge. It is a total `Record`, so adding a reason code
 * upstream is a compile error here rather than a silent fall-through to
 * "unknown" — which is exactly how the raw-code leak survived so long.
 *
 * `null` means "not a diagnostic": `ok` is the success path, and
 * `extension_unknown` means a capability has not been probed yet, which is a
 * state, not a failure.
 */

import type { DiagnosticCode } from "@cognia/diagnostics"
import type { ExternalAgentBranchReasonCode } from "@/types/agent/external-agent"

export const REASON_CODE_TO_DIAGNOSTIC: Readonly<
  Record<ExternalAgentBranchReasonCode, DiagnosticCode | null>
> = {
  ok: null,
  agent_not_found: "agentNotFound",
  configuration_missing: "agentConfigurationMissing",
  agent_disabled: "agentDisabled",
  protocol_unsupported: "protocolUnsupported",
  transport_blocked: "transportBlocked",
  ecosystem_prerequisite_missing: "prerequisiteMissing",
  ecosystem_documented_only: "documentedOnly",
  initialization_failed: "initializationFailed",
  health_check_failed: "healthCheckFailed",
  external_unavailable: "agentUnavailable",
  extension_unknown: "extensionUnknown",
  extension_unsupported: "extensionUnsupported",
  session_resolution_failed: "sessionResolutionFailed",
  permission_denied: "permissionDenied",
  execution_failed: "executionFailed",
  strict_failure: "strictFailure",
  fallback_to_builtin: "fallbackToBuiltin",
}

/**
 * Resolve a reason code to its diagnostic code.
 *
 * Tolerates unknown input — reason codes cross a process boundary from the
 * agent host, so a newer runtime must degrade to `unknown` rather than crash a
 * settings pane.
 */
export function diagnosticCodeForReason(
  reasonCode: string | undefined | null
): DiagnosticCode | null {
  if (!reasonCode) return null
  if (Object.prototype.hasOwnProperty.call(REASON_CODE_TO_DIAGNOSTIC, reasonCode)) {
    return REASON_CODE_TO_DIAGNOSTIC[reasonCode as ExternalAgentBranchReasonCode]
  }
  return "unknown"
}
