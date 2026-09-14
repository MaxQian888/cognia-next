import manifestJson from "../plugin.json"
import { I18N_MESSAGES, translate } from "./i18n"

it("keeps en and zh-CN key sets in parity with the manifest bundle", () => {
  const manifestLocales = (manifestJson as { i18n?: { locales?: Record<string, object> } }).i18n
    ?.locales
  expect(Object.keys(manifestLocales ?? {}).sort()).toEqual(["en", "zh-CN"])
  expect(I18N_MESSAGES).toEqual(manifestLocales)
  const enKeys = Object.keys(I18N_MESSAGES.en).sort()
  expect(Object.keys(I18N_MESSAGES["zh-CN"]).sort()).toEqual(enKeys)
  for (const locale of Object.values(I18N_MESSAGES)) {
    for (const [key, value] of Object.entries(locale)) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/)
      expect(value.trim().length).toBeGreaterThan(0)
    }
  }
})

describe("translate", () => {
  it("resolves the requested locale with interpolation", () => {
    expect(translate("zh-CN", "preview.slideOf", { index: 2, total: 5 })).toBe("第 2 张，共 5 张")
  })

  it("falls back to English for unknown locales and to the key for unknown keys", () => {
    expect(translate("fr", "preview.slides")).toBe("Slides")
    expect(translate("en", "missing.key")).toBe("missing.key")
  })
})
