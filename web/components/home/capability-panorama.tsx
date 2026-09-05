"use client"

import { useInView, useReducedMotion } from "motion/react"
import { useRef } from "react"

import { Glyph } from "@web/components/glyph"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import { NumberTicker } from "@web/components/ui/number-ticker"
import type { CommonCopy, PanoramaCopy } from "@web/content/types"
import { INVENTORY_KEYS, inventoryFigure, type Evidence } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface CapabilityPanoramaProps {
  copy: PanoramaCopy
  common: CommonCopy
  evidence: Evidence
  locale: Locale
  docsOrigin: string
  index?: number
}

/** Stagger between one lane's marks drawing themselves, in milliseconds. */
export const GLYPH_STEP_MS = 90

/**
 * "The whole instrument." Two things a feature list never gives a reader:
 * figures counted from the repository at build time, and every subsystem
 * placed on one of four lanes that follow the page's spine (work, remember,
 * reach, control).
 *
 * The figures tick up once they are on screen, the way the trust section's
 * do. The marks draw their stroke when the lanes arrive, one after another
 * within a lane, so the grid reads as an inventory being laid out rather than
 * a slab of icons. Reduced motion renders every mark complete and every figure
 * at its value.
 *
 * Nothing here is a KPI. A zero from the counter means the count did not run
 * and is shown as a dash, never as a confident nought.
 */
export function CapabilityPanorama({
  copy,
  common,
  evidence,
  locale,
  docsOrigin,
  index,
}: CapabilityPanoramaProps) {
  const reduced = useReducedMotion() ?? false
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.15 })
  const draw = inView && !reduced
  const numberLocale = locale === "zh" ? "zh-CN" : "en-US"

  return (
    <Section id="system" tone="surface" className="paper-grain">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <div className="mt-14">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">
          {copy.figuresLabel}
        </p>
        <dl
          data-slot="inventory"
          // Seven cells on two and four columns leave one open track, which
          // would show the hairline ground as a grey slab. The last cell
          // spans it closed until the grid is one row of seven.
          className="mt-4 grid grid-cols-2 gap-px border-y border-hairline bg-hairline md:grid-cols-4 xl:grid-cols-7 [&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1"
        >
          {INVENTORY_KEYS.map((key) => {
            const figure = inventoryFigure(evidence.inventory, key)
            return (
              <div
                key={key}
                data-figure={key}
                className="trace flex flex-col gap-2 bg-surface px-4 py-5"
              >
                <dt className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  {copy.figures[key]}
                </dt>
                <dd className="text-3xl font-medium tabular-nums tracking-tight text-ink md:text-4xl">
                  {figure === null ? (
                    <span>&mdash;</span>
                  ) : (
                    <NumberTicker value={figure} locale={numberLocale} />
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
        <p className="mt-3 font-mono text-xs text-muted">{copy.figuresNote}</p>
      </div>

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
                            label: common.learnMore,
                            route: item.route,
                            docsPath: item.docsPath,
                          }}
                          locale={locale}
                          docsOrigin={docsOrigin}
                          className="mt-1 inline-flex w-fit items-center gap-1 font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4 transition-colors group-hover:decoration-ink"
                        >
                          {common.learnMore}
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
