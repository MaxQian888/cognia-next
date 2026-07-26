import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_LOCALE,
  HTML_LANG,
  LOCALES,
  ROUTES,
  alternateLanguages,
  isLocale,
  localePath,
  otherLocale,
} from "./locale"

describe("localePath", () => {
  it("serves English from the site root, unprefixed", () => {
    expect(localePath("en", "/")).toBe("/")
    expect(localePath("en", "/trust")).toBe("/trust")
    expect(localePath("en", "/use-cases/research")).toBe("/use-cases/research")
  })

  it("prefixes Chinese", () => {
    expect(localePath("zh", "/")).toBe("/zh")
    expect(localePath("zh", "/trust")).toBe("/zh/trust")
    expect(localePath("zh", "/use-cases/research")).toBe("/zh/use-cases/research")
  })

  it("never emits an /en prefix", () => {
    for (const route of ROUTES) {
      expect(localePath("en", route).startsWith("/en")).toBe(false)
    }
  })

  it("drops a trailing slash so canonical paths have one form", () => {
    expect(localePath("en", "/trust/")).toBe("/trust")
    expect(localePath("zh", "/trust/")).toBe("/zh/trust")
  })
})

describe("alternateLanguages", () => {
  it("points x-default at English", () => {
    expect(alternateLanguages("/trust")["x-default"]).toBe("/trust")
  })

  it("advertises both locales for every published route", () => {
    for (const route of ROUTES) {
      const alternates = alternateLanguages(route)
      expect(alternates.en).toBe(localePath("en", route))
      expect(alternates["zh-Hans"]).toBe(localePath("zh", route))
    }
  })
})

/**
 * `ROUTES` drives the sitemap and both locales' `hreflang` alternates, so a
 * route listed here without a page behind it publishes a 404 to search engines
 * — and a page with no entry here is invisible to them. Both directions are
 * checked against the filesystem rather than trusted.
 */
describe("ROUTES matches the routes that actually exist", () => {
  const appDir = join(__dirname, "..", "app")

  function pageFile(locale: "en" | "zh", route: string): string {
    const group = locale === "en" ? "(en)" : "(zh)"
    const prefix = locale === "en" ? "" : "zh"
    const segments = route === "/" ? [] : route.replace(/^\//, "").split("/")
    return join(appDir, group, prefix, ...segments, "page.tsx")
  }

  it("has a page file for every published route in both locales", () => {
    const missing = ROUTES.flatMap((route) =>
      LOCALES.filter((locale) => !existsSync(pageFile(locale, route))).map(
        (locale) => `${locale} ${route}`
      )
    )
    expect(missing).toEqual([])
  })

  it("never generates an /en prefix directory", () => {
    expect(existsSync(join(appDir, "(en)", "en"))).toBe(false)
  })
})

describe("locale helpers", () => {
  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en")
  })

  it("round-trips between the two locales", () => {
    expect(otherLocale("en")).toBe("zh")
    expect(otherLocale("zh")).toBe("en")
  })

  it("recognises only the supported locales", () => {
    expect(isLocale("en")).toBe(true)
    expect(isLocale("zh")).toBe(true)
    expect(isLocale("zh-CN")).toBe(false)
    expect(isLocale("fr")).toBe(false)
  })

  it("maps every locale to a BCP-47 tag", () => {
    for (const locale of LOCALES) {
      expect(HTML_LANG[locale]).toBeTruthy()
    }
  })
})
