import { translate } from "./use-plugin-t"
import { I18N_MESSAGES } from "./i18n"

describe("translate", () => {
  it("prefixes keys and interpolates variables", () => {
    expect(translate("en", "findings.count", { count: 3 })).toBe("3 findings")
  })

  it("serves zh-CN", () => {
    expect(translate("zh-CN", "findings.count", { count: 3 })).toBe("3 个漏洞")
  })

  it("falls back to English for an unknown locale", () => {
    expect(translate("fr", "panel.tab.scan")).toBe("Scan")
  })

  it("returns the raw key when nothing matches", () => {
    expect(translate("en", "no.such.key")).toBe("no.such.key")
  })
})

describe("locale parity", () => {
  it("has identical key sets in en and zh-CN", () => {
    const en = Object.keys(I18N_MESSAGES.en).sort()
    const zh = Object.keys(I18N_MESSAGES["zh-CN"]).sort()
    expect(zh).toEqual(en)
  })

  it("keeps every {var} placeholder consistent across locales", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(I18N_MESSAGES.en) as Array<keyof typeof I18N_MESSAGES.en>) {
      const enVars = vars(I18N_MESSAGES.en[key])
      const zhVars = vars(I18N_MESSAGES["zh-CN"][key])
      expect([key, zhVars]).toEqual([key, enVars])
    }
  })
})
