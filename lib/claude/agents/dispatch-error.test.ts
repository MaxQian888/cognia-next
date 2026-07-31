import {
  toDispatchErrorEnvelope,
  envelopeForRejection,
  envelopeForBudgetExhausted,
  renderDispatchOutcomeForModel,
} from "./dispatch-error"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

/** Mirrors RunAndCaptureError's shape without importing run-and-capture. */
class FakeRunAndCaptureError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = "RunAndCaptureError"
  }
}

describe("toDispatchErrorEnvelope", () => {
  it.each([
    ["429 rate limit exceeded", "rate-limit", true],
    ["Provider overloaded_error: Overloaded", "server-error", true],
    ["fetch failed: ECONNRESET", "network", true],
    ["internal server error (500)", "server-error", true],
    ["request timed out after 60s", "timeout", true],
    ["401 unauthorized: invalid api key", "auth", false],
    ["400 invalid_request_error: bad param", "invalid-request", false],
  ])("classifies %s as %s (retryable=%s)", (message, code, retryable) => {
    const env = toDispatchErrorEnvelope(new Error(message))
    expect(env.code).toBe(code)
    expect(env.retryable).toBe(retryable)
    expect(env.message).toBe(message)
  })

  it("maps unclassifiable messages to unknown/non-retryable", () => {
    const env = toDispatchErrorEnvelope(new Error("something exploded"))
    expect(env).toMatchObject({ code: "unknown", retryable: false })
  })

  it("maps RunAndCaptureError sidecar_exited to a retryable sidecar-exited", () => {
    const env = toDispatchErrorEnvelope(
      new FakeRunAndCaptureError("sidecar exited mid-run", "sidecar_exited")
    )
    expect(env).toMatchObject({ code: "sidecar-exited", retryable: true })
  })

  it("maps RunAndCaptureError aborted to aborted", () => {
    const env = toDispatchErrorEnvelope(new FakeRunAndCaptureError("run aborted", "aborted"))
    expect(env).toMatchObject({ code: "aborted", retryable: false })
  })

  it("opts.aborted wins over message classification", () => {
    const env = toDispatchErrorEnvelope(new Error("429 rate limit"), { aborted: true })
    expect(env).toMatchObject({ code: "aborted", retryable: false })
  })

  it("threads partialText through", () => {
    const env = toDispatchErrorEnvelope(new Error("overloaded"), { partialText: "so far…" })
    expect(env.partialText).toBe("so far…")
  })

  it("omits partialText when empty", () => {
    const env = toDispatchErrorEnvelope(new Error("overloaded"), { partialText: "" })
    expect(env).not.toHaveProperty("partialText")
  })

  it("extracts a Retry-After hint for rate-limit errors", () => {
    const env = toDispatchErrorEnvelope(new Error("429 rate limit; retry after 12 seconds"))
    expect(env.code).toBe("rate-limit")
    expect(env.retryAfterMs).toBe(12_000)
  })

  it("stringifies non-Error throwables", () => {
    const env = toDispatchErrorEnvelope("plain failure")
    expect(env.message).toBe("plain failure")
    expect(env.code).toBe("unknown")
  })
})

describe("rejection / guard envelopes", () => {
  it("maps cycle rejections", () => {
    expect(envelopeForRejection({ reason: "cycle", message: "A→B→A" })).toMatchObject({
      code: "rejection-cycle",
      retryable: false,
      message: "A→B→A",
    })
  })

  it("maps max-depth rejections", () => {
    expect(
      envelopeForRejection({ reason: "max-depth", message: "too deep", attemptedDepth: 3 })
    ).toMatchObject({ code: "rejection-max-depth", retryable: false })
  })

  it("maps policy rejections", () => {
    expect(envelopeForRejection({ reason: "policy", message: "denied by rules" })).toMatchObject({
      code: "rejection-policy",
      retryable: false,
    })
  })

  it("budget helper is non-retryable", () => {
    expect(envelopeForBudgetExhausted("budget gone")).toMatchObject({
      code: "budget-exhausted",
      retryable: false,
    })
  })
})

describe("renderDispatchOutcomeForModel", () => {
  const base: PluginSubagentDispatchResult = {
    text: "final answer",
    channel: "sidecar",
    toolsAvailable: true,
  }

  it("renders success with the label prefix (unchanged formatting)", () => {
    expect(renderDispatchOutcomeForModel("explore", base)).toBe("[explore]\nfinal answer")
  })

  it("renders rejections inline (unchanged formatting)", () => {
    const r = {
      ...base,
      text: "cycle refused",
      rejection: { reason: "cycle" as const, message: "x" },
    }
    expect(renderDispatchOutcomeForModel("explore", r)).toBe("[explore] cycle refused")
  })

  it("renders cancellation as a terse cancelled note", () => {
    const r = { ...base, finishReason: "cancelled" }
    expect(renderDispatchOutcomeForModel("explore", r)).toBe("[explore] cancelled.")
  })

  it("returns partial output plus a cut-off note when the run streamed text", () => {
    const r: PluginSubagentDispatchResult = {
      ...base,
      finishReason: "error",
      errorEnvelope: {
        code: "rate-limit",
        retryable: true,
        message: "429 too many requests",
        partialText: "half the findings",
      },
    }
    const out = renderDispatchOutcomeForModel("explore", r)
    expect(out).toContain("half the findings")
    expect(out).toContain("cut off by an error and did not finish: 429 too many requests")
  })

  it("renders a hard terminated-early error when no text was produced", () => {
    const r: PluginSubagentDispatchResult = {
      ...base,
      finishReason: "error",
      errorEnvelope: { code: "auth", retryable: false, message: "401 bad key" },
    }
    expect(renderDispatchOutcomeForModel("explore", r)).toBe(
      "[explore] Subagent terminated early due to 401 bad key"
    )
  })

  it("falls back to plain formatting for envelope-less errors", () => {
    const r = { ...base, text: "legacy error text", finishReason: "error" }
    expect(renderDispatchOutcomeForModel("explore", r)).toBe("[explore]\nlegacy error text")
  })
})
