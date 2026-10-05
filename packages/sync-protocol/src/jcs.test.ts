import vectorFile from "../../../lib/plugin/character-pack/__fixtures__/jcs-vectors.json"
import { canonicalizeJson, CanonicalJsonError } from "./jcs"

describe("JCS copy", () => {
  it.each(vectorFile.vectors)("matches the shared golden vector: $name", ({ input, expected }) => {
    expect(canonicalizeJson(input)).toBe(expected)
  })

  it("refuses values that are not JSON", () => {
    expect(() => canonicalizeJson({ a: undefined, b: Number.NaN })).toThrow(CanonicalJsonError)
    expect(() => canonicalizeJson(new Date(0))).toThrow(CanonicalJsonError)
    expect(() => canonicalizeJson("\ud800")).toThrow(CanonicalJsonError)
  })
})
