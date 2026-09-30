import { ProductVideo } from "@web/components/product-video"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import type { FilmCopy, FootageCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import type { ProductVideo as ProductVideoAsset } from "@web/lib/product-videos"

interface FilmSectionProps {
  copy: FilmCopy
  footage: FootageCopy
  locale: Locale
  video: ProductVideoAsset
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
}

/**
 * The product film (ADR-0092, product footage amendment).
 *
 * Right after the hero, because it answers the hero's claim with the whole
 * task at once: the same signature task the next section breaks into steps,
 * recorded from the real application and cut on its own beats. The section
 * below stays the reader-paced, accessible version; this is the one to watch.
 *
 * The film never autoplays and carries a caption track in the page's
 * language, so it asks for nothing until the reader asks for it.
 */
export function FilmSection({ copy, footage, locale, video, index }: FilmSectionProps) {
  return (
    <Section id="film" tone="paper" density="tight">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />
      <Reveal variant="scale" className="mt-12">
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
    </Section>
  )
}
