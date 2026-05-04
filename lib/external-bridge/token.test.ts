/**
 * Coverage for the bearer token utilities. The constant-time path is
 * exercised against fixed-length inputs since the timing property itself
 * isn't observable in jsdom.
 */

import {
  __TESTING__,
  constantTimeEquals,
  generateToken,
  hasToken,
  parseBearerHeader,
  verifyToken,
} from "./token"

describe("generateToken", () => {
  it("returns 64-char hex (32 random bytes)", async () => {
    const tok = await generateToken()
    expect(tok).toHaveLength(64)
    expect(tok).toMatch(/^[0-9a-f]+$/)
  })

  it("produces different tokens on repeat calls", async () => {
    const a = await generateToken()
    const b = await generateToken()
    expect(a).not.toBe(b)
  })

  it("exposes TOKEN_BYTES = 32", () => {
    expect(__TESTING__.TOKEN_BYTES).toBe(32)
  })

  it("randomBytes test helper produces requested byte count", async () => {
    const bytes = await __TESTING__.randomBytes(8)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(8)
  })

  it("toHex test helper round-trips bytes", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0xa5])
    expect(__TESTING__.toHex(bytes)).toBe("00ff10a5")
  })
})

describe("constantTimeEquals", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEquals("hello", "hello")).toBe(true)
  })

  it("returns false for different-length strings", () => {
    expect(constantTimeEquals("a", "ab")).toBe(false)
  })

  it("returns false for same-length but different strings", () => {
    expect(constantTimeEquals("aaaa", "aaab")).toBe(false)
  })

  it("returns true for two empty strings", () => {
    expect(constantTimeEquals("", "")).toBe(true)
  })
})

describe("verifyToken", () => {
  it("returns false when stored is missing", () => {
    expect(verifyToken(undefined, "abc")).toBe(false)
  })

  it("returns false when candidate is missing", () => {
    expect(verifyToken("abc", undefined)).toBe(false)
  })

  it("returns false when both are missing", () => {
    expect(verifyToken(undefined, undefined)).toBe(false)
  })

  it("returns true on a match", () => {
    expect(verifyToken("abc", "abc")).toBe(true)
  })

  it("returns false on a mismatch", () => {
    expect(verifyToken("abc", "abd")).toBe(false)
  })
})

describe("hasToken", () => {
  it("returns false when undefined or empty", () => {
    expect(hasToken(undefined)).toBe(false)
    expect(hasToken("")).toBe(false)
  })

  it("returns true for a non-empty token", () => {
    expect(hasToken("x")).toBe(true)
  })
})

describe("parseBearerHeader", () => {
  it("extracts the token from a well-formed header", () => {
    expect(parseBearerHeader("Bearer abc123")).toBe("abc123")
  })

  it("trims trailing whitespace", () => {
    expect(parseBearerHeader("Bearer abc123   ")).toBe("abc123")
  })

  it("returns undefined for missing header", () => {
    expect(parseBearerHeader(undefined)).toBeUndefined()
    expect(parseBearerHeader(null)).toBeUndefined()
    expect(parseBearerHeader("")).toBeUndefined()
  })

  it("returns undefined for non-Bearer schemes", () => {
    expect(parseBearerHeader("Basic abc")).toBeUndefined()
    expect(parseBearerHeader("abc123")).toBeUndefined()
  })

  it("accepts hex + URL-safe characters in the token", () => {
    expect(parseBearerHeader("Bearer ab.cd-ef_gh")).toBe("ab.cd-ef_gh")
  })

  it("rejects tokens with whitespace mid-token", () => {
    expect(parseBearerHeader("Bearer abc def")).toBeUndefined()
  })
})
