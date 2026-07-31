import type { Locale } from "@web/lib/locale"

interface OgCardProps {
  eyebrow: string
  title: string
  locale: Locale
  /** Domain shown in the footer; blank in preview, real at capture time. */
  origin: string
}

/**
 * The 1200×630 share card, rendered as a page and photographed by
 * `web/scripts/capture-og.mjs`.
 *
 * A static export has no `ImageResponse` runtime, so share images are captured
 * ahead of time rather than generated per request. Rendering them from the same
 * tokens and the same typeface as the site means the card cannot drift away from
 * the page it represents — which is the usual failure of hand-made OG images.
 */
export function OgCard({ eyebrow, title, locale, origin }: OgCardProps) {
  return (
    <div
      data-testid="og-card"
      lang={locale === "zh" ? "zh-Hans" : "en"}
      className="flex h-[630px] w-[1200px] flex-col justify-between bg-paper px-20 py-16"
    >
      <div className="flex items-center justify-between">
        <p className="font-mono text-lg uppercase tracking-[0.2em] text-muted">{eyebrow}</p>
        <p className="font-mono text-lg tracking-tight text-ink">Cognia</p>
      </div>

      <h1 className="max-w-[900px] text-balance text-[68px] font-medium leading-[1.06] tracking-tight text-ink">
        {title}
      </h1>

      <div className="flex items-end justify-between border-t border-hairline pt-8">
        <p className="font-mono text-base text-muted">{origin}</p>
        <div aria-hidden className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-action" />
          <span className="h-px w-24 bg-hairline-strong" />
          <span className="size-2 rounded-full bg-approval" />
        </div>
      </div>
    </div>
  )
}
