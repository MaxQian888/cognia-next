import { DesktopReconstruction } from "@web/components/product/desktop-reconstruction"
import { WorkbenchReconstruction } from "@web/components/product/workbench-reconstruction"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { findShotPair } from "@web/lib/product-assets"

/** The capture matrix's sections (`web/scripts/capture-product.mjs`). */
export type ProductSection = "hero" | "workbench" | "desktop"

interface ProductStageProps {
  section: ProductSection
  locale: Locale
  alt: string
  caption?: string
  /** Renders the frame on the dark execution substrate instead of paper. */
  tone?: "surface" | "stage"
  className?: string
}

/**
 * A large product visual (ADR-0092 §8, amended).
 *
 * Preference order, highest first:
 *
 *  1. **A real capture.** When `product-shots.json` holds *both* themes for the
 *     section, the screenshots win — nothing represents the product as well as
 *     the product. Both are emitted and toggled by the `dark` class rather than
 *     `prefers-color-scheme`, because the theme control can override the system
 *     preference and a media query would ignore that choice.
 *  2. **A DOM reconstruction**, labelled as one. The capture matrix needs a
 *     product-side seed seam that does not exist yet, and an empty frame carrying
 *     a sentence of alt text was the largest visual on the page. A reconstruction
 *     that says it is a reconstruction is honest; the thing ADR-0092 §8 forbids
 *     is an unlabelled mock-up passed off as a photograph of the application,
 *     which the frame's permanent marker prevents.
 *
 * A half-captured pair is refused rather than shown: a reader who saw the light
 * capture in dark mode would conclude the product looks like that.
 */
export function ProductStage({
  section,
  locale,
  alt,
  caption,
  tone = "surface",
  className,
}: ProductStageProps) {
  const pair = findShotPair(section, locale)

  if (pair) {
    const frame =
      tone === "stage" ? "border-on-stage-hairline bg-stage" : "border-hairline bg-surface"
    return (
      <figure className={className}>
        <div className={`overflow-hidden rounded-stage border ${frame}`}>
          {/* Raw <img> on purpose: `next.config.ts` sets `images.unoptimized`
           * because a static export has no image optimiser, so `next/image`
           * would add a wrapper and a client component for no benefit. Both
           * sources are pre-encoded PNG at their final size. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pair.light.src}
            width={pair.light.width}
            height={pair.light.height}
            alt={alt}
            className="block w-full dark:hidden"
            loading="lazy"
            decoding="async"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pair.dark.src}
            width={pair.dark.width}
            height={pair.dark.height}
            alt={alt}
            className="hidden w-full dark:block"
            loading="lazy"
            decoding="async"
          />
        </div>
        {caption ? (
          <figcaption className="mt-3 font-mono text-xs text-muted">{caption}</figcaption>
        ) : null}
      </figure>
    )
  }

  const copy = getCopy(locale).reconstruction

  return (
    <figure className={className} data-placeholder="product-stage">
      {/*
       * One image with one description, exactly as the capture it stands in for
       * would be.
       *
       * The depicted chrome — rail entries, tab strips, a status line — is
       * `aria-hidden` on purpose. Those are pictures of controls, not controls:
       * announcing "Chat, Agents, Workflows" as content would put a dozen fake
       * affordances into the accessibility tree, and a reader who tried to
       * activate one would find nothing there. What a screenshot gives a screen
       * reader is its alt text, so that is what this gives.
       *
       * The signature demo's step artifacts are the deliberate opposite: they
       * are real content, kept in the tree and translated, which is the reason
       * ADR-0092 §8 has them as DOM in the first place.
       */}
      <div role="img" aria-label={alt}>
        <div aria-hidden>
          {section === "desktop" ? (
            <DesktopReconstruction copy={copy} />
          ) : (
            <WorkbenchReconstruction copy={copy} />
          )}
        </div>
      </div>

      <figcaption className="mt-3 flex flex-col gap-1 font-mono text-xs text-muted">
        {caption ? <span>{caption}</span> : null}
        <span>{copy.note}</span>
      </figcaption>
    </figure>
  )
}
