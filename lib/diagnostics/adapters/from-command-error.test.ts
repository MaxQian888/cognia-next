import { DIAGNOSTIC_CODES } from "@cognia/diagnostics"
import { parseInvokeError } from "@/lib/tauri/command-error"

import { diagnoseCommandError } from "./from-command-error"

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
