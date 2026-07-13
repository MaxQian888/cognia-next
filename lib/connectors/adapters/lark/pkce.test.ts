import { CODE_CHALLENGE_METHOD, computeCodeChallenge, generateCodeVerifier } from "./pkce"

describe("generateCodeVerifier", () => {
  it("returns a 43-char string from the unreserved set", () => {
    const verifier = generateCodeVerifier()
    expect(verifier).toHaveLength(43)
    // RFC 7636 unreserved chars: A-Z a-z 0-9 - . _ ~. base64url yields a subset.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it("produces a different verifier on each call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier())
  })
})

describe("computeCodeChallenge", () => {
  it("matches the RFC 7636 Appendix B test vector", async () => {
    // Canonical example from RFC 7636 §Appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    const challenge = await computeCodeChallenge(verifier)
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("is deterministic and base64url (no padding)", async () => {
    const verifier = generateCodeVerifier()
    const a = await computeCodeChallenge(verifier)
    const b = await computeCodeChallenge(verifier)
    expect(a).toBe(b)
    expect(a).not.toContain("=")
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/)
  })
})

describe("CODE_CHALLENGE_METHOD", () => {
  it("is S256", () => {
    expect(CODE_CHALLENGE_METHOD).toBe("S256")
  })
})
