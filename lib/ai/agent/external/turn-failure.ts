/**
 * Which diagnostic an external-agent turn failure is, decided from the error's
 * TYPE rather than its prose.
 *
 * The external lane handed every throw to the text classifier, so a Pi process
 * that died before its extension came up (`PiProcessExitedError`), a handshake
 * that timed out (`PiExtensionHandshakeError`) and an agent process id still
 * held by another process (`LeaseConflictError`) all came out as `unknown`
 * with the English sentence as the only explanation. Each of those already
 * carries structure: the adapters stamp a lifecycle `reasonCode`, and a lease
 * conflict names the resource it collided on. This reads that structure.
 */

import type { DiagnosticCode } from "@cognia/diagnostics"
import { diagnosticCodeForReason } from "@/lib/diagnostics/external-agent-reason"
import { isLeaseConflictError, type LeaseConflictResource } from "@/lib/execution/lease-conflict"
import { piPackageErrorKey } from "@/lib/plugin/pi-packages/error-keys"

const LEASE_CONFLICT_CODE: Readonly<Record<LeaseConflictResource, DiagnosticCode>> = {
  "working-copy": "workspaceBusy",
  "agent-process": "agentProcessBusy",
}

/** The typed errors a failure may be wrapped in, outermost first. */
function candidates(error: unknown): unknown[] {
  const seen: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    seen.push(current)
    // Pi's startup reports a cleanup that also failed as an AggregateError whose
    // first member is the failure that actually happened.
    if (current instanceof AggregateError && current.errors.length > 0) {
      seen.push(current.errors[0])
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return seen
}

/**
 * The diagnostic code for `error`, or `null` when nothing typed is known about
 * it and the caller should fall back to `toDiagnostic`'s text classification.
 */
export function classifyExternalTurnFailure(error: unknown): DiagnosticCode | null {
  for (const candidate of candidates(error)) {
    if (isLeaseConflictError(candidate)) return LEASE_CONFLICT_CODE[candidate.resource]
    const reasonCode =
      candidate && typeof candidate === "object"
        ? (candidate as { reasonCode?: unknown }).reasonCode
        : undefined
    if (typeof reasonCode === "string") {
      const code = diagnosticCodeForReason(reasonCode)
      // `unknown` is "a reason this table has never heard of", which is no
      // better than the text classifier's answer — let that one run instead.
      if (code && code !== "unknown") return code
    }
  }
  return null
}

/** What a refused plugin Pi package start needs to be explained in the user's language. */
export interface PiPackageTurnFailure {
  /** `plugins.piPackages.errors.*` key. */
  messageKey: string
  /** ICU values for that message. */
  params: Record<string, string>
}

/**
 * The localized-message inputs for a `pi_package_unavailable` failure, read
 * from the typed `PiPackageUnavailableError` (`code`, `params`) wherever it
 * sits in the cause chain; `null` when the failure is not one.
 */
export function piPackageTurnFailure(error: unknown): PiPackageTurnFailure | null {
  for (const candidate of candidates(error)) {
    if (!candidate || typeof candidate !== "object") continue
    const typed = candidate as { reasonCode?: unknown; code?: unknown; params?: unknown }
    if (typed.reasonCode !== "pi_package_unavailable") continue
    const params: Record<string, string> = {}
    if (typed.params && typeof typed.params === "object") {
      for (const [key, value] of Object.entries(typed.params as Record<string, unknown>)) {
        if (typeof value === "string") params[key] = value
      }
    }
    return {
      messageKey: piPackageErrorKey(
        typeof typed.code === "string" ? typed.code : undefined,
        "resolutionFailed"
      ),
      params,
    }
  }
  return null
}

/**
 * Codes that mean the agent never ran the turn at all — refused at start-up or
 * blocked by a holder — as opposed to a turn that started and then failed.
 */
const NOT_STARTED_CODES: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "initializationFailed",
  "extensionHandshakeFailed",
  "piPackageUnavailable",
  "resourceLimit",
  "agentProcessBusy",
  "workspaceBusy",
  "workspaceUnavailable",
  "externalAgentNotReady",
  "externalAgentNotSelected",
])

/** The plan-step halt cause a failed turn's diagnostic code maps to. */
export function planHaltCauseForCode(code: string): "not_started" | "turn_failed" {
  return NOT_STARTED_CODES.has(code as DiagnosticCode) ? "not_started" : "turn_failed"
}
