import { localeFromPathname } from "./locale-path"

const LANGUAGES = ["zh", "en"] as const

describe("localeFromPathname", () => {
  it("reads the locale from the first path segment", () => {
    expect(localeFromPathname("/en/docs/typo", LANGUAGES, "zh")).toBe("en")
    expect(localeFromPathname("/zh/docs/typo", LANGUAGES, "zh")).toBe("zh")
  })

  it("falls back when the first segment is not a locale", () => {
    expect(localeFromPathname("/docs/typo", LANGUAGES, "zh")).toBe("zh")
    expect(localeFromPathname("/fr/docs", LANGUAGES, "zh")).toBe("zh")
  })

  it("falls back at the site root", () => {
    expect(localeFromPathname("/", LANGUAGES, "zh")).toBe("zh")
    expect(localeFromPathname("", LANGUAGES, "zh")).toBe("zh")
  })

  it("tolerates duplicate and trailing slashes", () => {
    expect(localeFromPathname("//en//docs/", LANGUAGES, "zh")).toBe("en")
  })

  it("does not match a locale that only appears deeper in the path", () => {
    expect(localeFromPathname("/docs/en/typo", LANGUAGES, "zh")).toBe("zh")
  })
})
