import {
  APPEARANCE_CONFIG_KEYS,
  countConfigKeys,
  exportAppearanceConfig,
  importAppearanceConfig,
} from "./appearance-config-io"

describe("appearance-config-io", () => {
  describe("exportAppearanceConfig", () => {
    it("emits a versioned document with only the defined appearance keys", () => {
      const json = exportAppearanceConfig({
        theme: "dark",
        colorTheme: "ocean",
        fontScale: "lg",
      })
      const parsed = JSON.parse(json)
      expect(parsed.formatVersion).toBe("v1")
      expect(parsed.$schema).toContain("appearance-config")
      expect(typeof parsed.exportedAt).toBe("string")
      expect(parsed.settings).toEqual({ theme: "dark", colorTheme: "ocean", fontScale: "lg" })
    })

    it("excludes device-local keys (wallpapers / background) even when present", () => {
      const json = exportAppearanceConfig({
        theme: "light",
        wallpapers: [{ id: "w1" }] as never,
        background: { enabled: true } as never,
      })
      const parsed = JSON.parse(json)
      expect(parsed.settings).toEqual({ theme: "light" })
      expect(parsed.settings.wallpapers).toBeUndefined()
      expect(parsed.settings.background).toBeUndefined()
    })

    it("omits keys whose value is undefined", () => {
      const json = exportAppearanceConfig({ theme: undefined, colorTheme: "rose" })
      const parsed = JSON.parse(json)
      expect(parsed.settings).toEqual({ colorTheme: "rose" })
    })
  })

  describe("importAppearanceConfig", () => {
    it("round-trips an exported document", () => {
      const original = { theme: "dark" as const, radius: { base: 1 }, customCssEnabled: true }
      const patch = importAppearanceConfig(exportAppearanceConfig(original))
      expect(patch).toEqual(original)
    })

    it("drops unrecognised keys (forward-compat with a newer exporter)", () => {
      const doc = JSON.stringify({
        formatVersion: "v1",
        settings: { theme: "dark", somethingNew: 42, providerSettings: {} },
      })
      expect(importAppearanceConfig(doc)).toEqual({ theme: "dark" })
    })

    it("throws on invalid JSON", () => {
      expect(() => importAppearanceConfig("{ not json")).toThrow(/not valid JSON/)
    })

    it("throws on a non-object payload", () => {
      expect(() => importAppearanceConfig("42")).toThrow(/must be an object/)
    })

    it("throws on an unsupported format version", () => {
      const doc = JSON.stringify({ formatVersion: "v2", settings: {} })
      expect(() => importAppearanceConfig(doc)).toThrow(/Unsupported appearance config version/)
    })

    it("throws when the settings object is missing", () => {
      const doc = JSON.stringify({ formatVersion: "v1" })
      expect(() => importAppearanceConfig(doc)).toThrow(/missing its settings/)
    })
  })

  describe("countConfigKeys", () => {
    it("counts the keys an imported patch will write", () => {
      expect(countConfigKeys({ theme: "dark", radius: { base: 1 } })).toBe(2)
      expect(countConfigKeys({})).toBe(0)
    })
  })

  it("every config key is a plausible appearance key (no dupes)", () => {
    expect(new Set(APPEARANCE_CONFIG_KEYS).size).toBe(APPEARANCE_CONFIG_KEYS.length)
    expect(APPEARANCE_CONFIG_KEYS).not.toContain("wallpapers")
    expect(APPEARANCE_CONFIG_KEYS).not.toContain("background")
  })
})
