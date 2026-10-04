import { describe, expect, it } from "vitest"

import { localeFrom, MESSAGES, t } from "./strings"

describe("page strings", () => {
  it("has the same keys in English and Chinese, none empty", () => {
    expect(Object.keys(MESSAGES.zh).sort()).toEqual(Object.keys(MESSAGES.en).sort())
    for (const locale of ["en", "zh"] as const) {
      for (const [key, value] of Object.entries(MESSAGES[locale]))
        expect(value, `${locale}.${key}`).not.toBe("")
    }
  })

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      expect(placeholders(MESSAGES.zh[key]), key).toEqual(placeholders(MESSAGES.en[key]))
    }
  })

  it("interpolates and leaves unknown placeholders visible", () => {
    expect(t("en", "signIn.continueWith", { provider: "GitHub" })).toBe("Continue with GitHub")
    expect(t("zh", "signIn.continueWith", { provider: "飞书" })).toBe("使用飞书继续")
    expect(t("en", "signIn.continueWith")).toBe("Continue with {provider}")
  })

  it("picks Chinese or English from Accept-Language by weight", () => {
    expect(localeFrom("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh")
    expect(localeFrom("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en")
    expect(localeFrom("fr-FR,zh-TW;q=0.5")).toBe("zh")
    expect(localeFrom("en;q=0.1, zh;q=0.9")).toBe("zh")
    expect(localeFrom("de-DE")).toBe("en")
    expect(localeFrom("zh;q=0")).toBe("en")
    expect(localeFrom(null)).toBe("en")
  })
})
