import { DIAGNOSTIC_CODES, DIAGNOSTIC_CODE_IDS, isDiagnosticCode, specForCode } from "./registry"
import type { DiagnosticAction, DiagnosticCode } from "./types"

/** Actions that make "retryable" true in a way the user can act on. */
const RETRY_KINDS = new Set<DiagnosticAction["kind"]>([
  "retry",
  "wait-and-retry",
  "retry-fallback-provider",
  "retry-when-online",
  "reconnect-adapter",
  "reconnect-external-agent",
  "restart-sidecar",
  "reload-app",
])

describe("DIAGNOSTIC_CODES", () => {
  it("gives every code at least one thing the user can do", () => {
    const dead = DIAGNOSTIC_CODE_IDS.filter((code) => DIAGNOSTIC_CODES[code].actions.length === 0)
    expect(dead).toEqual([])
  })

  it("never claims retryable without offering a retry-shaped action", () => {
    const inconsistent = DIAGNOSTIC_CODE_IDS.filter((code) => {
      const spec = DIAGNOSTIC_CODES[code]
      return spec.retryable && !spec.actions.some((a) => RETRY_KINDS.has(a.kind))
    })
    expect(inconsistent).toEqual([])
  })

  it("keeps `fatal` for the failures that genuinely stop the app", () => {
    const fatal = DIAGNOSTIC_CODE_IDS.filter((code) => DIAGNOSTIC_CODES[code].severity === "fatal")
    // Widening this list means claiming the right to take over the screen —
    // it should be a deliberate edit, not a drift.
    expect(fatal.sort()).toEqual(["dbUnavailable", "dbUpgradeBlocked", "settingsLoadFailed"])
  })

  it("routes every open-settings action at a real settings section id", () => {
    // The section union itself lives in a `.tsx` module, so the compile-time
    // check happens in lib/diagnostics/settings-sections.test.ts. Here we only
    // guard the shape: a section is always present and non-empty.
    const broken = DIAGNOSTIC_CODE_IDS.flatMap((code) =>
      DIAGNOSTIC_CODES[code].actions
        .filter((a) => a.kind === "open-settings")
        .filter((a) => !("section" in a) || !a.section)
        .map(() => code)
    )
    expect(broken).toEqual([])
  })

  it("marks conditions that outlive their trigger as persistent", () => {
    // A steady state rendered as a one-shot toast is the bug this flag prevents.
    expect(DIAGNOSTIC_CODES.settingsLoadFailed.persistent).toBe(true)
    expect(DIAGNOSTIC_CODES.offline.persistent).toBe(true)
    expect(DIAGNOSTIC_CODES.sidecarUnreachable.persistent).toBe(true)
    // …whereas a single failed turn is an event.
    expect(DIAGNOSTIC_CODES.serverError.persistent).toBe(false)
  })

  it("does not offer a retry for failures where replaying cannot help", () => {
    // Replaying a filtered prompt trips the same filter; a smaller model fails
    // a context overflow the same way.
    expect(DIAGNOSTIC_CODES.contentPolicy.retryable).toBe(false)
    expect(DIAGNOSTIC_CODES.contentPolicy.actions.some((a) => a.kind === "retry")).toBe(false)
    expect(DIAGNOSTIC_CODES.contextWindowExceeded.actions.some((a) => a.kind === "retry")).toBe(
      false
    )
    expect(DIAGNOSTIC_CODES.unauthorized.actions.some((a) => a.kind === "retry")).toBe(false)
  })

  it("treats a capability gap as information, not a fault", () => {
    // `transport_blocked` in web mode used to read as an error; it means the
    // feature needs the desktop runtime.
    expect(DIAGNOSTIC_CODES.transportBlocked.severity).toBe("info")
    expect(DIAGNOSTIC_CODES.extensionUnsupported.severity).toBe("info")
    expect(DIAGNOSTIC_CODES.desktopOnlyFeature.severity).toBe("info")
  })

  it("keeps the 23 parser category ids so their translations still resolve", () => {
    const inherited: DiagnosticCode[] = [
      "connectionRefused",
      "connectionReset",
      "dnsFailure",
      "networkUnreachable",
      "brokenPipe",
      "fetchFailed",
      "timeout",
      "sessionTimeout",
      "unauthorized",
      "forbidden",
      "rateLimited",
      "quotaExceeded",
      "modelOverloaded",
      "serverError",
      "serviceUnavailable",
      "sidecarExited",
      "dispatchFailed",
      "providerMisconfigured",
      "modelRequired",
      "pluginToolMissing",
      "invalidRequest",
      "notFound",
      "payloadTooLarge",
    ]
    for (const code of inherited) {
      expect(DIAGNOSTIC_CODES[code]).toBeDefined()
    }
  })
})

describe("specForCode", () => {
  it("returns the registered spec for a known code", () => {
    expect(specForCode("rateLimited")).toBe(DIAGNOSTIC_CODES.rateLimited)
  })

  it("degrades to `unknown` rather than throwing on untrusted input", () => {
    // Codes arrive from Rust and from external agents; a new one upstream must
    // not crash the renderer.
    expect(specForCode("something_new_from_rust")).toBe(DIAGNOSTIC_CODES.unknown)
  })
})

describe("isDiagnosticCode", () => {
  it("accepts registered codes", () => {
    expect(isDiagnosticCode("sidecarExited")).toBe(true)
  })

  it("rejects unregistered strings", () => {
    expect(isDiagnosticCode("sidecar_exited")).toBe(false)
  })

  it("rejects inherited Object prototype keys", () => {
    // `"constructor" in DIAGNOSTIC_CODES` is true; the guard must not be.
    expect(isDiagnosticCode("constructor")).toBe(false)
    expect(isDiagnosticCode("toString")).toBe(false)
  })
})
