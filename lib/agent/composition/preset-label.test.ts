import { presetDisplayName, type PresetNameTranslator } from "./preset-label"
import { STANDARD_PRESET, presetFromAgentMode } from "./preset-catalog"

const CUSTOM = presetFromAgentMode(
  {
    id: "my-reviewer",
    type: "custom",
    name: "My Reviewer",
    description: "",
    icon: "Sparkles",
  },
  "custom"
)

/** Build a next-intl-shaped `t` from a lookup table. */
function translator(table: Record<string, string>): PresetNameTranslator {
  const t = ((key: string) => table[key] ?? key) as PresetNameTranslator
  t.has = (key: string) => key in table
  return t
}

describe("presetDisplayName", () => {
  it("prefers the translated catalog name", () => {
    const t = translator({ "standard.name": "标准" })
    expect(presetDisplayName(STANDARD_PRESET, t)).toBe("标准")
  })

  it("falls back to the preset's own name when no translation exists", () => {
    expect(presetDisplayName(CUSTOM, translator({}))).toBe("My Reviewer")
  })

  it("falls back when the bundle has the key but its value is empty", () => {
    expect(presetDisplayName(CUSTOM, translator({ "my-reviewer.name": "" }))).toBe("My Reviewer")
  })

  // `has` is optional on older next-intl builds; a missing probe must read as
  // "no translation" rather than throwing mid-render.
  it("falls back when the translator cannot probe for a key", () => {
    const t = ((key: string) => key) as PresetNameTranslator
    expect(presetDisplayName(CUSTOM, t)).toBe("My Reviewer")
  })
})
