import { ProductStage } from "@web/components/product-stage"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import type { DesktopCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface DesktopSectionProps {
  copy: DesktopCopy
  locale: Locale
}

/**
 * "A workspace that stays close to the work." (spec §4.4)
 *
 * Large light negative space and one macro crop of the real shell — no device
 * mock-up, no floating laptop. Every capability listed is one that ships; the
 * section argues for installing the application, so an aspirational entry here
 * would be the most expensive kind of overclaim.
 */
export function DesktopSection({ copy, locale }: DesktopSectionProps) {
  return (
    <Section tone="surface">
      <SectionHeading title={copy.title} subtitle={copy.subtitle} />

      <div className="mt-16 grid gap-14 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-20">
        <ul className="flex flex-col">
          {copy.capabilities.map((capability) => (
            <li
              key={capability.label}
              className="border-t border-hairline py-5 first:border-t-0 first:pt-0"
            >
              <p className="font-mono text-xs uppercase tracking-widest text-ink">
                {capability.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{capability.body}</p>
            </li>
          ))}
        </ul>

        <Reveal variant="scale">
          <ProductStage section="desktop" locale={locale} alt={copy.stageAlt} />
        </Reveal>
      </div>
    </Section>
  )
}
