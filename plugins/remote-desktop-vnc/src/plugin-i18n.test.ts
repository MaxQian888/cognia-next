import manifestJson from "../plugin.json"

const locales = manifestJson.i18n.locales

describe("plugin.json i18n bundle", () => {
  it("uses bare keys and the same key set in both locales", () => {
    const en = Object.keys(locales.en).sort()
    const zh = Object.keys(locales["zh-CN"]).sort()
    expect(en.every((key) => !key.startsWith("plugin."))).toBe(true)
    expect(zh).toEqual(en)
  })

  it("translates instead of copying the English text", () => {
    const en = locales.en as Record<string, string>
    const zh = locales["zh-CN"] as Record<string, string>
    for (const key of [
      "manifest.name",
      "manifest.description",
      "viewer.label",
      "viewer.viewOnly",
    ]) {
      expect(zh[key]).not.toBe(en[key])
    }
  })
})
