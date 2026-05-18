import { isUuidV7, uuidv7 } from "./uuidv7"

describe("uuidv7", () => {
  it("emits 36-char strings with hyphens at positions 8/13/18/23", () => {
    const id = uuidv7()
    expect(id).toHaveLength(36)
    expect(id[8]).toBe("-")
    expect(id[13]).toBe("-")
    expect(id[18]).toBe("-")
    expect(id[23]).toBe("-")
  })

  it("stamps version 7 at position 14", () => {
    expect(uuidv7()[14]).toBe("7")
  })

  it("stamps RFC 4122 variant bits (8/9/a/b at position 19)", () => {
    for (let i = 0; i < 50; i += 1) {
      const v = uuidv7()[19].toLowerCase()
      expect(["8", "9", "a", "b"]).toContain(v)
    }
  })

  it("encodes the unix-ms timestamp in the leading 48 bits, big-endian", () => {
    const ts = 1_700_000_000_000 // 0x18BE3B57E00 — exercises high-nibble assembly
    const id = uuidv7(ts)
    // Reconstruct the 48-bit timestamp from the leading hex bytes.
    const hex = id.slice(0, 8) + id.slice(9, 13)
    const recoveredHi = parseInt(hex.slice(0, 4), 16)
    const recoveredLo = parseInt(hex.slice(4, 12), 16)
    const recovered = recoveredHi * 2 ** 32 + recoveredLo
    expect(recovered).toBe(ts)
  })

  it("returns unique values on rapid back-to-back calls", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i += 1) ids.add(uuidv7())
    expect(ids.size).toBe(1000)
  })

  it("rejects negative / non-finite nowMs", () => {
    expect(() => uuidv7(-1)).toThrow()
    expect(() => uuidv7(Number.NaN)).toThrow()
    expect(() => uuidv7(Number.POSITIVE_INFINITY)).toThrow()
  })

  it("isUuidV7 accepts the generator's own output", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isUuidV7(uuidv7())).toBe(true)
    }
  })

  it("isUuidV7 rejects v4 / malformed inputs", () => {
    // v4 UUID — version nibble at position 14 is "4".
    expect(isUuidV7("123e4567-e89b-42d3-a456-426614174000")).toBe(false)
    // Wrong length.
    expect(isUuidV7("abc")).toBe(false)
    // Missing hyphens.
    expect(isUuidV7("0193c2b00000700080000000000000000001")).toBe(false)
    // Upper-case hex isn't accepted (we emit lowercase).
    expect(isUuidV7("0193C2B0-0000-7000-8000-000000000001")).toBe(false)
    // Non-hex chars.
    expect(isUuidV7("0193c2b0-0000-7000-8000-zzzzzzzzzzzz")).toBe(false)
  })

  it("monotonically orders by timestamp", () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    expect(b > a).toBe(true)
  })
})
