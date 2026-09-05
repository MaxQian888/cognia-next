import { DownloadCta } from "@web/components/download-cta"
import { Icon, type IconName } from "@web/components/icon"
import { Reveal } from "@web/components/reveal"
import { formatIndex } from "@web/components/section"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { HeroTaskTicket } from "@web/components/home/hero-task-ticket"
import { HeroWorkbench } from "@web/components/home/hero-workbench"
import type { SiteCopy } from "@web/content/types"
import type { ReleaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface HeroProps {
  locale: Locale
  copy: SiteCopy
  releaseState: ReleaseState
  docsOrigin?: string
  /** One-based position on the page, rendered as the eyebrow's index tag. */
  index?: number
}

/**
 * One mark per trust-rail cell, by position. The rail is a fixed four, and its
 * copy carries no key to index by.
 */
const TRUST_RAIL_ICONS: IconName[] = ["source", "model", "approval", "system"]

/**
 * Hero (spec 4.1), on the execution stage.
 *
 * The first screen used to be the paper brand layer with the product pushed
 * below the fold. It is now the dark stage itself: the headline and the two
 * actions on the left, and on the right the workbench running the site's one
 * task, live, from the moment the page is interactive. The reader meets the
 * product doing the thing before reading a sentence about it.
 *
 * `stage-scope` is what makes this cheap. The section is written in the
 * ordinary reading vocabulary, and the scope remaps `ink`, `paper`, `muted` and
 * the hairlines onto their stage counterparts, so the button, the rail and the
 * reconstruction all render correctly here without a second variant of each.
 *
 * Under the two-line rule (spec 3.2) the display size steps with the column:
 * six of twelve tracks from `lg`, five from `xl`, and the type follows so the
 * headline holds two lines at every width from 1024 up.
 */
export function Hero({ locale, copy, releaseState, docsOrigin, index }: HeroProps) {
  const { hero } = copy.home

  return (
    <section
      id="hero"
      className="stage-scope relative overflow-hidden border-b border-hairline bg-stage"
    >
      {/* The stage's ruled ground, faded towards the edges so the workbench
       * reads as the lit part of the bench. Decorative, so hidden from
       * assistive technology. */}
      <div aria-hidden className="stage-grid pointer-events-none absolute inset-0 opacity-70" />

      <div className="relative mx-auto max-w-shell px-5 pb-14 pt-14 lg:px-8 lg:pb-16 lg:pt-20">
        <div className="grid items-start gap-12 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-6 lg:pt-4 xl:col-span-5">
            <p className="flex items-center gap-3 font-mono text-xs uppercase tracking-widest text-muted">
              {index !== undefined ? (
                <span
                  data-slot="section-index"
                  className="index-tick flex items-center gap-3 tabular-nums text-ink"
                >
                  {formatIndex(index)}
                </span>
              ) : (
                <span aria-hidden className="size-1.5 rounded-full bg-action" />
              )}
              <span>{hero.eyebrow}</span>
            </p>

            <h1 className="mt-7 text-balance text-4xl font-medium leading-[1.06] tracking-tight text-ink md:text-5xl lg:text-[2.75rem] xl:text-[3.25rem] 2xl:text-6xl">
              {hero.title}
            </h1>

            <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted md:text-xl">
              {hero.subtitle}
            </p>

            <div className="mt-9">
              <DownloadCta
                locale={locale}
                copy={copy.common}
                state={releaseState}
                docsOrigin={docsOrigin}
              />
            </div>
          </div>

          {/* `mount`, not `view`: this is the first screen, and an in-view
           * trigger would hold the page's largest visual at opacity 0 for a
           * reader who never scrolls. */}
          <Reveal variant="scale" trigger="mount" className="min-w-0 lg:col-span-6 xl:col-span-7">
            <HeroWorkbench
              copy={copy.reconstruction}
              alt={hero.stageAlt}
              caption={hero.stageCaption}
            />
          </Reveal>
        </div>

        <Reveal trigger="mount" delay={0.15} className="mt-12">
          <HeroTaskTicket copy={hero.ticket} reconstruction={copy.reconstruction} />
        </Reveal>

        <RevealGroup
          as="ul"
          count={hero.trustRail.length}
          className="mt-10 grid grid-cols-2 gap-px bg-hairline md:grid-cols-4"
        >
          {hero.trustRail.map((item, index) => (
            <RevealItem key={item.label} as="li" className="bg-paper pt-1 md:pr-6">
              <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-ink">
                <Icon name={TRUST_RAIL_ICONS[index]} size={14} className="text-muted" />
                {item.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.detail}</p>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  )
}
