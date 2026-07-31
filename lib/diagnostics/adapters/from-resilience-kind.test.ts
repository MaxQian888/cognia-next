import { DIAGNOSTIC_CODES } from "@cognia/diagnostics"
import { isRetryableKind, type ResilienceErrorKind } from "@/lib/plugin/resilience/error-classify"

import { diagnoseResilienceKind } from "./from-resilience-kind"

const ALL_KINDS: ResilienceErrorKind[] = ["retryable", "fatal", "timeout", "aborted"]

describe("diagnoseResilienceKind", () => {
  it("maps every kind onto a known code", () => {
    for (const kind of ALL_KINDS) {
      expect(DIAGNOSTIC_CODES[diagnoseResilienceKind(kind).code]).toBeDefined()
    }
  })

  it("agrees with the retry loop about what gets re-attempted", () => {
    // If these disagreed, the card would offer a retry the loop refuses to make
    // (or hide one it would).
    for (const kind of ALL_KINDS) {
      expect(diagnoseResilienceKind(kind).retryable).toBe(isRetryableKind(kind))
    }
  })

  it("keeps a caller-initiated abort out of the failure vocabulary", () => {
    expect(diagnoseResilienceKind("aborted").code).toBe("aborted")
    expect(DIAGNOSTIC_CODES.aborted.severity).toBe("info")
  })

  it("says `unknown` rather than guessing for the classifier's two coarse buckets", () => {
    // "fatal" and "retryable" each cover many real causes the loop cannot tell
    // apart; a confident label here would be fabricated.
    expect(diagnoseResilienceKind("fatal").code).toBe("unknown")
    expect(diagnoseResilienceKind("retryable").code).toBe("unknown")
    expect(diagnoseResilienceKind("fatal").retryable).toBe(false)
    expect(diagnoseResilienceKind("retryable").retryable).toBe(true)
  })
})
