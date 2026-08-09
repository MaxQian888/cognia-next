import { ProductStage } from "@web/components/product-stage"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import type { DesktopCopy, TerminalCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { DesktopTerminal } from "./desktop-terminal"

interface DesktopSectionProps {
  copy: DesktopCopy
  terminalCopy?: TerminalCopy
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
export function DesktopSection({ copy, terminalCopy, locale }: DesktopSectionProps) {
  return (
    <Section id="desktop" tone="surface" density="tight">
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.subtitle} />

      <div className="mt-16 border-y border-hairline">
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <ul className="flex flex-col border-b border-hairline py-6 lg:border-b-0 lg:border-r lg:pr-8">
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

          <Reveal variant="scale" className="min-w-0 py-6 lg:pl-10">
            <ProductStage section="desktop" locale={locale} alt={copy.stageAlt} />
          </Reveal>
        </div>

        {terminalCopy ? (
          <div className="border-t border-hairline bg-graphite py-6 md:px-6">
            <DesktopTerminal copy={terminalCopy} />
          </div>
        ) : null}
      </div>
    </Section>
  )
}
