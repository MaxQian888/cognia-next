import { decodeControls, encodeControls, type UrlControls } from "./url-state"

/** The hook writes params one by one; the tests read the whole query string. */
function encodeControlsString(c: UrlControls): string {
  return encodeControls(c).toString()
}

const base: UrlControls = {
  rangePreset: "1h",
  customSince: null,
  customUntil: null,
  filters: {},
}

describe("url-state", () => {
  describe("encodeControls", () => {
    it("omits the default (1h, no filters) → empty query", () => {
      expect(encodeControlsString(base)).toBe("")
    })

    it("encodes a non-default relative preset", () => {
      expect(encodeControlsString({ ...base, rangePreset: "6h" })).toBe("range=6h")
    })

    it("encodes a custom range", () => {
      const qs = encodeControls({
        ...base,
        rangePreset: "custom",
        customSince: 100,
        customUntil: 200,
      })
      expect(qs.get("range")).toBe("custom")
      expect(qs.get("from")).toBe("100")
      expect(qs.get("to")).toBe("200")
    })

    it("skips a custom range missing a bound", () => {
      expect(encodeControlsString({ ...base, rangePreset: "custom", customSince: 100 })).toBe("")
    })

    it("encodes non-empty filters as JSON", () => {
      const qs = encodeControls({ ...base, filters: { model: ["opus"] } })
      expect(qs.get("f")).toBe('{"model":["opus"]}')
    })
  })

  describe("decodeControls", () => {
    it("returns null when no observability params are present", () => {
      expect(decodeControls("")).toBeNull()
      expect(decodeControls("other=1")).toBeNull()
    })

    it("decodes a relative preset", () => {
      expect(decodeControls("range=6h")).toMatchObject({ rangePreset: "6h", filters: {} })
    })

    it("ignores an unknown preset, defaulting to 1h", () => {
      expect(decodeControls("range=nope")?.rangePreset).toBe("1h")
    })

    it("decodes a custom range", () => {
      expect(decodeControls("range=custom&from=100&to=200")).toMatchObject({
        rangePreset: "custom",
        customSince: 100,
        customUntil: 200,
      })
    })

    it("falls back off custom when bounds are unparseable", () => {
      const out = decodeControls("range=custom&from=x&to=y")
      expect(out?.rangePreset).toBe("1h")
      expect(out?.customSince).toBeNull()
    })

    it("decodes filters and tolerates malformed JSON", () => {
      expect(decodeControls('f={"model":["opus"]}')?.filters).toEqual({ model: ["opus"] })
      expect(decodeControls("f=%7Bnope")?.filters).toEqual({})
    })

    it("round-trips a rich state", () => {
      const controls: UrlControls = {
        rangePreset: "custom",
        customSince: 1000,
        customUntil: 2000,
        filters: { model: ["opus"], surface: ["chat"] },
      }
      expect(decodeControls(encodeControls(controls))).toEqual(controls)
    })
  })
})
