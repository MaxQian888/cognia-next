import {
  TAB_COLOR_PRESETS,
  TAB_ICON_PRESETS,
  TAB_COLOR_CLASSES,
  DEFAULT_TAB_APPEARANCE,
  normalizeTabColor,
  normalizeTabIcon,
  tabColorBorderClass,
  tabColorDotClass,
  type TabColorPreset,
} from "./tab-appearance"

describe("tab-appearance", () => {
  describe("TAB_COLOR_PRESETS", () => {
    it("contains 9 presets including 'none'", () => {
      expect(TAB_COLOR_PRESETS).toHaveLength(9)
      expect(TAB_COLOR_PRESETS[0]).toBe("none")
    })

    it("every preset has a matching class entry", () => {
      for (const preset of TAB_COLOR_PRESETS) {
        expect(TAB_COLOR_CLASSES[preset]).toBeDefined()
        expect(TAB_COLOR_CLASSES[preset]).toHaveProperty("border")
        expect(TAB_COLOR_CLASSES[preset]).toHaveProperty("dot")
      }
    })
  })

  describe("TAB_ICON_PRESETS", () => {
    it("contains 9 presets including 'none'", () => {
      expect(TAB_ICON_PRESETS).toHaveLength(9)
      expect(TAB_ICON_PRESETS[0]).toBe("none")
    })
  })

  describe("DEFAULT_TAB_APPEARANCE", () => {
    it("defaults to no color and no icon", () => {
      expect(DEFAULT_TAB_APPEARANCE.color).toBe("none")
      expect(DEFAULT_TAB_APPEARANCE.icon).toBe("none")
    })
  })

  describe("normalizeTabColor", () => {
    it("returns valid color presets as-is", () => {
      expect(normalizeTabColor("red")).toBe("red")
      expect(normalizeTabColor("blue")).toBe("blue")
      expect(normalizeTabColor("none")).toBe("none")
    })

    it("returns 'none' for invalid string values", () => {
      expect(normalizeTabColor("invalid")).toBe("none")
      expect(normalizeTabColor("")).toBe("none")
      expect(normalizeTabColor("RED")).toBe("none")
    })

    it("returns 'none' for non-string values", () => {
      expect(normalizeTabColor(null)).toBe("none")
      expect(normalizeTabColor(undefined)).toBe("none")
      expect(normalizeTabColor(42)).toBe("none")
      expect(normalizeTabColor({})).toBe("none")
    })
  })

  describe("normalizeTabIcon", () => {
    it("returns valid icon presets as-is", () => {
      expect(normalizeTabIcon("terminal")).toBe("terminal")
      expect(normalizeTabIcon("server")).toBe("server")
      expect(normalizeTabIcon("none")).toBe("none")
    })

    it("returns 'none' for invalid string values", () => {
      expect(normalizeTabIcon("invalid")).toBe("none")
      expect(normalizeTabIcon("")).toBe("none")
      expect(normalizeTabIcon("TERMINAL")).toBe("none")
    })

    it("returns 'none' for non-string values", () => {
      expect(normalizeTabIcon(null)).toBe("none")
      expect(normalizeTabIcon(undefined)).toBe("none")
      expect(normalizeTabIcon(42)).toBe("none")
      expect(normalizeTabIcon({})).toBe("none")
    })
  })

  describe("tabColorBorderClass", () => {
    it("returns empty string for 'none'", () => {
      expect(tabColorBorderClass("none")).toBe("")
    })

    it("returns a border class for valid presets", () => {
      const presets: TabColorPreset[] = [
        "red",
        "orange",
        "yellow",
        "green",
        "cyan",
        "blue",
        "purple",
        "pink",
      ]
      for (const preset of presets) {
        const cls = tabColorBorderClass(preset)
        expect(cls).toMatch(/^border-l-/)
      }
    })
  })

  describe("tabColorDotClass", () => {
    it("returns empty string for 'none'", () => {
      expect(tabColorDotClass("none")).toBe("")
    })

    it("returns a bg class for valid presets", () => {
      const presets: TabColorPreset[] = [
        "red",
        "orange",
        "yellow",
        "green",
        "cyan",
        "blue",
        "purple",
        "pink",
      ]
      for (const preset of presets) {
        const cls = tabColorDotClass(preset)
        expect(cls).toMatch(/^bg-/)
      }
    })
  })
})
