import type { MetadataRoute } from "next"

import { localeAlternates } from "@/lib/alternates"
import { getDocsLastModified } from "@/lib/last-modified"
import { source } from "@/lib/source"

// Static export (D8): emitted once at build time as `out/sitemap.xml`.
export const dynamic = "force-static"

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getLanguages().flatMap(({ language, pages }) =>
    pages.map((page) => {
      const languages = localeAlternates(page.slugs)
      const lastModified = getDocsLastModified(page.path)

      return {
        url: languages[language],
        ...(lastModified ? { lastModified: new Date(lastModified) } : {}),
        // The locale index is the entry point; deeper pages are equal to each
        // other, so a flat priority beats inventing a depth heuristic.
        priority: page.slugs.length === 0 ? 1 : 0.7,
        alternates: { languages },
      }
    })
  )
}
