import { ProductVideo } from "@web/components/product-video"
import { Reveal } from "@web/components/reveal"
import { format } from "@web/content"
import type { FilmCopy, FootageCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import type { ProductVideo as ProductVideoAsset } from "@web/lib/product-videos"

interface TaskFilmProps {
  copy: FilmCopy
  footage: FootageCopy
  locale: Locale
  video: ProductVideoAsset
}

/**
 * The product film (ADR-0092, product footage amendment), as the opening of
 * the signature task section.
 *
 * It used to be a section of its own, right above this one, with a heading
 * that said the same thing as this section's: two neighbouring sections told
 * one task twice. Now the section tells it once, two ways — the film to watch
 * first, the reader-paced steps under it.
 *
 * The film never autoplays and carries a caption track in the page's
 * language, so it asks for nothing until the reader asks for it.
 */
export function TaskFilm({ copy, footage, locale, video }: TaskFilmProps) {
  return (
    <div
      data-slot="task-film"
      className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12"
    >
      <div className="lg:pt-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">
          {format(copy.label, { seconds: Math.round(video.durationS) })}
        </p>
        <p className="mt-4 leading-relaxed text-ink">{copy.lead}</p>
      </div>
      <Reveal variant="scale" className="min-w-0">
        <ProductVideo
          mode="film"
          video={video}
          label={copy.videoLabel}
          note={footage.recordingNote}
          playLabel={copy.playLabel}
          captionsLang={locale === "zh" ? "zh-CN" : "en"}
          captionsLabel={copy.captionsLabel}
        />
      </Reveal>
    </div>
  )
}
