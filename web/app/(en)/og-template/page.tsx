"use client"

import { useSearchParams } from "next/navigation"
import { Suspense } from "react"
import { OgCard } from "@web/components/og-card"
import { isLocale } from "@web/lib/locale"

/**
 * The rendering surface for share images, photographed by
 * `web/scripts/capture-og.mjs`.
 *
 * One client route with query parameters rather than one static page per
 * route × locale: a static export cannot read query parameters on the server,
 * but the capture browser runs the client, so `?title=&eyebrow=&locale=` is
 * read there. Eighteen near-identical template pages would be the alternative.
 *
 * It is excluded from the sitemap (`lib/locale.ts` owns that list) and from
 * indexing, because it is a tool, not a page.
 */
function OgTemplate() {
  const params = useSearchParams()
  const localeParam = params.get("locale") ?? "en"

  return (
    <OgCard
      eyebrow={params.get("eyebrow") ?? "Cognia"}
      title={params.get("title") ?? ""}
      locale={isLocale(localeParam) ? localeParam : "en"}
      origin={params.get("origin") ?? ""}
    />
  )
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <OgTemplate />
    </Suspense>
  )
}
