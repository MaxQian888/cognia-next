import { DIAGNOSTIC_CODES } from "@cognia/diagnostics"
import { parseInvokeError } from "@/lib/tauri/command-error"

import { diagnoseCommandError, isHostRefusalCode } from "./from-command-error"

describe("diagnoseCommandError", () => {
  it("maps the codes the Rust side actually emits", () => {
    const cases: Array<[string, string]> = [
      ["spawn_failed", "initializationFailed"],
      ["lsp_host_spawn_failed", "initializationFailed"],
      ["sidecar_error", "sidecarExited"],
      ["host_script_missing", "prerequisiteMissing"],
      ["lsp_host_script_missing", "prerequisiteMissing"],
      ["timeout", "timeout"],
      ["send_failed", "fetchFailed"],
      ["bad_response", "serverError"],
      ["decode_error", "serverError"],
      ["event_sink_missing", "eventChannelLost"],
      ["invalid_config", "providerMisconfigured"],
      ["bad_manifest", "providerMisconfigured"],
      ["task_not_found", "notFound"],
      ["not_loaded", "pluginToolMissing"],
    ]
    for (const [rustCode, expected] of cases) {
      const out = diagnoseCommandError({
        code: rustCode,
        message: "m",
        retryable: false,
        structured: true,
      })
      expect([rustCode, out.code]).toEqual([rustCode, expected])
      expect(DIAGNOSTIC_CODES[out.code]).toBeDefined()
    }
  })

  it("honours the envelope's retryable verbatim rather than re-deriving it", () => {
    // Only the command author knows whether the operation is idempotent; a
    // guess here could turn a non-repeatable backend call into a double write.
    expect(
      diagnoseCommandError({ code: "timeout", message: "m", retryable: false, structured: true })
        .retryable
    ).toBe(false)
    expect(
      diagnoseCommandError({ code: "internal", message: "m", retryable: true, structured: true })
        .retryable
    ).toBe(true)
  })

  it("degrades an unmapped backend code to `unknown` while keeping its message", () => {
    const out = diagnoseCommandError({
      code: "some_future_rust_code",
      message: "disk gone",
      retryable: false,
      structured: true,
    })
    expect(out.code).toBe("unknown")
    expect(out.message).toBe("disk gone")
  })

  it("does not mistake inherited Object keys for backend codes", () => {
    expect(
      diagnoseCommandError({
        code: "constructor",
        message: "m",
        retryable: false,
        structured: true,
      }).code
    ).toBe("unknown")
  })

  it("composes with the real invoke-error decoder", () => {
    const parsed = parseInvokeError({ code: "sidecar_error", message: "died", retryable: true })
    expect(diagnoseCommandError(parsed)).toEqual({
      code: "sidecarExited",
      message: "died",
      retryable: true,
    })
  })

  it("degrades a legacy plain-string rejection", () => {
    // Pre-envelope commands reject with a bare string; `parseInvokeError` gives
    // them `code: "unknown"` and never invents retryability.
    const parsed = parseInvokeError("boom")
    expect(diagnoseCommandError(parsed)).toEqual({
      code: "unknown",
      message: "boom",
      retryable: false,
    })
  })
})

describe("multi-tenant Host refusals", () => {
  const diagnose = (code: string) =>
    diagnoseCommandError({ code, message: code, retryable: false, structured: true }).code

  it("labels the three intentionally inert surfaces as themselves, never as a fault", () => {
    expect(diagnose("host_data_unpartitioned")).toBe("hostDataUnavailable")
    expect(diagnose("execution_isolation_unavailable")).toBe("executionUnavailable")
    expect(diagnose("workspace_unresolved")).toBe("workspaceUnresolved")
    for (const code of [
      "hostDataUnavailable",
      "executionUnavailable",
      "workspaceUnresolved",
    ] as const) {
      // Rule 7: inert by design, so nothing to retry and nothing to configure.
      expect(DIAGNOSTIC_CODES[code].retryable).toBe(false)
      expect(DIAGNOSTIC_CODES[code].actions).toEqual([{ kind: "dismiss" }])
    }
  })

  it("maps standing and binding refusals to forbidden and a dead authority to unavailable", () => {
    for (const code of [
      "host_surface_forbidden",
      "host_principal_unbound",
      "execution_request_forbidden",
      "credential_use_forbidden",
      "workspace_mount_forbidden",
      "placement_binding_client_supplied",
    ]) {
      expect(diagnose(code)).toBe("forbidden")
    }
    expect(diagnose("host_authority_unavailable")).toBe("serviceUnavailable")
  })

  it("labels a member partition's dormant model access and its transient refusals", () => {
    expect(diagnose("model_access_unavailable")).toBe("modelAccessUnavailable")
    expect(DIAGNOSTIC_CODES.modelAccessUnavailable.retryable).toBe(false)
    expect(DIAGNOSTIC_CODES.modelAccessUnavailable.actions).toEqual([{ kind: "dismiss" }])
    // Capacity is a concurrency ceiling, not a fault; both clear on retry.
    expect(diagnose("person_brain_capacity")).toBe("resourceLimit")
    expect(diagnose("person_brain_unavailable")).toBe("serviceUnavailable")
    expect(isHostRefusalCode("person_brain_capacity")).toBe(true)
    // P5d: a partition has no workspaces to move a conversation into.
    expect(diagnose("workspace_unavailable")).toBe("partitionWorkspaceUnavailable")
    expect(DIAGNOSTIC_CODES.partitionWorkspaceUnavailable.retryable).toBe(false)
  })

  it("maps P6d execution refusals to actionable stable diagnostics", () => {
    for (const [code, diagnostic] of [
      ["org_agent_not_allowed", "orgAgentNotAllowed"],
      ["person_workspace_quota_exceeded", "personWorkspaceQuotaExceeded"],
      ["person_workspace_unavailable", "personWorkspaceUnavailable"],
      ["credential_delivery_refused", "credentialDeliveryRefused"],
    ] as const) {
      expect(diagnose(code)).toBe(diagnostic)
      expect(isHostRefusalCode(code)).toBe(true)
      expect(DIAGNOSTIC_CODES[diagnostic].retryable).toBe(false)
    }
  })

  it("maps monthly member allowance exhaustion to its non-retryable diagnostic", () => {
    expect(
      diagnoseCommandError({
        code: "member_usage_cap_reached",
        message: "member monthly token cap reached",
        retryable: false,
        structured: true,
      })
    ).toEqual({
      code: "memberUsageCapReached",
      message: "member monthly token cap reached",
      retryable: false,
    })
    expect(isHostRefusalCode("member_usage_cap_reached")).toBe(true)
    expect(DIAGNOSTIC_CODES.memberUsageCapReached.retryable).toBe(false)
  })

  it("labels org administration as unavailable on a single-user Host", () => {
    expect(diagnose("org_scope_unavailable")).toBe("orgScopeUnavailable")
    expect(isHostRefusalCode("org_scope_unavailable")).toBe(true)
    expect(DIAGNOSTIC_CODES.orgScopeUnavailable.retryable).toBe(false)
    expect(DIAGNOSTIC_CODES.orgScopeUnavailable.actions).toEqual([{ kind: "dismiss" }])
  })

  it("recognises only Host refusal codes", () => {
    expect(isHostRefusalCode("host_data_unpartitioned")).toBe(true)
    expect(isHostRefusalCode("sidecar_error")).toBe(false)
    expect(isHostRefusalCode("constructor")).toBe(false)
  })
})
