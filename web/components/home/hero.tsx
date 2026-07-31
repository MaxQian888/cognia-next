import { DownloadCta } from "@web/components/download-cta"
import { Icon, type IconName } from "@web/components/icon"
import { ProductStage } from "@web/components/product-stage"
import { Reveal } from "@web/components/reveal"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { HeroTaskTicket } from "@web/components/home/hero-task-ticket"
import type { SiteCopy } from "@web/content/types"
import type { ReleaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface HeroProps {
  locale: Locale
  copy: SiteCopy
  releaseState: ReleaseState
  docsOrigin?: string
}

/**
 * Hero (spec §4.1) — Editorial Split.
 *
 * The upper band is the bone-white brand layer; the lower band is a
 * near-full-width product stage. Deliberately *not* the conventional
 * text-left / screenshot-right arrangement, which shrinks the product to a
 * thumbnail.
 *
 * The trust rail is a structured index — four hairline-separated cells with a
 * label and a qualifying detail — rather than a row of pill badges, because a
 * badge asserts without saying anything.
 */
/**
 * One mark per trust-rail cell, by position — the rail is a fixed four, and its
 * copy carries no key to index by.
 */
const TRUST_RAIL_ICONS: IconName[] = ["source", "model", "approval", "system"]

export function Hero({ locale, copy, releaseState, docsOrigin }: HeroProps) {
  const { hero } = copy.home

  return (
    <section id="hero" className="relative border-b border-hairline bg-paper">
      {/* Vertical rhythm lines (spec §2.3): a twelve-column measure behind the
       * brand band, faint enough to read as a ruled page rather than as a grid
       * overlay. Decorative, so it is masked from assistive technology. */}
      <div
        aria-hidden
        className="rhythm-lines pointer-events-none absolute inset-x-0 top-0 hidden h-full opacity-50 md:block"
      />

      <div className="relative mx-auto max-w-shell px-5 pb-16 pt-20 md:pt-28 lg:px-8 lg:pb-20 lg:pt-32">
        {/* Two columns from `lg`. In one column the brand band left roughly
         * 45% of a 1440px viewport as blank paper, and the right column is
         * where the page's argument belongs: the task it is about to follow,
         * stated rather than described. */}
        <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">{hero.eyebrow}</p>

            {/* Two lines maximum on desktop (spec §3.2), which `max-w` enforces
             * more reliably than a character count. */}
            <h1 className="mt-8 max-w-4xl text-balance text-4xl font-medium leading-[1.08] tracking-tight text-ink md:text-6xl lg:text-7xl">
              {hero.title}
            </h1>

            <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted md:text-xl">
              {hero.subtitle}
            </p>

            <div className="mt-10">
              <DownloadCta
                locale={locale}
                copy={copy.common}
                state={releaseState}
                docsOrigin={docsOrigin}
              />
            </div>
          </div>

          <div className="mt-14 lg:mt-2">
            <Reveal trigger="mount" delay={0.1}>
              <HeroTaskTicket copy={hero.ticket} reconstruction={copy.reconstruction} />
            </Reveal>
          </div>
        </div>

        <RevealGroup
          as="ul"
          count={hero.trustRail.length}
          className="mt-16 grid grid-cols-2 gap-px border-t border-hairline bg-hairline md:grid-cols-4"
        >
          {hero.trustRail.map((item, index) => (
            <RevealItem key={item.label} as="li" className="bg-paper px-1 pt-5 md:px-0 md:pr-6">
              <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-ink">
                <Icon name={TRUST_RAIL_ICONS[index]} size={14} className="text-muted" />
                {item.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.detail}</p>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>

      {/* The stage runs wider than the reading column but never past the
       * viewport — spec §7 allows the product to break the measure, not the
       * page to scroll sideways. */}
      <div className="relative mx-auto max-w-[1720px] px-5 pb-20 lg:px-8">
        {/* `mount`, not `view`: the stage's top sits at the fold, so an in-view
         * trigger would hold the page's largest visual at opacity 0 for anyone
         * who reads the first screen without scrolling. */}
        <Reveal variant="scale" trigger="mount">
          <ProductStage
            section="hero"
            locale={locale}
            alt={hero.stageAlt}
            caption={hero.stageCaption}
          />
        </Reveal>
      </div>
    </section>
  )
}
