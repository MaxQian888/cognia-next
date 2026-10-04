import {
  LEGACY_TRACE_URL_KEYS,
  TRACE_CONTROL_PARAMS,
  TRACE_EXPLORE_PARAMS,
  TRACE_URL_KEYS,
  consumedLegacyKeys,
  decodeControls,
  decodeExploreState,
  encodeControls,
  encodeExploreState,
  ownedParamsSignature,
  replaceOwnedParams,
  type UrlControls,
} from "./url-state"

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

const opusFilter = encodeURIComponent(JSON.stringify({ model: ["opus"] }))

describe("url-state", () => {
  describe("key sets", () => {
    it("owns t-prefixed keys so they cannot collide with the Logs panel's", () => {
      expect(TRACE_URL_KEYS).toEqual({
        range: "trange",
        from: "tfrom",
        to: "tto",
        filters: "tf",
        span: "tspan",
        query: "tq",
        errorsOnly: "terr",
        subView: "tview",
      })
    })

    it("splits the owned keys into control and explore groups, excluding the sub-view", () => {
      expect([...TRACE_CONTROL_PARAMS]).toEqual(["trange", "tfrom", "tto", "tf"])
      expect([...TRACE_EXPLORE_PARAMS]).toEqual(["tspan", "tq", "terr"])
      expect([...TRACE_CONTROL_PARAMS, ...TRACE_EXPLORE_PARAMS]).not.toContain("tview")
    })

    it("names the pre-rename keys", () => {
      expect(LEGACY_TRACE_URL_KEYS).toEqual({
        range: "range",
        from: "from",
        to: "to",
        filters: "f",
      })
    })
  })

  describe("encodeControls", () => {
    it("omits the default (1h, no filters) → empty query", () => {
      expect(encodeControlsString(base)).toBe("")
    })

    it("encodes a non-default relative preset under trange", () => {
      expect(encodeControlsString({ ...base, rangePreset: "6h" })).toBe("trange=6h")
    })

    it("encodes a custom range under trange/tfrom/tto", () => {
      const qs = encodeControls({
        ...base,
        rangePreset: "custom",
        customSince: 100,
        customUntil: 200,
      })
      expect(qs.get("trange")).toBe("custom")
      expect(qs.get("tfrom")).toBe("100")
      expect(qs.get("tto")).toBe("200")
      // Never the legacy keys.
      expect(qs.has("range")).toBe(false)
      expect(qs.has("from")).toBe(false)
      expect(qs.has("to")).toBe(false)
    })

    it("skips a custom range missing a bound", () => {
      expect(encodeControlsString({ ...base, rangePreset: "custom", customSince: 100 })).toBe("")
      expect(encodeControlsString({ ...base, rangePreset: "custom", customUntil: 100 })).toBe("")
    })

    it("encodes non-empty filters as JSON under tf", () => {
      const qs = encodeControls({ ...base, filters: { model: ["opus"] } })
      expect(qs.get("tf")).toBe('{"model":["opus"]}')
      expect(qs.has("f")).toBe(false)
    })

    it("omits filters whose dimensions are all empty", () => {
      expect(encodeControlsString({ ...base, filters: { model: [], provider: [] } })).toBe("")
    })
  })

  describe("decodeControls", () => {
    it("returns null when no trace params are present", () => {
      expect(decodeControls("")).toBeNull()
      expect(decodeControls("other=1")).toBeNull()
      expect(decodeControls("channel=traces")).toBeNull()
    })

    it("returns null when only a bound is present without a range or filters", () => {
      expect(decodeControls("tfrom=100&tto=200")).toBeNull()
    })

    it("decodes a relative preset", () => {
      expect(decodeControls("trange=6h")).toMatchObject({ rangePreset: "6h", filters: {} })
    })

    it("accepts a URLSearchParams as well as a string", () => {
      expect(decodeControls(new URLSearchParams("trange=24h"))?.rangePreset).toBe("24h")
    })

    it("ignores an unknown preset, defaulting to 1h", () => {
      expect(decodeControls("trange=nope")?.rangePreset).toBe("1h")
    })

    it("decodes a custom range", () => {
      expect(decodeControls("trange=custom&tfrom=100&tto=200")).toEqual({
        rangePreset: "custom",
        customSince: 100,
        customUntil: 200,
        filters: {},
      })
    })

    it("falls back to 1h when custom bounds are unparseable", () => {
      const out = decodeControls("trange=custom&tfrom=x&tto=y")
      expect(out?.rangePreset).toBe("1h")
      expect(out?.customSince).toBeNull()
      expect(out?.customUntil).toBeNull()
    })

    it("falls back to 1h when a custom bound is missing (no 1970 window)", () => {
      const missingTo = decodeControls("trange=custom&tfrom=100")
      expect(missingTo).toEqual({
        rangePreset: "1h",
        customSince: null,
        customUntil: null,
        filters: {},
      })
      expect(decodeControls("trange=custom&tto=200")?.rangePreset).toBe("1h")
    })

    it("falls back to 1h when a custom bound is empty or whitespace", () => {
      expect(decodeControls("trange=custom&tfrom=&tto=200")?.rangePreset).toBe("1h")
      expect(decodeControls("trange=custom&tfrom=100&tto=%20")?.rangePreset).toBe("1h")
    })

    it("falls back to 1h when a custom bound is non-finite", () => {
      expect(decodeControls("trange=custom&tfrom=100&tto=Infinity")?.rangePreset).toBe("1h")
      expect(decodeControls("trange=custom&tfrom=NaN&tto=200")?.rangePreset).toBe("1h")
    })

    it("decodes filters and tolerates malformed JSON", () => {
      expect(decodeControls(`tf=${opusFilter}`)?.filters).toEqual({ model: ["opus"] })
      expect(decodeControls("tf=%7Bnope")?.filters).toEqual({})
    })

    it("sanitizes decoded filters (unknown dims, non-strings, duplicates)", () => {
      const raw = encodeURIComponent(
        JSON.stringify({ model: ["opus", 3, "opus"], bogus: ["x"], provider: ["anthropic"] })
      )
      expect(decodeControls(`tf=${raw}`)?.filters).toEqual({
        model: ["opus"],
        provider: ["anthropic"],
      })
    })

    it("round-trips a rich state", () => {
      const controls: UrlControls = {
        rangePreset: "custom",
        customSince: 1000,
        customUntil: 2000,
        filters: { model: ["opus"], surface: ["chat"], project: ["p1"] },
      }
      expect(decodeControls(encodeControls(controls))).toEqual(controls)
    })

    describe("legacy keys", () => {
      it("reads range/from/to/f on a channel=traces link", () => {
        expect(
          decodeControls(`channel=traces&range=custom&from=100&to=200&f=${opusFilter}`)
        ).toEqual({
          rangePreset: "custom",
          customSince: 100,
          customUntil: 200,
          filters: { model: ["opus"] },
        })
        expect(decodeControls("channel=traces&range=6h")?.rangePreset).toBe("6h")
      })

      it("ignores legacy keys without channel=traces (they belong to the Logs panel)", () => {
        expect(decodeControls("range=6h")).toBeNull()
        expect(decodeControls("from=100&to=200")).toBeNull()
        expect(decodeControls(`channel=logs&range=6h&f=${opusFilter}`)).toBeNull()
      })

      it("ignores a bare from/to pair even on a traces link", () => {
        expect(decodeControls("channel=traces&from=100&to=200")).toBeNull()
      })

      it("prefers the owned keys whenever any is present, never mixing in legacy ones", () => {
        const out = decodeControls(`channel=traces&trange=24h&range=6h&f=${opusFilter}`)
        expect(out).toEqual({
          rangePreset: "24h",
          customSince: null,
          customUntil: null,
          filters: {},
        })
      })

      it("falls back to 1h on a half-formed legacy custom range", () => {
        expect(decodeControls("channel=traces&range=custom&from=100")?.rangePreset).toBe("1h")
      })
    })
  })

  describe("consumedLegacyKeys", () => {
    it("is empty without channel=traces", () => {
      expect(consumedLegacyKeys("range=6h&from=1&to=2&f=x")).toEqual([])
    })

    it("is empty when owned keys are present (the legacy branch was not taken)", () => {
      expect(consumedLegacyKeys("channel=traces&trange=6h&range=24h")).toEqual([])
    })

    it("lists range and filters for a relative legacy link, leaving from/to alone", () => {
      expect(consumedLegacyKeys("channel=traces&range=6h&from=1&to=2&f=x")).toEqual(["range", "f"])
    })

    it("lists range, from and to for a custom legacy link", () => {
      expect(
        consumedLegacyKeys(new URLSearchParams("channel=traces&range=custom&from=1&to=2"))
      ).toEqual(["range", "from", "to"])
    })

    it("only lists the custom bounds actually present", () => {
      expect(consumedLegacyKeys("channel=traces&range=custom&from=1")).toEqual(["range", "from"])
    })

    it("lists a filters-only legacy link", () => {
      expect(consumedLegacyKeys(`channel=traces&f=${opusFilter}`)).toEqual(["f"])
    })
  })

  describe("ownedParamsSignature", () => {
    it("is order-independent and ignores foreign keys", () => {
      const a = ownedParamsSignature("trange=6h&channel=traces&tf=x", TRACE_CONTROL_PARAMS)
      const b = ownedParamsSignature("tf=x&traceId=t1&trange=6h&from=9", TRACE_CONTROL_PARAMS)
      expect(a).toBe(b)
      expect(a).toBe("tf=x&trange=6h")
    })

    it("is empty when none of the keys are present", () => {
      expect(ownedParamsSignature("channel=traces", TRACE_EXPLORE_PARAMS)).toBe("")
    })

    it("changes when an owned value changes", () => {
      expect(ownedParamsSignature("tq=a", TRACE_EXPLORE_PARAMS)).not.toBe(
        ownedParamsSignature("tq=b", TRACE_EXPLORE_PARAMS)
      )
    })

    it("accepts URLSearchParams", () => {
      expect(ownedParamsSignature(new URLSearchParams("tspan=s1"), TRACE_EXPLORE_PARAMS)).toBe(
        "tspan=s1"
      )
    })
  })

  describe("replaceOwnedParams", () => {
    it("replaces owned keys and leaves every foreign key untouched", () => {
      const next = replaceOwnedParams(
        "?channel=traces&traceId=t1&trange=6h&tf=x&from=5",
        TRACE_CONTROL_PARAMS,
        new URLSearchParams("trange=24h")
      )
      const params = new URLSearchParams(next)
      expect(params.get("trange")).toBe("24h")
      expect(params.has("tf")).toBe(false)
      expect(params.get("channel")).toBe("traces")
      expect(params.get("traceId")).toBe("t1")
      expect(params.get("from")).toBe("5")
      expect(next.startsWith("?")).toBe(false)
    })

    it("deletes the extra keys it is told to (consumed legacy keys)", () => {
      const next = replaceOwnedParams(
        "channel=traces&range=6h&f=x",
        TRACE_CONTROL_PARAMS,
        new URLSearchParams("trange=6h&tf=x"),
        ["range", "f"]
      )
      expect(new URLSearchParams(next).toString()).toBe("channel=traces&trange=6h&tf=x")
    })

    it("returns an empty string when nothing is left", () => {
      expect(replaceOwnedParams("trange=6h", TRACE_CONTROL_PARAMS, new URLSearchParams())).toBe("")
    })
  })

  describe("explore state", () => {
    it("encodes span, trimmed query and errors-only", () => {
      const qs = encodeExploreState({ spanId: "s1", query: "  bash  ", errorsOnly: true })
      expect(qs.get("tspan")).toBe("s1")
      expect(qs.get("tq")).toBe("bash")
      expect(qs.get("terr")).toBe("1")
    })

    it("omits empty values", () => {
      expect(encodeExploreState({ spanId: null, query: "   ", errorsOnly: false }).toString()).toBe(
        ""
      )
      expect(encodeExploreState({ spanId: "", query: "", errorsOnly: null }).toString()).toBe("")
    })

    it("decodes absent keys as 'not specified'", () => {
      expect(decodeExploreState("")).toEqual({ spanId: null, query: "", errorsOnly: null })
    })

    it("decodes present keys", () => {
      expect(decodeExploreState("tspan=s1&tq=bash&terr=1")).toEqual({
        spanId: "s1",
        query: "bash",
        errorsOnly: true,
      })
      expect(decodeExploreState(new URLSearchParams("terr=true")).errorsOnly).toBe(true)
      expect(decodeExploreState("terr=0").errorsOnly).toBe(false)
    })

    it("treats a blank span as absent", () => {
      expect(decodeExploreState("tspan=%20%20").spanId).toBeNull()
      expect(decodeExploreState("tspan=").spanId).toBeNull()
    })

    it("round-trips", () => {
      const state = { spanId: "s9", query: "tool", errorsOnly: true }
      expect(decodeExploreState(encodeExploreState(state))).toEqual(state)
    })
  })
})
