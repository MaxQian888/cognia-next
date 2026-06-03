import { isOcrToolAllowed } from "./ocr-tool-gate"
import type { Character } from "./types"

const char = (enableOcr?: boolean) => ({ enableOcr }) as Pick<Character, "enableOcr">

describe("isOcrToolAllowed", () => {
  it("allows by default (no character, non-IM)", () => {
    expect(isOcrToolAllowed({})).toBe(true)
  })

  it("allows a browser chat with enableOcr undefined or true", () => {
    expect(isOcrToolAllowed({ character: char(undefined) })).toBe(true)
    expect(isOcrToolAllowed({ character: char(true) })).toBe(true)
  })

  it("denies when the character explicitly sets enableOcr=false", () => {
    expect(isOcrToolAllowed({ character: char(false) })).toBe(false)
    // …even in an IM conversation that opted in.
    expect(
      isOcrToolAllowed({ character: char(false), imSession: true, allowOcrOverride: true })
    ).toBe(false)
  })

  it("allows IM sessions by default (allowOcr undefined)", () => {
    expect(isOcrToolAllowed({ imSession: true })).toBe(true)
    expect(isOcrToolAllowed({ imSession: true, allowOcrOverride: undefined })).toBe(true)
  })

  it("denies an IM session only when allowOcr is explicitly false", () => {
    expect(isOcrToolAllowed({ imSession: true, allowOcrOverride: false })).toBe(false)
  })

  it("ignores allowOcr=false for non-IM sessions", () => {
    expect(isOcrToolAllowed({ imSession: false, allowOcrOverride: false })).toBe(true)
  })
})
