/**
 * Rust `CommandError.code` → {@link DiagnosticCode}.
 *
 * Tauri commands reject with `{ code, message, retryable }`
 * (`crates/cognia-core/src/command_error.rs`), decoded on this side by
 * `lib/tauri/command-error.ts`. The code is a free-form Rust string, so the
 * table below covers the ones actually emitted today and everything else
 * degrades to `unknown` — which is the honest outcome: the message and stack
 * still reach the user, they just aren't given a confidently wrong label.
 *
 * `retryable` is taken from the envelope verbatim, never re-derived. Only the
 * command author knows whether the operation is safe to repeat, and a guess
 * here could turn a non-idempotent backend call into a duplicate write.
 */

import type { DiagnosticCode } from "@cognia/diagnostics"
import type { ParsedCommandError } from "@/lib/tauri/command-error"

/**
 * Multi-tenant Host refusals: the problem codes from
 * `crates/cognia-companion/src/host_surface_gate.rs`. The first three are
 * intentional dormancy (Rule 7) and get their own labels, so they never read
 * as a fault or as a permission the member could be granted.
 */
const HOST_REFUSAL_TO_DIAGNOSTIC: Readonly<Record<string, DiagnosticCode>> = {
  host_data_unpartitioned: "hostDataUnavailable",
  execution_isolation_unavailable: "executionUnavailable",
  workspace_unresolved: "workspaceUnresolved",
  host_surface_forbidden: "forbidden",
  host_principal_unbound: "forbidden",
  execution_request_forbidden: "forbidden",
  credential_use_forbidden: "forbidden",
  workspace_mount_forbidden: "forbidden",
  placement_binding_client_supplied: "forbidden",
  placement_client_supplied: "placementClientSupplied",
  host_authority_unavailable: "serviceUnavailable",
  // A member's own data partition (plan §9a). Model access is dormant there;
  // the other two are transient, and the Host marks them retryable.
  model_access_unavailable: "modelAccessUnavailable",
  // HostState `session.workspace` in a partition (P5d): it has no workspaces.
  workspace_unavailable: "partitionWorkspaceUnavailable",
  org_scope_unavailable: "orgScopeUnavailable",
  member_usage_cap_reached: "memberUsageCapReached",
  org_agent_not_allowed: "orgAgentNotAllowed",
  person_workspace_quota_exceeded: "personWorkspaceQuotaExceeded",
  person_workspace_unavailable: "personWorkspaceUnavailable",
  credential_delivery_refused: "credentialDeliveryRefused",
  person_brain_capacity: "resourceLimit",
  person_brain_unavailable: "serviceUnavailable",
}

/**
 * Deliberately partial: unmapped codes fall through to `unknown` rather than
 * forcing a guess for every future backend error.
 */
const COMMAND_CODE_TO_DIAGNOSTIC: Readonly<Record<string, DiagnosticCode>> = {
  // Process lifecycle
  spawn_failed: "initializationFailed",
  lsp_host_spawn_failed: "initializationFailed",
  sidecar_error: "sidecarExited",
  // A member's sandboxed agent turn (P6e, `lib/headless/person-agent/`).
  person_agent_exited: "personAgentExited",
  person_agent_attachment_unsupported: "personAgentAttachmentUnsupported",
  host_script_missing: "prerequisiteMissing",
  lsp_host_script_missing: "prerequisiteMissing",

  // Transport
  timeout: "timeout",
  send_failed: "fetchFailed",
  bad_response: "serverError",
  decode_error: "serverError",
  event_sink_missing: "eventChannelLost",

  // Configuration
  invalid_config: "providerMisconfigured",
  bad_manifest: "providerMisconfigured",

  // Lookup
  task_not_found: "notFound",
  // "extension not loaded" — the VS Code host has no such extension running.
  not_loaded: "pluginToolMissing",

  ...HOST_REFUSAL_TO_DIAGNOSTIC,
}

/**
 * Host refusal codes travel on several carriers (a `CompanionError`, a raw
 * problem document, a command envelope). This lets the dispatcher route any
 * of them here instead of to a table that does not know them.
 */
export function isHostRefusalCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(HOST_REFUSAL_TO_DIAGNOSTIC, code)
}

export interface CommandErrorDiagnosis {
  code: DiagnosticCode
  message: string
  /** Straight from the envelope — the Rust side is authoritative. */
  retryable: boolean
}

export function diagnoseCommandError(parsed: ParsedCommandError): CommandErrorDiagnosis {
  const mapped = Object.prototype.hasOwnProperty.call(COMMAND_CODE_TO_DIAGNOSTIC, parsed.code)
    ? COMMAND_CODE_TO_DIAGNOSTIC[parsed.code]
    : "unknown"
  return { code: mapped, message: parsed.message, retryable: parsed.retryable }
}
