import { DIAGNOSTIC_CODES } from "@cognia/diagnostics"
import { REASON_CODE_TO_DIAGNOSTIC, diagnosticCodeForReason } from "./external-agent-reason"
import type { ExternalAgentBranchReasonCode } from "@/types/agent/external-agent"

/**
 * Mirrors the union in `types/agent/external-agent.ts`. Written out rather than
 * derived so that adding a reason code upstream fails HERE too — the compiler
 * catches the missing table row, this catches a row added but never mapped to a
 * meaningful code.
 */
const ALL_REASON_CODES: ExternalAgentBranchReasonCode[] = [
  "ok",
  "agent_not_found",
  "configuration_missing",
  "agent_disabled",
  "protocol_unsupported",
  "transport_blocked",
  "ecosystem_prerequisite_missing",
  "ecosystem_documented_only",
  "initialization_failed",
  "health_check_failed",
  "external_unavailable",
  "extension_unknown",
  "extension_unsupported",
  "session_resolution_failed",
  "permission_denied",
  "execution_failed",
  "strict_failure",
  "fallback_to_builtin",
  "runtime_version_unsupported",
  "sandbox_unavailable",
  "extension_handshake_failed",
  "protocol_frame_invalid",
  "resource_limit",
]

describe("REASON_CODE_TO_DIAGNOSTIC", () => {
  it("maps every reason code the runtime can emit", () => {
    expect(Object.keys(REASON_CODE_TO_DIAGNOSTIC).sort()).toEqual([...ALL_REASON_CODES].sort())
  })

  it("only maps onto codes the registry actually knows", () => {
    const unknown = Object.entries(REASON_CODE_TO_DIAGNOSTIC)
      .filter(([, code]) => code !== null && !(code in DIAGNOSTIC_CODES))
      .map(([reason]) => reason)
    expect(unknown).toEqual([])
  })

  it("treats the success path and an unprobed capability as non-diagnostics", () => {
    expect(REASON_CODE_TO_DIAGNOSTIC.ok).toBeNull()
  })

  it("gives each failing reason its own code — no lossy collapsing", () => {
    const codes = ALL_REASON_CODES.map((r) => REASON_CODE_TO_DIAGNOSTIC[r]).filter(
      (c): c is NonNullable<typeof c> => c !== null
    )
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe("diagnosticCodeForReason", () => {
  it("resolves a known reason code", () => {
    expect(diagnosticCodeForReason("ecosystem_prerequisite_missing")).toBe("prerequisiteMissing")
  })

  it("returns null for the success path so nothing is rendered", () => {
    expect(diagnosticCodeForReason("ok")).toBeNull()
  })

  it("returns null for absent input", () => {
    expect(diagnosticCodeForReason(undefined)).toBeNull()
    expect(diagnosticCodeForReason(null)).toBeNull()
    expect(diagnosticCodeForReason("")).toBeNull()
  })

  it("degrades to `unknown` for a reason code from a newer agent host", () => {
    // Reason codes cross a process boundary; an upstream addition must not
    // crash a settings pane.
    expect(diagnosticCodeForReason("some_future_reason")).toBe("unknown")
  })

  it("does not mistake inherited Object keys for reason codes", () => {
    expect(diagnosticCodeForReason("constructor")).toBe("unknown")
    expect(diagnosticCodeForReason("toString")).toBe("unknown")
  })
})
