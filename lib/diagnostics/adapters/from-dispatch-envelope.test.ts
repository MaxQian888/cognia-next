import { DIAGNOSTIC_CODES } from "@cognia/diagnostics"
import type { PluginDispatchErrorEnvelope } from "@/types/plugin/plugin-agent-sdk"

import { diagnoseDispatchEnvelope } from "./from-dispatch-envelope"

const ALL_CODES: PluginDispatchErrorEnvelope["code"][] = [
  "rate-limit",
  "timeout",
  "network",
  "server-error",
  "auth",
  "invalid-request",
  "context-window-exceeded",
  "content-policy",
  "unknown",
  "sidecar-exited",
  "aborted",
  "rejection-cycle",
  "rejection-max-depth",
  "rejection-policy",
  "budget-exhausted",
  "deadline-exceeded",
  "interrupted",
]

const envelope = (
  overrides: Partial<PluginDispatchErrorEnvelope> = {}
): PluginDispatchErrorEnvelope => ({
  code: "unknown",
  retryable: false,
  message: "m",
  ...overrides,
})

describe("diagnoseDispatchEnvelope", () => {
  it("maps every envelope code onto a registered diagnostic", () => {
    for (const code of ALL_CODES) {
      const out = diagnoseDispatchEnvelope(envelope({ code }))
      expect([code, DIAGNOSTIC_CODES[out.code] !== undefined]).toEqual([code, true])
    }
  })

  it("reuses the provider table for the nine provider classes", () => {
    // Sharing the table is what stops the dispatch path and the direct provider
    // path from labelling the same 429 differently.
    expect(diagnoseDispatchEnvelope(envelope({ code: "rate-limit" })).code).toBe("rateLimited")
    expect(diagnoseDispatchEnvelope(envelope({ code: "context-window-exceeded" })).code).toBe(
      "contextWindowExceeded"
    )
    expect(diagnoseDispatchEnvelope(envelope({ code: "auth" })).code).toBe("unauthorized")
  })

  it("maps the dispatch-local guard refusals to their own codes", () => {
    expect(diagnoseDispatchEnvelope(envelope({ code: "rejection-cycle" })).code).toBe(
      "dispatchRejectedCycle"
    )
    expect(diagnoseDispatchEnvelope(envelope({ code: "rejection-max-depth" })).code).toBe(
      "dispatchRejectedDepth"
    )
    expect(diagnoseDispatchEnvelope(envelope({ code: "budget-exhausted" })).code).toBe(
      "budgetExhausted"
    )
  })

  it("keeps the dispatch layer's own retry verdict", () => {
    expect(
      diagnoseDispatchEnvelope(envelope({ code: "aborted", retryable: false })).retryable
    ).toBe(false)
    expect(
      diagnoseDispatchEnvelope(envelope({ code: "sidecar-exited", retryable: true })).retryable
    ).toBe(true)
  })

  it("carries the Retry-After and attempt count into meta", () => {
    expect(
      diagnoseDispatchEnvelope(envelope({ code: "rate-limit", retryAfterMs: 30_000, attempts: 3 }))
        .meta
    ).toEqual({ retryAfterMs: 30_000, attempts: 3 })
  })

  it("emits an empty meta when the envelope carried no hints", () => {
    expect(diagnoseDispatchEnvelope(envelope()).meta).toEqual({})
  })

  it("degrades a code in neither table rather than emitting undefined", () => {
    // Unreachable by type, but the envelope crosses a runtime boundary from the
    // dispatch layer — a code added there before here must not produce a
    // diagnostic whose `code` is undefined.
    const out = diagnoseDispatchEnvelope(
      envelope({ code: "future-dispatch-code" as PluginDispatchErrorEnvelope["code"] })
    )
    expect(out.code).toBe("unknown")
  })
})
