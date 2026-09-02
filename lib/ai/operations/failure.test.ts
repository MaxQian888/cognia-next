import {
  ProviderOperationFailureError,
  ProviderOperationPiiGateError,
  availabilityForFailure,
  toProviderDiagnosticFailure,
} from "./failure"

describe("toProviderDiagnosticFailure", () => {
  it("maps HTTP statuses through the diagnostics table and keeps retry-after", () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "3" },
    })
    expect(toProviderDiagnosticFailure(err)).toMatchObject({
      code: "rate-limited",
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 3_000,
    })
    expect(toProviderDiagnosticFailure({ status: 401 }).code).toBe("authentication")
    expect(toProviderDiagnosticFailure({ status: 402 }).code).toBe("quota")
    expect(toProviderDiagnosticFailure({ response: { status: 503 } })).toMatchObject({
      code: "transport",
      retryable: true,
    })
  })

  it("classifies message-only errors through the API status parser", () => {
    expect(toProviderDiagnosticFailure(new Error("You exceeded your current quota")).code).toBe(
      "quota"
    )
    expect(toProviderDiagnosticFailure(new Error("invalid api key")).code).toBe("authentication")
    expect(toProviderDiagnosticFailure(new Error("model_overloaded"))).toMatchObject({
      code: "transport",
      retryable: true,
    })
  })

  it("keeps typed failures, PII blocks and transport errors distinct", () => {
    const typed = new ProviderOperationFailureError({
      code: "budget-exhausted",
      retryable: false,
      message: "spent",
    })
    expect(toProviderDiagnosticFailure(typed).code).toBe("budget-exhausted")
    expect(toProviderDiagnosticFailure(new ProviderOperationPiiGateError())).toMatchObject({
      code: "permission",
      retryable: false,
    })
    expect(toProviderDiagnosticFailure(new Error("fetch failed: ECONNREFUSED"))).toMatchObject({
      code: "network",
      retryable: true,
    })
    expect(toProviderDiagnosticFailure("???")).toMatchObject({ code: "unknown" })
  })

  it("redacts secrets from messages", () => {
    const failure = toProviderDiagnosticFailure(
      new Error("Bearer sk-abcdef1234567890 was rejected")
    )
    expect(failure.message).not.toContain("1234567890")
  })

  it("maps failures to availability", () => {
    expect(availabilityForFailure({ code: "authentication", retryable: false, message: "" })).toBe(
      "needs-auth"
    )
    expect(availabilityForFailure({ code: "rate-limited", retryable: true, message: "" })).toBe(
      "ready"
    )
    expect(availabilityForFailure({ code: "schema", retryable: false, message: "" })).toBe(
      "unavailable"
    )
  })
})
