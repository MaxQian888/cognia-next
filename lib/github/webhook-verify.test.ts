import { createHmac } from "node:crypto"
import { computeGithubSignature, verifyGithubSignature } from "./webhook-verify"

const SECRET = "It's a Secret to Everybody"
const BODY = "Hello, World!"
// From the official GitHub docs example.
const EXPECTED_DIGEST = createHmac("sha256", SECRET).update(BODY).digest("hex")

describe("computeGithubSignature", () => {
  it("matches an independent HMAC of the same input", () => {
    expect(computeGithubSignature(BODY, SECRET)).toBe(EXPECTED_DIGEST)
  })

  it("accepts Buffer body identically to string body", () => {
    expect(computeGithubSignature(Buffer.from(BODY), SECRET)).toBe(EXPECTED_DIGEST)
  })
})

describe("verifyGithubSignature", () => {
  it("returns true for a correct signature", () => {
    const header = `sha256=${EXPECTED_DIGEST}`
    expect(verifyGithubSignature(BODY, header, SECRET)).toBe(true)
  })

  it("returns false for a tampered body", () => {
    const header = `sha256=${EXPECTED_DIGEST}`
    expect(verifyGithubSignature(BODY + "tampered", header, SECRET)).toBe(false)
  })

  it("returns false for the wrong secret", () => {
    const header = `sha256=${EXPECTED_DIGEST}`
    expect(verifyGithubSignature(BODY, header, "wrong-secret")).toBe(false)
  })

  it("returns false when header is missing", () => {
    expect(verifyGithubSignature(BODY, null, SECRET)).toBe(false)
    expect(verifyGithubSignature(BODY, undefined, SECRET)).toBe(false)
    expect(verifyGithubSignature(BODY, "", SECRET)).toBe(false)
  })

  it("returns false when secret is empty", () => {
    const header = `sha256=${EXPECTED_DIGEST}`
    expect(verifyGithubSignature(BODY, header, "")).toBe(false)
  })

  it("returns false when header lacks sha256= prefix", () => {
    expect(verifyGithubSignature(BODY, EXPECTED_DIGEST, SECRET)).toBe(false)
    expect(verifyGithubSignature(BODY, `sha1=${EXPECTED_DIGEST}`, SECRET)).toBe(false)
  })

  it("returns false when header length differs from expected (avoids timingSafeEqual throw)", () => {
    expect(verifyGithubSignature(BODY, "sha256=abc", SECRET)).toBe(false)
  })

  it("accepts Buffer body for verification", () => {
    const header = `sha256=${EXPECTED_DIGEST}`
    expect(verifyGithubSignature(Buffer.from(BODY), header, SECRET)).toBe(true)
  })
})
