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
 * Deliberately partial: unmapped codes fall through to `unknown` rather than
 * forcing a guess for every future backend error.
 */
const COMMAND_CODE_TO_DIAGNOSTIC: Readonly<Record<string, DiagnosticCode>> = {
  // Process lifecycle
  spawn_failed: "initializationFailed",
  lsp_host_spawn_failed: "initializationFailed",
  sidecar_error: "sidecarExited",
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
