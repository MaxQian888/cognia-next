import type { MetadataRoute } from "next"

import { absoluteUrl } from "@/lib/site"

// Static export (D8): emitted once at build time as `out/robots.txt`.
export const dynamic = "force-static"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // The Markdown twins duplicate every page verbatim; indexing both
        // sides splits ranking signals between them. They stay fetchable —
        // this only asks crawlers not to index them.
        disallow: ["/md/"],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  }
}
