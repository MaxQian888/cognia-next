"use client"

import { useInView, useReducedMotion } from "motion/react"
import { useRef } from "react"

import { Glyph } from "@web/components/glyph"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { CommonCopy, PanoramaCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface CapabilityPanoramaProps {
  copy: PanoramaCopy
  common: CommonCopy
  locale: Locale
  docsOrigin: string
  index?: number
}

/** Stagger between one lane's marks drawing themselves, in milliseconds. */
export const GLYPH_STEP_MS = 90

/**
 * "The whole instrument." Every subsystem placed on one of four lanes that
 * follow the product's spine (work, remember, reach, control).
 *
 * The marks draw their stroke when the lanes arrive, one after another within
 * a lane, so the grid reads as an inventory being laid out rather than a slab
 * of icons. Reduced motion renders every mark complete.
 *
 * Moved from the homepage to /product (2026-10-19), where it closes the
 * capability sections as their map. The build-time figures it used to open on
 * moved to the homepage's trust section (`InventoryFigures`), beside the other
 * evidence a reader can check.
 */
export function CapabilityPanorama({
  copy,
  common,
  locale,
  docsOrigin,
  index,
}: CapabilityPanoramaProps) {
  const reduced = useReducedMotion() ?? false
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.15 })
  const draw = inView && !reduced

  return (
    <Section id="system" tone="surface" className="paper-grain">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <div ref={ref} className="relative mt-14 border border-hairline">
        <div className="dot-field pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative grid gap-px bg-hairline md:grid-cols-2 xl:grid-cols-4">
          {copy.lanes.map((lane) => (
            <section key={lane.key} data-lane={lane.key} className="flex min-w-0 flex-col bg-paper">
              <header className="border-b border-hairline px-6 pb-5 pt-6">
                <h3 className="font-mono text-xs uppercase tracking-widest text-ink">
                  {lane.label}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{lane.claim}</p>
              </header>
              <RevealGroup as="ul" className="flex flex-1 flex-col" count={lane.items.length}>
                {lane.items.map((item, position) => (
                  <RevealItem
                    as="li"
                    key={item.name}
                    className="trace group relative flex gap-4 border-b border-hairline px-6 py-5 last:border-b-0"
                  >
                    <span className="mt-0.5 text-ink">
                      <Glyph
                        name={item.glyph}
                        size={24}
                        draw={draw}
                        delayMs={position * GLYPH_STEP_MS}
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="text-sm font-medium text-ink">{item.name}</span>
                      <span className="text-sm leading-relaxed text-muted">{item.body}</span>
                      {item.route || item.docsPath ? (
                        <SiteLink
                          target={{
                            // A route opens a page on this site, a docs path the
                            // documentation: the label says which.
                            label: item.route ? common.openPage : common.learnMore,
                            route: item.route,
                            docsPath: item.docsPath,
                          }}
                          locale={locale}
                          docsOrigin={docsOrigin}
                          className="mt-1 inline-flex w-fit items-center gap-1 font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4 transition-colors group-hover:decoration-ink"
                        >
                          {item.route ? common.openPage : common.learnMore}
                        </SiteLink>
                      ) : null}
                    </span>
                  </RevealItem>
                ))}
              </RevealGroup>
            </section>
          ))}
        </div>
      </div>
    </Section>
  )
}
