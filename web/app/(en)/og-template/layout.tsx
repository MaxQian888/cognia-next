import type { Metadata } from "next"
import type { ReactNode } from "react"

// A capture surface, not a page: keep it out of search results. The sitemap
// never lists it either — `lib/locale.ts` enumerates published routes only.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "OG template",
}

export default function OgTemplateLayout({ children }: { children: ReactNode }) {
  return children
}
