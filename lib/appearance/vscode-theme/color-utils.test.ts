import {
  darken,
  isHexColor,
  lighten,
  luminance,
  mix,
  parseHex,
  readableForeground,
  stripAlpha,
  toHex,
} from "./color-utils"

describe("isHexColor", () => {
  it("accepts the four hex forms", () => {
    expect(isHexColor("#abc")).toBe(true)
    expect(isHexColor("#abcd")).toBe(true)
    expect(isHexColor("#aabbcc")).toBe(true)
    expect(isHexColor("#aabbccdd")).toBe(true)
    expect(isHexColor("#A1B2C3")).toBe(true)
  })
  it("rejects non-hex inputs", () => {
    expect(isHexColor("rgb(0,0,0)")).toBe(false)
    expect(isHexColor("#xyzxyz")).toBe(false)
    expect(isHexColor("aabbcc")).toBe(false)
    expect(isHexColor("#aabbccdde")).toBe(false)
    expect(isHexColor("")).toBe(false)
  })
})

describe("parseHex", () => {
  it("parses 6-digit hex", () => {
    expect(parseHex("#ff8000")).toEqual({ r: 255, g: 128, b: 0 })
  })
  it("expands 3-digit hex", () => {
    expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204 })
  })
  it("captures alpha from 8-digit hex", () => {
    const out = parseHex("#10204080")
    expect(out?.r).toBe(0x10)
    expect(out?.g).toBe(0x20)
    expect(out?.b).toBe(0x40)
    expect(out?.a).toBeCloseTo(128 / 255, 4)
  })
  it("captures alpha from 4-digit hex", () => {
    const out = parseHex("#abcd")
    expect(out?.r).toBe(0xaa)
    expect(out?.g).toBe(0xbb)
    expect(out?.b).toBe(0xcc)
    expect(out?.a).toBeCloseTo(0xdd / 255, 4)
  })
  it("returns null for non-hex strings", () => {
    expect(parseHex("blue")).toBeNull()
    expect(parseHex("#zzz")).toBeNull()
    expect(parseHex("")).toBeNull()
  })
})

describe("toHex", () => {
  it("formats with zero-padding", () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe("#000000")
    expect(toHex({ r: 1, g: 2, b: 3 })).toBe("#010203")
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff")
  })
  it("clamps and rounds out-of-range values", () => {
    expect(toHex({ r: -10, g: 300, b: 128.4 })).toBe("#00ff80")
  })
})

describe("stripAlpha", () => {
  it("converts an 8-digit hex to a 6-digit hex", () => {
    expect(stripAlpha("#aabbccdd")).toBe("#aabbcc")
  })
  it("leaves a 6-digit hex alone", () => {
    expect(stripAlpha("#abcdef")).toBe("#abcdef")
  })
  it("returns the input unchanged when not hex", () => {
    expect(stripAlpha("rgb(1,2,3)")).toBe("rgb(1,2,3)")
  })
})

describe("luminance", () => {
  it("approaches 1 for white and 0 for black", () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 1)
    expect(luminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 1)
  })
})

describe("mix", () => {
  it("returns a at t=0 and b at t=1", () => {
    const a = { r: 0, g: 0, b: 0 }
    const b = { r: 255, g: 0, b: 0 }
    expect(mix(a, b, 0)).toEqual(a)
    expect(mix(a, b, 1)).toEqual(b)
  })
  it("mixes at the midpoint", () => {
    const result = mix({ r: 0, g: 0, b: 0 }, { r: 200, g: 100, b: 50 }, 0.5)
    expect(result.r).toBe(100)
    expect(result.g).toBe(50)
    expect(result.b).toBe(25)
  })
  it("clamps t outside 0..1", () => {
    const a = { r: 0, g: 0, b: 0 }
    const b = { r: 255, g: 0, b: 0 }
    expect(mix(a, b, -0.5)).toEqual(a)
    expect(mix(a, b, 1.5)).toEqual(b)
  })
})

describe("lighten / darken", () => {
  it("lighten moves toward white", () => {
    const out = lighten("#000000", 0.5)
    expect(out).toBe("#808080")
  })
  it("darken moves toward black", () => {
    const out = darken("#ffffff", 0.5)
    expect(out).toBe("#808080")
  })
  it("returns input unchanged when not hex", () => {
    expect(lighten("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)")
    expect(darken("blue", 0.5)).toBe("blue")
  })
})

describe("readableForeground", () => {
  it("picks dark text on a light bg", () => {
    expect(readableForeground("#ffffff")).toBe("#0f172a")
  })
  it("picks light text on a dark bg", () => {
    expect(readableForeground("#000000")).toBe("#f8fafc")
  })
  it("falls back to dark text for unparseable inputs", () => {
    expect(readableForeground("rgb(0,0,0)")).toBe("#0f172a")
  })
})
