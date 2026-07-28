import { redactE2EDiagnosticText, redactE2EDiagnosticUrl } from "./e2e-diagnostics"

describe("E2E diagnostic redaction", () => {
  it("redacts credentials, bearer tokens, JWTs, and email addresses", () => {
    const result = redactE2EDiagnosticText(
      [
        "Authorization: Bearer super-secret",
        "password=hunter2",
        "api_key='vendor-key'",
        "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        "owner@example.com",
      ].join(" ")
    )

    expect(result).not.toContain("super-secret")
    expect(result).not.toContain("hunter2")
    expect(result).not.toContain("vendor-key")
    expect(result).not.toContain("eyJhbGci")
    expect(result).not.toContain("owner@example.com")
    expect(result).toContain("[REDACTED_EMAIL]")
  })

  it("redacts sensitive query parameters and embedded URL credentials", () => {
    const result = redactE2EDiagnosticUrl(
      "https://user:pass@example.com/callback?code=oauth-code&view=summary&token=secret"
    )

    expect(result).toContain("view=summary")
    expect(result).not.toContain("user")
    expect(result).not.toContain("pass")
    expect(result).not.toContain("oauth-code")
    expect(result).not.toContain("secret")
    expect(result).toContain("%5BREDACTED%5D")
  })

  it("falls back to text redaction for malformed URLs", () => {
    expect(redactE2EDiagnosticUrl("request failed for admin@example.com token=abc")).toBe(
      "request failed for [REDACTED_EMAIL] token=[REDACTED]"
    )
  })
})
