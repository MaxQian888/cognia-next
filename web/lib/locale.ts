/**
 * Locale routing for the marketing site (ADR-0092 §4).
 *
 * English is served from the site root — `/`, `/trust`, `/use-cases/research` —
 * so the homepage returns content instead of redirecting. Chinese is prefixed:
 * `/zh`, `/zh/trust`. `/en/*` is never generated; `public/_redirects` 301s it to
 * the unprefixed form so the default locale has exactly one canonical URL.
 *
 * Every path in this module is the *canonical* path. `hreflang` alternates are
 * derived from it rather than hand-written per page, because a page that
 * advertises an alternate it does not emit is worse than one with none.
 */

export const LOCALES = ["en", "zh"] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

/** BCP-47 tags for `<html lang>` and `hreflang`. */
export const HTML_LANG: Record<Locale, string> = {
  en: "en",
  zh: "zh-Hans",
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

/**
 * Every route the site publishes, without a locale prefix. Adding a page here
 * is what puts it into the sitemap and into both locales' alternates — the
 * route files themselves cannot be enumerated at build time in a static export.
 */
export const ROUTES = [
  "/",
  "/product",
  "/workflows",
  "/plugins",
  "/trust",
  "/download",
  "/use-cases/development",
  "/use-cases/research",
  "/changelog",
] as const

export type Route = (typeof ROUTES)[number]

/** Canonical path for a route in a given locale. */
export function localePath(locale: Locale, route: string): string {
  const normalized = route === "/" ? "" : route.replace(/\/+$/, "")
  if (locale === DEFAULT_LOCALE) return normalized || "/"
  return `/zh${normalized}`
}

/** The same page in the other locale — what the language switcher links to. */
export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "zh" : "en"
}

/**
 * `hreflang` map for a route. `x-default` points at English: it is the
 * canonical entry point and the locale the spec positions the site around.
 */
export function alternateLanguages(route: string): Record<string, string> {
  return {
    en: localePath("en", route),
    "zh-Hans": localePath("zh", route),
    "x-default": localePath("en", route),
  }
}
