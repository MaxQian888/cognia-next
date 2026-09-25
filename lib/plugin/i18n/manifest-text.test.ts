import { localizedPluginDescription, localizedPluginName } from "./manifest-text"

const manifest = {
  name: "Clipboard History",
  description: "Keep recent clipboard entries.",
  nameKey: "plugin.name",
  descriptionKey: "plugin.description",
  i18n: {
    locales: {
      en: { "plugin.name": "Clipboard History", "plugin.description": "Keep recent entries." },
      "zh-CN": { "plugin.name": "剪贴板历史" },
    },
  },
}

describe("localized manifest text", () => {
  it("reads the user's locale from the manifest bundle, with no registry involved", () => {
    expect(localizedPluginName(manifest, "zh-CN")).toBe("剪贴板历史")
  })

  it("falls back to English, then to the literal field", () => {
    expect(localizedPluginDescription(manifest, "zh-CN")).toBe("Keep recent entries.")
    expect(localizedPluginName({ ...manifest, i18n: undefined }, "zh-CN")).toBe("Clipboard History")
    expect(localizedPluginName({ name: "Plain", description: "" }, "zh-CN")).toBe("Plain")
  })

  it("ignores a key the bundle does not contain", () => {
    expect(localizedPluginName({ ...manifest, nameKey: "missing" }, "zh-CN")).toBe(
      "Clipboard History"
    )
  })
})
