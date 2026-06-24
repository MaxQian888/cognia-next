import { CAPABILITY_META, CAPABILITY_IDS } from "./plugin-capabilities"

describe("CAPABILITY_META", () => {
  it("has unique capability ids", () => {
    const ids = CAPABILITY_META.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("exposes an icon and i18nKey for every entry", () => {
    for (const meta of CAPABILITY_META) {
      expect(typeof meta.id).toBe("string")
      expect(typeof meta.i18nKey).toBe("string")
      expect(meta.icon).toBeDefined()
    }
  })

  it("CAPABILITY_IDS mirrors the meta ids in order", () => {
    expect(CAPABILITY_IDS).toEqual(CAPABILITY_META.map((c) => c.id))
  })

  it("covers the capabilities both the rail and the filter sheet need", () => {
    // Union that the sidebar (14) and the filter sheet (18) used to hardcode
    // separately. A regression here means the two surfaces could drift again.
    const required = [
      "tools",
      "components",
      "modes",
      "themes",
      "commands",
      "hooks",
      "skills",
      "media",
      "canvas",
      "a2ui",
      "ai-provider",
      "providers",
      "processors",
      "scheduler",
      "exporters",
      "importers",
      "python",
      "external-agent-preset",
    ]
    for (const id of required) {
      expect(CAPABILITY_IDS).toContain(id)
    }
  })
})
