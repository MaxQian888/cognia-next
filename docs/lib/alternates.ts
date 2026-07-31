/**
 * Cross-locale link resolution, shared by the sitemap and each page's
 * `<link rel="alternate" hreflang>` tags.
 *
 * The two locales are not mirror images — a handful of pages exist only in
 * English — so alternates are resolved against the real page set instead of
 * being derived by string substitution. Advertising an hreflang that 404s is
 * worse than advertising none.
 */

import { i18n } from "@/lib/i18n"
import { source } from "@/lib/source"
import { absoluteUrl } from "@/lib/site"

/** Absolute URL per locale, for the locales that actually have this page. */
export function localeAlternates(slugs: string[] | undefined): Record<string, string> {
  const entries: [string, string][] = []

  for (const lang of i18n.languages) {
    const page = source.getPage(slugs, lang)
    if (page) entries.push([lang, absoluteUrl(page.url)])
  }

  return Object.fromEntries(entries)
}

/**
 * `alternates` for Next's Metadata. `x-default` points at the default locale
 * when it has the page, so search engines have an unambiguous fallback.
 */
export function metadataAlternates(canonical: string, slugs: string[] | undefined) {
  const languages = localeAlternates(slugs)
  const fallback = languages[i18n.defaultLanguage]

  return {
    canonical,
    languages: fallback ? { ...languages, "x-default": fallback } : languages,
  }
}
