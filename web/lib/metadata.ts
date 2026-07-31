import type { Metadata } from "next"
import type { RouteMeta } from "@web/content/types"
import { HTML_LANG, type Locale, alternateLanguages, localePath } from "./locale"
import { absoluteUrl } from "./site"

/**
 * Per-page metadata (ADR-0092 §2, §4).
 *
 * A static export has no request origin, so canonical and OpenGraph URLs are
 * absolute against the configured site URL. `hreflang` alternates are derived
 * from the route rather than written per page — a page that advertises an
 * alternate it does not emit is worse than one with none.
 */
export function buildMetadata(locale: Locale, route: string, meta: RouteMeta): Metadata {
  const alternates = alternateLanguages(route)
  const canonical = localePath(locale, route)

  return {
    title: meta.title,
    description: meta.description,
    alternates: {
      canonical,
      languages: alternates,
    },
    openGraph: {
      type: "website",
      siteName: "Cognia",
      locale: HTML_LANG[locale],
      title: meta.title,
      description: meta.description,
      url: absoluteUrl(canonical),
      images: [{ url: ogImagePath(locale, route), width: 1200, height: 630, alt: meta.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: [ogImagePath(locale, route)],
    },
  }
}

/**
 * Path of the pre-generated OpenGraph image for a route. A static export has no
 * `ImageResponse` runtime, so these are produced ahead of time by the capture
 * pipeline and shipped as files.
 */
export function ogImagePath(locale: Locale, route: string): string {
  const slug = route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-")
  return `/og/${slug}-${locale}.png`
}
