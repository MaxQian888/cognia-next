import {
  crockfordDecode,
  crockfordEncode,
  formatRecoveryKey,
  normalizeCrockford,
  parseRecoveryKey,
  RECOVERY_KEY_CHARS,
} from "./crockford"

const KEY = Uint8Array.from({ length: 16 }, (_, i) => i * 17)

describe("Crockford base32", () => {
  it("encodes 16 bytes as 26 characters whose last carries two zero bits", () => {
    const text = crockfordEncode(KEY)
    expect(text).toHaveLength(RECOVERY_KEY_CHARS)
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/)
    expect(crockfordDecode(text, 16)).toEqual(KEY)
    expect(crockfordEncode(new Uint8Array([0xff]))).toBe("ZW")
  })

  it("shows the recovery key in groups of four and reads it back forgivingly", () => {
    const shown = formatRecoveryKey(KEY)
    expect(shown).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
    const typed = ` ${shown.toLowerCase().replace(/-/g, " ").replace(/1/g, "l").replace(/0/g, "o")} `
    expect(parseRecoveryKey(typed)).toEqual(KEY)
    expect(normalizeCrockford("i-L o")).toBe("110")
  })

  it("refuses a wrong length, a foreign character and non-zero padding", () => {
    const shown = crockfordEncode(KEY)
    expect(() => parseRecoveryKey(shown.slice(1))).toThrow("26 characters")
    expect(() => parseRecoveryKey(`U${shown.slice(1)}`)).toThrow("invalid character")
    // The last character's two low bits are padding: "Z" sets them.
    expect(() => parseRecoveryKey(`${shown.slice(0, -1)}Z`)).toThrow("padding")
    expect(() => formatRecoveryKey(new Uint8Array(15))).toThrow("16 bytes")
  })
})
