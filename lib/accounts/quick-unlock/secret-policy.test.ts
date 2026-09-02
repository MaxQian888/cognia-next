import {
  approximateEntropyBits,
  canonicalizePattern,
  canonicalizePin,
  validatePattern,
  validatePin,
} from "./secret-policy"
import { MAX_PIN_LENGTH, MIN_PATTERN_LENGTH, MIN_PIN_LENGTH } from "./types"

describe("validatePin", () => {
  it("accepts an ordinary PIN", () => {
    expect(validatePin("428193")).toEqual({ ok: true })
  })

  it("enforces the length bounds", () => {
    expect(validatePin("4281")).toEqual({ ok: false, reason: "pin-too-short" })
    expect(validatePin("4".repeat(MAX_PIN_LENGTH + 1))).toEqual({
      ok: false,
      reason: "pin-too-long",
    })
    expect(validatePin("4".repeat(MIN_PIN_LENGTH - 1))).toEqual({
      ok: false,
      reason: "pin-too-short",
    })
  })

  it("rejects anything that is not digits", () => {
    expect(validatePin("42a193")).toEqual({ ok: false, reason: "pin-not-numeric" })
    expect(validatePin("4281 3")).toEqual({ ok: false, reason: "pin-not-numeric" })
  })

  it("tolerates surrounding whitespace rather than rejecting it", () => {
    // A trailing space from a paste must not read as a different PIN, or the
    // user is locked out of a credential they entered correctly.
    expect(validatePin("  428193  ")).toEqual({ ok: true })
  })

  it("rejects a repeated digit", () => {
    expect(validatePin("000000")).toEqual({ ok: false, reason: "pin-too-simple" })
    expect(validatePin("777777")).toEqual({ ok: false, reason: "pin-too-simple" })
  })

  it("rejects ascending and descending runs, wraparound included", () => {
    // These are a large enough share of real PINs that allowing them would
    // undercut the whole attempt-cap argument.
    expect(validatePin("123456")).toEqual({ ok: false, reason: "pin-too-simple" })
    expect(validatePin("654321")).toEqual({ ok: false, reason: "pin-too-simple" })
    expect(validatePin("789012")).toEqual({ ok: false, reason: "pin-too-simple" })
    expect(validatePin("321098")).toEqual({ ok: false, reason: "pin-too-simple" })
  })

  it("accepts a PIN that merely starts like a run", () => {
    expect(validatePin("123457")).toEqual({ ok: true })
  })
})

describe("validatePattern", () => {
  it("accepts an ordinary pattern", () => {
    expect(validatePattern([0, 3, 4, 5, 8])).toEqual({ ok: true })
  })

  it("enforces the length bounds", () => {
    expect(validatePattern([0, 1, 2, 5])).toEqual({ ok: false, reason: "pattern-too-short" })
    // Length is checked before distinctness, so an over-long input reports
    // the bound rather than the repeat it also contains.
    expect(validatePattern([0, 1, 2, 3, 4, 5, 6, 7, 8, 0])).toEqual({
      ok: false,
      reason: "pattern-too-long",
    })
  })

  it("requires distinct nodes", () => {
    expect(validatePattern([0, 3, 4, 3, 8])).toEqual({ ok: false, reason: "pattern-repeats-node" })
  })

  it("rejects a node outside the grid", () => {
    expect(validatePattern([0, 3, 4, 5, 9])).toEqual({ ok: false, reason: "pattern-out-of-range" })
    expect(validatePattern([0, 3, 4, 5, -1])).toEqual({ ok: false, reason: "pattern-out-of-range" })
    expect(validatePattern([0, 3, 4, 5, 1.5])).toEqual({
      ok: false,
      reason: "pattern-out-of-range",
    })
  })

  it("rejects the outline of the square in either direction", () => {
    const outline = [0, 3, 6, 7, 8, 5, 2, 1]
    expect(validatePattern(outline)).toEqual({ ok: false, reason: "pattern-too-simple" })
    expect(validatePattern([...outline].reverse())).toEqual({
      ok: false,
      reason: "pattern-too-simple",
    })
  })

  it("rejects the full sweep", () => {
    expect(validatePattern([0, 1, 2, 3, 4, 5, 6, 7, 8])).toEqual({
      ok: false,
      reason: "pattern-too-simple",
    })
  })

  it("accepts the shortest allowed length", () => {
    const nodes = [1, 3, 4, 7, 8]
    expect(nodes).toHaveLength(MIN_PATTERN_LENGTH)
    expect(validatePattern(nodes)).toEqual({ ok: true })
  })
})

describe("canonicalization", () => {
  it("namespaces by method so a PIN can never satisfy a pattern verifier", () => {
    expect(canonicalizePin("123456")).toBe("pin:123456")
    expect(canonicalizePattern([1, 2, 3, 4, 5, 6])).toBe("pattern:1-2-3-4-5-6")
    expect(canonicalizePin("123456")).not.toBe(canonicalizePattern([1, 2, 3, 4, 5, 6]))
  })

  it("normalises whitespace so the same PIN always hashes the same", () => {
    expect(canonicalizePin(" 428193 ")).toBe(canonicalizePin("428193"))
  })

  it("keeps pattern ORDER significant", () => {
    // The same nodes drawn in reverse are a different secret.
    expect(canonicalizePattern([0, 1, 2])).not.toBe(canonicalizePattern([2, 1, 0]))
  })
})

describe("approximateEntropyBits", () => {
  it("reports the modest reality of a six-digit PIN", () => {
    expect(approximateEntropyBits("pin", 6)).toBe(20)
  })

  it("reports a five-node pattern as under 19 bits", () => {
    // 9*8*7*6*5 === 15120, which is 13.9 bits. The number is here so the
    // "convenience factor, not a password" framing stays evidence-backed.
    expect(approximateEntropyBits("pattern", 5)).toBe(14)
  })

  it("reports even the full nine-node sweep as under 19 bits", () => {
    // 9! is 362880. Every pattern this app will accept is weaker than a
    // six-digit PIN, which is the whole reason for the device pepper and the
    // hard attempt cap.
    expect(approximateEntropyBits("pattern", 9)).toBe(18)
  })
})
