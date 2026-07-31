import type { MetadataRoute } from "next"
import { LOCALES, ROUTES, alternateLanguages, localePath } from "@web/lib/locale"
import { absoluteUrl } from "@web/lib/site"

/**
 * Static sitemap over the published routes (ADR-0092 §4).
 *
 * The route list lives in `lib/locale.ts` rather than being discovered from the
 * filesystem: a static export cannot enumerate its own pages at build time, and
 * a hand-kept list that also drives the `hreflang` alternates is at least
 * consistently wrong or consistently right.
 */
// A static export has no request-time runtime, so the metadata routes must be
// declared static explicitly; without this the build fails while collecting
// page data rather than emitting a file.
export const dynamic = "force-static"

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.flatMap((route) => {
    const alternates = alternateLanguages(route)
    return LOCALES.map((locale) => ({
      url: absoluteUrl(localePath(locale, route)),
      changeFrequency: "weekly" as const,
      priority: route === "/" ? 1 : 0.7,
      alternates: {
        languages: Object.fromEntries(
          Object.entries(alternates).map(([tag, path]) => [tag, absoluteUrl(path)])
        ),
      },
    }))
  })
}
